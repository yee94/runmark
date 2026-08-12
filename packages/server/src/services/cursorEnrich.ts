/**
 * 将 Cursor Dashboard 用量事件 enrich 到统一 sessions / turns 表。
 * 会话归属以 Hook 上报的 session_id 为准；Usage API 仅补充 cost / token（UPDATE，不新增 turn、不改 created_at）。
 */

import type { Database } from "bun:sqlite";
import type { FileLogger } from "@agent-tracker/shared";
import {
  dequeueNextPending,
  markQueueDone,
  markQueueFailed,
  markQueueSyncing,
  requeueSessionIfNeeded,
} from "./cursorEnrichQueue";

export interface CursorUsageEventRow {
  event_id: string;
  timestamp: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd_cents: number;
  raw_json?: string | null;
}

interface HookTurnRow {
  id: string;
  createdAtSec: number;
  model: string;
}

const PROVIDER = "cursor";
const TURN_ID_PREFIX = "cursor-usage-";
/** 会话时间窗 padding（秒），覆盖长 Agent 任务发起记费与 Hook turn 完成之间的时差 */
const PAD_BEFORE_SEC = 5 * 60;
const PAD_AFTER_SEC = 5 * 60;
/**
 * 单轮对账向前回溯上限（秒）。
 * 常规只在 turn 附近合理区间对账，不依赖跨天/跨周的整段 session 订正。
 */
export const MAX_TURN_LOOKBACK_SEC = 20 * 60;

/** 对账 turn 排除历史 cursor-usage-* 账单行 */
function billableTurnClause(alias = ""): string {
  const col = alias ? `${alias}.id` : "id";
  return `${col} NOT LIKE '${TURN_ID_PREFIX}%'`;
}

/**
 * 归一化 Cursor model 名，消除 Hook 与 Usage API 的「质量档」后缀差异。
 * 只剥 xhigh/high/medium/low/max，保留 fast（composer-2.5-fast ≠ composer-2.5）。
 * 例：grok-4.5-fast-xhigh ↔ grok-4.5-fast-high → grok-4.5-fast
 */
export function normalizeCursorModel(model: string): string {
  let s = String(model || "").toLowerCase().replace(/_/g, "-").trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/-(xhigh|high|medium|low|max)$/i, "");
  }
  return s;
}

/** Hook model 与 Usage model 是否可对账（精确或归一化后相等） */
export function modelsCompatible(a: string, b: string): boolean {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  return normalizeCursorModel(left) === normalizeCursorModel(right);
}

/** 从 Usage raw_json 解析 conversationId（Cursor 账单归属会话） */
export function conversationIdFromRaw(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const id = parsed.conversationId ?? parsed.conversation_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 每个 turn 的合理对账时间窗（秒）。
 * 不取 session 起止的整段跨度，避免长开会话一次扫进几天/几周的无主账单。
 */
function turnTimeWindowsSec(
  turns: HookTurnRow[],
  sessionStartSec: number,
): Array<{ startSec: number; endSec: number }> {
  return turns.map((turn, i) => {
    const upper = turn.createdAtSec;
    const prevLower = i === 0 ? sessionStartSec - PAD_BEFORE_SEC : turns[i - 1]!.createdAtSec;
    const lower = Math.max(prevLower, upper - MAX_TURN_LOOKBACK_SEC);
    return { startSec: lower, endSec: upper };
  });
}

/** Hook 产生的 turn（按 created_at 正序，含 Unix 时间戳和 model） */
function hookTurns(db: Database, sessionId: string): HookTurnRow[] {
  const rows = db.query(`
    SELECT id, created_at, model FROM turns
    WHERE session_id = $id
      AND provider = $provider
      AND ${billableTurnClause()}
    ORDER BY created_at ASC
  `).all({ $id: sessionId, $provider: PROVIDER }) as Array<{ id: string; created_at: string; model: string }>;

  return rows
    .map((r) => ({ id: r.id, createdAtSec: Math.floor(new Date(r.created_at).getTime() / 1000), model: r.model }))
    .filter((r) => Number.isFinite(r.createdAtSec));
}

/**
 * 按时间区间将 usage event 归属到 turn（一对多）：
 * turn[i] 承接 (turn[i-1], turn[i]] 内同 model 的账单；最后一轮之后、下一轮 turn 未到时暂挂起。
 * Usage API 常在请求发起时记费，Hook turn 在回复结束后才出现，故允许 event 早于 turn。
 */
function resolveTurnForEvent(
  event: CursorUsageEventRow,
  turns: HookTurnRow[],
  sessionStartSec: number,
): HookTurnRow | null {
  const matching = turns.filter((t) => modelsCompatible(t.model, event.model));
  if (!matching.length) return null;

  const ts = event.timestamp;
  for (let i = 0; i < matching.length; i++) {
    const upper = matching[i]!.createdAtSec;
    const prevLower = i === 0 ? sessionStartSec - PAD_BEFORE_SEC : matching[i - 1]!.createdAtSec;
    const lower = Math.max(prevLower, upper - MAX_TURN_LOOKBACK_SEC);
    if (ts > lower && ts <= upper) return matching[i]!;
  }

  return null;
}

/** 按 turns 重算 session 聚合字段（不含历史 cursor-usage-* 行） */
export function recalculateSessionTotals(db: Database, sessionId: string): void {
  db.query(`
    UPDATE sessions SET
      request_count = (
        SELECT COUNT(*) FROM turns WHERE session_id = $id AND ${billableTurnClause()}
      ),
      total_input_tokens = (
        SELECT COALESCE(SUM(input_tokens), 0) FROM turns WHERE session_id = $id AND ${billableTurnClause()}
      ),
      total_output_tokens = (
        SELECT COALESCE(SUM(output_tokens), 0) FROM turns WHERE session_id = $id AND ${billableTurnClause()}
      ),
      total_tokens = (
        SELECT COALESCE(SUM(total_tokens), 0) FROM turns WHERE session_id = $id AND ${billableTurnClause()}
      ),
      total_cost_usd = (
        SELECT COALESCE(SUM(cost_usd), 0) FROM turns WHERE session_id = $id AND ${billableTurnClause()}
      ),
      model = COALESCE(
        (SELECT model FROM turns WHERE session_id = $id AND ${billableTurnClause()} ORDER BY created_at DESC LIMIT 1),
        model
      )
    WHERE id = $id
  `).run({ $id: sessionId });
}

/** 将单条 usage 累加到已有 turn（仅 cost / token，不改 created_at） */
function applyUsageToTurn(
  db: Database,
  turnId: string,
  event: CursorUsageEventRow,
): void {
  const inputTokens = event.input_tokens ?? 0;
  const outputTokens = event.output_tokens ?? 0;
  const cacheRead = event.cache_read_tokens ?? 0;
  const cacheWrite = event.cache_write_tokens ?? 0;
  const reasoning = event.reasoning_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite + reasoning;
  const costUsd = (event.cost_usd_cents ?? 0) / 100;

  db.query(`
    UPDATE turns SET
      model = CASE WHEN $model != '' AND $model != 'unknown' THEN $model ELSE model END,
      input_tokens = input_tokens + $input_tokens,
      output_tokens = output_tokens + $output_tokens,
      cache_read_tokens = cache_read_tokens + $cache_read_tokens,
      cache_write_tokens = cache_write_tokens + $cache_write_tokens,
      reasoning_tokens = reasoning_tokens + $reasoning_tokens,
      total_tokens = total_tokens + $total_tokens,
      cost_usd = cost_usd + $cost_usd
    WHERE id = $id
  `).run({
    $id: turnId,
    $model: event.model || "unknown",
    $input_tokens: inputTokens,
    $output_tokens: outputTokens,
    $cache_read_tokens: cacheRead,
    $cache_write_tokens: cacheWrite,
    $reasoning_tokens: reasoning,
    $total_tokens: totalTokens,
    $cost_usd: costUsd,
  });
}

/**
 * 乐观锁：原子标记 usage event 已 enrich。
 * 返回 true 表示成功抢占（changes=1），false 表示已被其他进程抢占。
 */
function claimUsageEvent(db: Database, eventId: string): boolean {
  const result = db.query(`
    UPDATE cursor_usage_events SET enriched_at = $at
    WHERE event_id = $event_id AND enriched_at IS NULL
  `).run({
    $at: new Date().toISOString(),
    $event_id: eventId,
  });
  return result.changes === 1;
}

/** 单条 usage 事件按时间区间匹配到当前会话的 turn（一对多，排重靠 enriched_at） */
export function enrichUsageEventForSession(
  db: Database,
  event: CursorUsageEventRow,
  sessionId: string,
  turns: HookTurnRow[],
  sessionStartSec: number,
): boolean {
  const session = db.query(`
    SELECT 1 AS ok FROM sessions WHERE id = $id AND agent = 'cursor'
  `).get({ $id: sessionId });
  if (!session) return false;

  const turn = resolveTurnForEvent(event, turns, sessionStartSec);
  if (!turn) return false;

  // 乐观锁：先抢占 event，再写 turn
  if (!claimUsageEvent(db, event.event_id)) return false;
  applyUsageToTurn(db, turn.id, event);
  return true;
}

/** 拉取尚未 enrich、且 conversationId 归属本会话的账单 */
function loadCidEvents(db: Database, sessionId: string): CursorUsageEventRow[] {
  return db.query(`
    SELECT event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, raw_json
    FROM cursor_usage_events
    WHERE enriched_at IS NULL
      AND (
        json_extract(raw_json, '$.conversationId') = $session_id
        OR json_extract(raw_json, '$.conversation_id') = $session_id
      )
    ORDER BY timestamp ASC
  `).all({ $session_id: sessionId }) as CursorUsageEventRow[];
}

/** 拉取 turn 合理时间窗内、尚未 enrich 的账单（兼容无 conversationId 的旧事件） */
function loadEventsInWindow(
  db: Database,
  startSec: number,
  endSec: number,
): CursorUsageEventRow[] {
  return db.query(`
    SELECT event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, raw_json
    FROM cursor_usage_events
    WHERE enriched_at IS NULL
      AND timestamp >= $start_sec AND timestamp <= $end_sec
    ORDER BY timestamp ASC
  `).all({ $start_sec: startSec, $end_sec: endSec }) as CursorUsageEventRow[];
}

/** 按 Hook 会话归属补充 cost：event-driven 一对多，排重靠 cursor_usage_events.enriched_at */
export function enrichSessionUsage(
  db: Database,
  sessionId: string,
  logger?: FileLogger,
): number {
  const turns = hookTurns(db, sessionId);
  if (!turns.length) return 0;

  const sessionRow = db.query(`
    SELECT started_at FROM sessions WHERE id = $id AND agent = 'cursor'
  `).get({ $id: sessionId }) as { started_at: string } | undefined;
  if (!sessionRow?.started_at) return 0;

  const sessionStartSec = Math.floor(new Date(sessionRow.started_at).getTime() / 1000);
  if (!Number.isFinite(sessionStartSec)) return 0;

  // 只扫各 turn 附近合理区间 + 本会话 conversationId，不扫整段 session 跨度
  const byEventId = new Map<string, CursorUsageEventRow>();
  for (const event of loadCidEvents(db, sessionId)) {
    byEventId.set(event.event_id, event);
  }
  for (const win of turnTimeWindowsSec(turns, sessionStartSec)) {
    for (const event of loadEventsInWindow(db, win.startSec, win.endSec)) {
      if (!byEventId.has(event.event_id)) byEventId.set(event.event_id, event);
    }
  }

  const events = [...byEventId.values()].sort((a, b) => a.timestamp - b.timestamp);

  // 若本会话已有带 conversationId 的账单，只吃这些（避免窗内无 cid 的别人账单误入）
  const withCid = events.filter((event) => conversationIdFromRaw(event.raw_json) === sessionId);
  const candidates = withCid.length
    ? withCid
    : events.filter((event) => !conversationIdFromRaw(event.raw_json));

  // event-driven：每条 usage 独立 claim，可累加到同一 turn；enriched_at 保证不重复计入。
  let enriched = 0;

  for (const event of candidates) {
    const turn = resolveTurnForEvent(event, turns, sessionStartSec);
    if (!turn) continue;

    try {
      if (!claimUsageEvent(db, event.event_id)) continue;
      applyUsageToTurn(db, turn.id, event);
      enriched++;
    } catch (err) {
      logger?.error(`Cursor enrich failed for event ${event.event_id} → ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (enriched > 0) {
    recalculateSessionTotals(db, sessionId);
    logger?.info(`Cursor session enriched: ${sessionId}, events=${enriched}`);
  }

  return enriched;
}

/** 串行处理对账队列（FIFO，可选限定会话子集） */
export function processEnrichQueue(
  db: Database,
  logger?: FileLogger,
  sessionFilter?: Set<string>,
): number {
  let total = 0;

  while (true) {
    const next = dequeueNextPending(db);
    if (!next) break;
    if (sessionFilter && !sessionFilter.has(next.session_id)) {
      markQueueDone(db, next.session_id);
      continue;
    }

    markQueueSyncing(db, next.session_id);
    try {
      total += enrichSessionUsage(db, next.session_id, logger);
      markQueueDone(db, next.session_id);
      requeueSessionIfNeeded(db, next.session_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markQueueFailed(db, next.session_id, message);
      logger?.error(`Cursor enrich queue failed for ${next.session_id}: ${message}`);
      break;
    }
  }

  return total;
}
