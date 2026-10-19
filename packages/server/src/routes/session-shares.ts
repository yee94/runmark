import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { withCostCny, withTotalCostCny } from "../services/currency";

/** 人类可复制 share 链接 HMAC 前缀（与 apiKey 组合，不入库） */
const SHARE_LINK_HMAC_PREFIX = "agent-tracker-session-share-link-v1:";

/** 允许的分享有效期 */
const SHARE_DURATIONS = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

export type ShareDuration = keyof typeof SHARE_DURATIONS;

const SEARCH_SNIPPET_MAX = 500;
const MESSAGE_CONTENT_MAX = 16 * 1024;
const TOOL_ARGS_MAX = 8 * 1024;
const TOOL_OUTPUT_MAX = 16 * 1024;
const SEARCH_LIMIT_MAX = 50;
const LIST_LIMIT_MAX = 100;
const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const TRACE_TYPES = [
  "user",
  "reasoning",
  "assistant",
  "turn",
  "tool",
  "abort",
  "error",
  "subagent",
] as const;
type TraceType = (typeof TRACE_TYPES)[number];
const TRACE_TYPE_SET = new Set<string>(TRACE_TYPES);

/** 公开分享 session 字段白名单（排除环境/身份/导航类敏感字段） */
type SessionRow = {
  id: string;
  title?: string | null;
  AISummary?: string | null;
  agent?: string | null;
  provider?: string | null;
  model?: string | null;
  started_at: string;
  ended_at?: string | null;
  request_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cost_usd?: number;
};

type ShareRow = {
  token_hash: string;
  session_id: string;
  created_at: string;
  expires_at: string;
  trace_types: string;
  node_key: string | null;
  child_session_id: string | null;
};

/** 将 sessions.model（逗号分隔）拆成展示用 models[] */
function splitStoredModels(value: string | null | undefined): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(value || "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(name);
  }
  return parts;
}

function maxIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function minIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

/** 单 session 序列化：显式白名单，不含 children/fork/环境身份字段 */
function serializeShareSession(db: Database, row: SessionRow) {
  const lastMsg = db
    .query<{ last_at: string | null }, { $id: string }>(
      "SELECT MAX(created_at) as last_at FROM messages WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const lastTurn = db
    .query<{ last_at: string | null }, { $id: string }>(
      "SELECT MAX(created_at) as last_at FROM turns WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const firstMsg = db
    .query<{ first_at: string | null }, { $id: string }>(
      "SELECT MIN(created_at) as first_at FROM messages WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const firstTurn = db
    .query<{ first_at: string | null }, { $id: string }>(
      "SELECT MIN(created_at) as first_at FROM turns WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const models = splitStoredModels(row.model);
  const lastActivityAt = maxIsoTimestamp(row.started_at, row.ended_at, lastMsg?.last_at, lastTurn?.last_at);
  const firstActivityAt = minIsoTimestamp(firstMsg?.first_at, firstTurn?.first_at) || row.started_at;
  const durationMs = Math.max(
    0,
    new Date(lastActivityAt).getTime() - new Date(firstActivityAt).getTime(),
  );

  return {
    id: row.id,
    title: row.title ?? null,
    AISummary: row.AISummary ?? null,
    summary: (row.title && String(row.title).trim()) || row.id,
    agent: row.agent ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    models,
    started_at: row.started_at,
    ended_at: row.ended_at ?? null,
    last_activity_at: lastActivityAt,
    duration_ms: durationMs,
    request_count: row.request_count ?? 0,
    total_input_tokens: row.total_input_tokens ?? 0,
    total_output_tokens: row.total_output_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0,
    total_cost_usd: row.total_cost_usd ?? 0,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 管理 id：64 位 hex（与 token_hash 同形） */
function isShareId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function requestOrigin(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

/** 从 token_hash 生成可验证的人类 share alias（不入库，可重算） */
function signShareLinkAlias(apiKey: string, tokenHash: string): string {
  const signature = createHmac("sha256", apiKey)
    .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
    .digest("base64url");
  return `${tokenHash}.${signature}`;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** alias 形如 token_hash.signature；否则视为原始 token */
type ResolvedShareCredential =
  | { kind: "raw"; token: string; tokenHash: string }
  | { kind: "alias"; tokenHash: string; alias: string };

function resolveShareCredential(
  credential: string,
  apiKey: string,
): ResolvedShareCredential | null {
  const aliasMatch = /^([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/i.exec(credential);
  if (aliasMatch) {
    const tokenHash = aliasMatch[1].toLowerCase();
    const providedSig = aliasMatch[2];
    const expectedSig = createHmac("sha256", apiKey)
      .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
      .digest("base64url");
    if (!safeEqualString(providedSig, expectedSig)) {
      return null;
    }
    return {
      kind: "alias",
      tokenHash,
      alias: signShareLinkAlias(apiKey, tokenHash),
    };
  }
  return {
    kind: "raw",
    token: credential,
    tokenHash: hashToken(credential),
  };
}

/** 浏览器导航（Accept: text/html）时 302 到 Dashboard 分享页；curl/fetch 默认走 JSON */
function wantsHtmlRedirect(c: Context): boolean {
  const accept = c.req.header("Accept") ?? "";
  if (!/\btext\/html\b/i.test(accept)) return false;
  // 显式要 JSON 时不重定向（curl / SPA fetch 保持 JSON）
  if (/\bapplication\/json\b/i.test(accept)) {
    const htmlIdx = accept.search(/\btext\/html\b/i);
    const jsonIdx = accept.search(/\bapplication\/json\b/i);
    return htmlIdx >= 0 && htmlIdx < jsonIdx;
  }
  return true;
}

/** agent_prompt：先摘要；详情走 resources；仅一条默认 curl 落盘 */
function buildAgentPrompt(apiUrl: string, restricted = false): string {
  return [
    restricted
      ? "请先读取 Session 摘要（优先 AISummary）。需要详情时，仅使用响应 resources.trace 按 next_offset 分页读取已过滤、已脱敏的共享调用链，并用 curl -o <file> 落盘后分析。"
      : "请先读取 Session 摘要（优先 AISummary）。需要定位时先使用 resources.search；需要详情时，从响应 resources 选择 trace / messages / turns / tool_calls 链接，按 next_offset 分页读取并用 curl -o <file> 落盘后分析。",
    "",
    "---",
    "",
    `curl -sS -o runmark-session-summary.json ${JSON.stringify(apiUrl)}`,
  ].join("\n");
}

function publicShareBaseUrl(origin: string, credential: string): string {
  return `${origin}/v1/public/session-shares/${credential}`;
}

function truncateText(
  value: string | null | undefined,
  max: number,
): { text: string; truncated: boolean } {
  const text = value == null ? "" : String(value);
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw == null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseFormat(raw: string | undefined): "json" | "jsonl" | null {
  if (raw == null || raw === "" || raw === "json") return "json";
  if (raw === "jsonl") return "jsonl";
  return null;
}

function parseTraceTypes(raw: string | undefined): TraceType[] | null {
  if (raw == null || raw.trim() === "") return [];
  return canonicalizeTraceTypes(raw.split(","));
}

function canonicalizeTraceTypes(raw: unknown): TraceType[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const part of raw) {
    if (typeof part !== "string") return null;
    const type = part.trim();
    if (!TRACE_TYPE_SET.has(type)) return null;
    seen.add(type);
  }
  if (seen.size === TRACE_TYPES.length) return [];
  return TRACE_TYPES.filter((type) => seen.has(type));
}

function shareScope(share: ShareRow) {
  return {
    types: parseTraceTypes(share.trace_types) ?? [],
    node: share.node_key ?? null,
    child: share.child_session_id ?? null,
  };
}

function shareScopeQuery(scope: { types: TraceType[]; node: string | null; child: string | null }): string {
  const parts: string[] = [];
  if (scope.types.length) parts.push(`types=${scope.types.join(",")}`);
  if (scope.node) parts.push(`node=${encodeURIComponent(scope.node)}`);
  if (scope.child) parts.push(`child=${encodeURIComponent(scope.child)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

function isRestrictedShare(share: ShareRow): boolean {
  return share.trace_types !== "" || share.node_key != null;
}

/** 将用户搜索词中的 SQLite LIKE 通配符按字面量转义（配合 ESCAPE '\'） */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function respondList(
  c: Context,
  format: "json" | "jsonl",
  items: unknown[],
  nextOffset: number | null,
) {
  if (format === "jsonl") {
    const body =
      items.length === 0
        ? ""
        : items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": NDJSON_CONTENT_TYPE },
    });
  }
  return c.json({ items, next_offset: nextOffset });
}

type ShareAccess =
  | { ok: true; share: ShareRow; resolved: ResolvedShareCredential; credential: string }
  | { ok: false; status: 404 | 410; error: string };

function resolveShareAccess(
  db: Database,
  credential: string | undefined,
  apiKey: string,
): ShareAccess {
  if (!credential) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const resolved = resolveShareCredential(credential, apiKey);
  if (!resolved) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const share = db
    .query(
      `SELECT token_hash, session_id, created_at, expires_at
          , trace_types, node_key, child_session_id
       FROM session_shares WHERE token_hash = $token_hash`,
    )
    .get({ $token_hash: resolved.tokenHash }) as ShareRow | null;
  if (!share) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const expiresMs = new Date(share.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: "Share expired" };
  }
  return { ok: true, share, resolved, credential };
}

function projectMessage(row: {
  id: string;
  role: string;
  content?: string | null;
  model?: string | null;
  provider?: string | null;
  created_at: string;
}) {
  const content = truncateText(row.content, MESSAGE_CONTENT_MAX);
  return {
    id: row.id,
    role: row.role,
    content: content.text,
    truncated: content.truncated,
    model: row.model ?? null,
    provider: row.provider ?? null,
    created_at: row.created_at,
  };
}

function projectTurn(row: {
  id: string;
  message_id?: string | null;
  model: string;
  provider: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  cost_usd?: number;
  finish_reason?: string | null;
  error?: string | null;
  created_at: string;
}) {
  const withCny = withCostCny(row);
  return {
    id: row.id,
    message_id: row.message_id ?? null,
    model: row.model,
    provider: row.provider,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens ?? 0,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    reasoning_tokens: row.reasoning_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0,
    duration_ms: row.duration_ms ?? 0,
    cost_usd: row.cost_usd ?? 0,
    cost_cny: withCny.cost_cny,
    finish_reason: row.finish_reason ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

function projectToolCall(row: {
  id: string;
  tool_name: string;
  call_id?: string | null;
  args?: string | null;
  output_title?: string | null;
  output_text?: string | null;
  file_path?: string | null;
  duration_ms?: number;
  error?: string | null;
  created_at: string;
}) {
  const args = truncateText(row.args, TOOL_ARGS_MAX);
  const output = truncateText(row.output_text, TOOL_OUTPUT_MAX);
  return {
    id: row.id,
    tool_name: row.tool_name,
    call_id: row.call_id ?? null,
    output_title: row.output_title ?? null,
    duration_ms: row.duration_ms ?? 0,
    error: row.error ?? null,
    created_at: row.created_at,
    args: args.text,
    args_truncated: args.truncated,
    output_text: output.text,
    output_text_truncated: output.truncated,
  };
}

/** 祖先链硬上限（含 candidate 自身查找次数），与环检测并列 */
export const FOCUS_ANCESTOR_DEPTH_MAX = 32;

type FocusNodeKind = "message" | "turn" | "cursor-turn" | "tool" | "subagent";

type FocusParsedNode =
  | { ok: false; status: 400 | 404; error: string }
  | { ok: true; key: string; kind: FocusNodeKind; id: string };

type FocusMessageRow = {
  id: string;
  role: string;
  content?: string | null;
  model?: string | null;
  provider?: string | null;
  created_at: string;
};

type FocusTurnRow = {
  id: string;
  message_id?: string | null;
  model: string;
  provider: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  cost_usd?: number;
  finish_reason?: string | null;
  error?: string | null;
  created_at: string;
};

type FocusToolRow = {
  id: string;
  tool_name: string;
  call_id?: string | null;
  args?: string | null;
  output_title?: string | null;
  output_text?: string | null;
  file_path?: string | null;
  duration_ms?: number;
  error?: string | null;
  created_at: string;
};

type FocusSubagentRow = {
  id: string;
  title?: string | null;
  agent?: string | null;
  provider?: string | null;
  model?: string | null;
  started_at: string;
};

type FocusTimelineItem =
  | { key: string; kind: "message"; created_at: string; row: FocusMessageRow }
  | { key: string; kind: "turn"; created_at: string; row: FocusTurnRow }
  | { key: string; kind: "tool"; created_at: string; row: FocusToolRow }
  | { key: string; kind: "subagent"; created_at: string; row: FocusSubagentRow };

/** cursor-usage-* 为对账行，不单独进入公开时间线 */
function isCursorUsageTurnId(id: string | null | undefined): boolean {
  return !!id && String(id).startsWith("cursor-usage-");
}

/** 解析稳定 node key；fork 结构行不进入公开摘录 */
function parseFocusNodeKey(raw: string | undefined): FocusParsedNode {
  const key = (raw ?? "").trim();
  if (!key) {
    return { ok: false, status: 400, error: "Invalid node" };
  }
  if (key.startsWith("fork-from-") || key.startsWith("fork-origin-msg-")) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const prefixes: Array<{ prefix: string; kind: FocusNodeKind }> = [
    { prefix: "cursor-turn-", kind: "cursor-turn" },
    { prefix: "subagent-", kind: "subagent" },
    { prefix: "tool-", kind: "tool" },
    { prefix: "turn-", kind: "turn" },
    { prefix: "msg-", kind: "message" },
  ];
  for (const { prefix, kind } of prefixes) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!id) {
      return { ok: false, status: 400, error: "Invalid node" };
    }
    return { ok: true, key, kind, id };
  }
  return { ok: false, status: 400, error: "Invalid node" };
}

/** child 必须是分享根或其子孙；向上走 parent_session_id，遇环则拒绝 */
function isShareScopeSession(db: Database, rootId: string, candidateId: string): boolean {
  if (candidateId === rootId) return true;
  const seen = new Set<string>();
  let current: string | null = candidateId;
  let depth = 0;
  while (current) {
    if (seen.has(current)) return false;
    if (depth >= FOCUS_ANCESTOR_DEPTH_MAX) return false;
    seen.add(current);
    depth += 1;
    const row = db
      .query<{ parent_session_id: string | null }, { $id: string }>(
        "SELECT parent_session_id FROM sessions WHERE id = $id",
      )
      .get({ $id: current });
    if (!row) return false;
    if (row.parent_session_id === rootId) return true;
    current = row.parent_session_id;
  }
  return false;
}

function emptyTurnRow(message: FocusMessageRow, billing: FocusTurnRow | null): FocusTurnRow {
  const src = billing ?? {
    id: message.id,
    message_id: message.id,
    model: message.model ?? "",
    provider: message.provider ?? "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
    cost_usd: 0,
    finish_reason: null,
    error: null,
    created_at: message.created_at,
  };
  return {
    ...src,
    id: message.id,
    message_id: message.id,
    model: src.model || message.model || "",
    provider: src.provider || message.provider || "",
    created_at: message.created_at,
  };
}

const FOCUS_TURN_SELECT = `id, message_id, model, provider,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, total_tokens, duration_ms, cost_usd,
         finish_reason, error, created_at`;

/** 在授权 scope 内解析稳定 key，确认目标存在且可进入公开时间线 */
function resolveFocusTarget(
  db: Database,
  sessionId: string,
  agent: string | null | undefined,
  parsed: Extract<FocusParsedNode, { ok: true }>,
): FocusTimelineItem | null {
  if (parsed.kind === "message") {
    const row = db
      .query(
        `SELECT id, role, content, model, provider, created_at
         FROM messages
         WHERE session_id = $session_id AND id = $id`,
      )
      .get({ $session_id: sessionId, $id: parsed.id }) as FocusMessageRow | null;
    if (!row) return null;
    return { key: parsed.key, kind: "message", created_at: row.created_at, row };
  }

  if (parsed.kind === "turn") {
    if (isCursorUsageTurnId(parsed.id)) return null;
    const row = db
      .query(
        `SELECT ${FOCUS_TURN_SELECT}
         FROM turns
         WHERE session_id = $session_id AND id = $id`,
      )
      .get({ $session_id: sessionId, $id: parsed.id }) as FocusTurnRow | null;
    if (!row || isCursorUsageTurnId(row.id)) return null;
    return { key: parsed.key, kind: "turn", created_at: row.created_at, row };
  }

  if (parsed.kind === "tool") {
    const row = db
      .query(
        `SELECT id, tool_name, call_id, args, output_title, output_text,
           file_path, duration_ms, error, created_at
         FROM tool_calls
         WHERE session_id = $session_id AND id = $id`,
      )
      .get({ $session_id: sessionId, $id: parsed.id }) as FocusToolRow | null;
    if (!row) return null;
    return { key: parsed.key, kind: "tool", created_at: row.created_at, row };
  }

  if (parsed.kind === "subagent") {
    const row = db
      .query(
        `SELECT id, title, agent, provider, model, started_at
         FROM sessions
         WHERE id = $id AND parent_session_id = $session_id`,
      )
      .get({ $id: parsed.id, $session_id: sessionId }) as FocusSubagentRow | null;
    if (!row) return null;
    return { key: parsed.key, kind: "subagent", created_at: row.started_at, row };
  }

  if (agent !== "cursor") return null;
  const message = db
    .query(
      `SELECT id, role, content, model, provider, created_at
       FROM messages
       WHERE session_id = $session_id AND id = $id AND role = 'assistant'`,
    )
    .get({ $session_id: sessionId, $id: parsed.id }) as FocusMessageRow | null;
  if (!message) return null;
  const hooked = db
    .query<{ id: string }, { $session_id: string; $id: string }>(
      `SELECT id FROM turns
       WHERE session_id = $session_id AND message_id = $id AND id NOT LIKE 'cursor-usage-%'
       LIMIT 1`,
    )
    .get({ $session_id: sessionId, $id: parsed.id });
  if (hooked) return null;
  const billing = db
    .query(
      `SELECT ${FOCUS_TURN_SELECT}
       FROM turns
       WHERE session_id = $session_id AND message_id = $id AND id LIKE 'cursor-usage-%'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get({ $session_id: sessionId, $id: parsed.id }) as FocusTurnRow | null;
  return {
    key: parsed.key,
    kind: "turn",
    created_at: message.created_at,
    row: emptyTurnRow(message, billing),
  };
}

/** 聚焦条目显式白名单投影，不含环境/身份/fork 字段 */
function projectFocusItem(item: FocusTimelineItem): Record<string, unknown> {
  if (item.kind === "message") {
    return { key: item.key, kind: "message", ...projectMessage(item.row) };
  }
  if (item.kind === "turn") {
    return { key: item.key, kind: "turn", ...projectTurn(item.row) };
  }
  if (item.kind === "tool") {
    return { key: item.key, kind: "tool", ...projectToolCall(item.row) };
  }
  const title = item.row.title ?? null;
  return {
    key: item.key,
    kind: "subagent",
    id: item.row.id,
    title,
    summary: (title && String(title).trim()) || item.row.id,
    agent: item.row.agent ?? null,
    provider: item.row.provider ?? null,
    model: item.row.model ?? null,
    started_at: item.row.started_at,
    created_at: item.row.started_at,
  };
}

function focusItemCategory(item: FocusTimelineItem): TraceType {
  if (item.kind === "message") {
    if (item.row.role === "reasoning") return "reasoning";
    if (item.row.role === "assistant") return "assistant";
    if (item.row.role === "tool") return "tool";
    return "user";
  }
  if (item.kind === "tool") return "tool";
  if (item.kind === "subagent") return "subagent";
  const error = String(item.row.error ?? "").toLowerCase();
  const finish = String(item.row.finish_reason ?? "").toLowerCase();
  if (
    error === "aborted"
    || finish === "aborted"
    || error.includes("messageaborted")
    || error.includes("interrupted by user")
    || error.includes("aborted by user")
  ) return "abort";
  if (error) return "error";
  return "turn";
}

function shareAllowsCategory(share: ShareRow, category: TraceType): boolean {
  const types = shareScope(share).types;
  return types.length === 0 || types.includes(category);
}

/** 创建/列表/撤回分享：/v1/sessions/:id/shares*（由 app 层 sessions authGuard 保护） */
export function createSessionSharesRoute(db: Database, apiKey: string) {
  const app = new Hono();

  app.post("/v1/sessions/:id/shares", async (c) => {
    const sessionId = c.req.param("id");
    const session = db
      .query("SELECT id, agent FROM sessions WHERE id = $id")
      .get({ $id: sessionId }) as { id: string; agent: string | null } | null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      duration?: string;
      types?: unknown;
      node?: unknown;
      child?: unknown;
    };
    const duration = body.duration as ShareDuration | undefined;
    if (!duration || !(duration in SHARE_DURATIONS)) {
      return c.json(
        { error: "Invalid duration", allowed: Object.keys(SHARE_DURATIONS) },
        400,
      );
    }
    const types = canonicalizeTraceTypes(body.types);
    if (!types) {
      return c.json({ error: "Invalid types", allowed: TRACE_TYPES }, 400);
    }
    const node = typeof body.node === "string" && body.node.trim() ? body.node.trim() : null;
    const child = typeof body.child === "string" && body.child.trim() ? body.child.trim() : null;
    if (body.node != null && body.node !== "" && !node) {
      return c.json({ error: "Invalid node" }, 400);
    }
    if (body.child != null && body.child !== "" && !child) {
      return c.json({ error: "Invalid child" }, 400);
    }
    if (child && !node) {
      return c.json({ error: "Invalid child" }, 400);
    }
    if (node) {
      const parsed = parseFocusNodeKey(node);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, parsed.status);
      }
      const scopeId = child || sessionId;
      if (!isShareScopeSession(db, sessionId, scopeId)) {
        return c.json({ error: "Invalid child" }, 400);
      }
      const scopeSession = scopeId === sessionId
        ? session
        : db.query<{ id: string; agent: string | null }, { $id: string }>(
            "SELECT id, agent FROM sessions WHERE id = $id",
          ).get({ $id: scopeId });
      const target = scopeSession
        ? resolveFocusTarget(db, scopeId, scopeSession.agent, parsed)
        : null;
      if (!target) {
        return c.json({ error: "Invalid node" }, 400);
      }
      const category = focusItemCategory(target);
      if (types.length && !types.includes(category)) {
        return c.json({ error: "Node outside selected types" }, 400);
      }
    }
    const scope = { types, node, child };

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHARE_DURATIONS[duration]);
    const token = generateShareToken();
    const tokenHash = hashToken(token);
    const createdAt = now.toISOString();
    const expiresAtIso = expiresAt.toISOString();

    db.query(`
      INSERT INTO session_shares (
        token_hash, session_id, created_at, expires_at,
        trace_types, node_key, child_session_id
      ) VALUES (
        $token_hash, $session_id, $created_at, $expires_at,
        $trace_types, $node_key, $child_session_id
      )
    `).run({
      $token_hash: tokenHash,
      $session_id: sessionId,
      $created_at: createdAt,
      $expires_at: expiresAtIso,
      $trace_types: types.join(","),
      $node_key: node,
      $child_session_id: child,
    });

    const origin = requestOrigin(c);
    const alias = signShareLinkAlias(apiKey, tokenHash);
    // 人类可复制链接用签名 alias；API / agent_prompt 仍用原始 token
    const shareUrl = `${origin}/#/share/${alias}${shareScopeQuery(scope)}`;
    const apiUrl = `${origin}/v1/public/session-shares/${token}`;

    return c.json(
      {
        id: tokenHash,
        token,
        share_url: shareUrl,
        api_url: apiUrl,
        expires_at: expiresAtIso,
        scope,
        agent_prompt: buildAgentPrompt(apiUrl, types.length > 0 || node != null),
      },
      201,
    );
  });

  app.get("/v1/sessions/:id/shares", (c) => {
    const sessionId = c.req.param("id");
    const session = db
      .query("SELECT id FROM sessions WHERE id = $id")
      .get({ $id: sessionId }) as { id: string } | null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const nowIso = new Date().toISOString();
    const rows = db
      .query(
        `SELECT token_hash, created_at, expires_at, trace_types, node_key, child_session_id
         FROM session_shares
         WHERE session_id = $session_id AND expires_at > $now
         ORDER BY created_at DESC`,
      )
      .all({ $session_id: sessionId, $now: nowIso }) as Array<{
      token_hash: string;
      created_at: string;
      expires_at: string;
      trace_types: string;
      node_key: string | null;
      child_session_id: string | null;
    }>;

    const origin = requestOrigin(c);
    return c.json({
      shares: rows.map((row) => {
        const scope = shareScope({ ...row, session_id: sessionId });
        return {
          id: row.token_hash,
          created_at: row.created_at,
          expires_at: row.expires_at,
          scope,
          share_url: `${origin}/#/share/${signShareLinkAlias(apiKey, row.token_hash)}${shareScopeQuery(scope)}`,
        };
      }),
    });
  });

  app.delete("/v1/sessions/:id/shares/:shareId", (c) => {
    const sessionId = c.req.param("id");
    const shareId = c.req.param("shareId");
    if (!isShareId(shareId)) {
      return c.json({ error: "Not found" }, 404);
    }

    const result = db
      .query(
        `DELETE FROM session_shares
         WHERE session_id = $session_id AND token_hash = $token_hash`,
      )
      .run({
        $session_id: sessionId,
        $token_hash: shareId.toLowerCase(),
      });

    if (result.changes === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ revoked: true });
  });

  return app;
}

/** 公开读取分享 bundle：GET /v1/public/session-shares/:token（免登录） */
export function createPublicSessionSharesRoute(db: Database, apiKey: string) {
  const app = new Hono();

  app.get("/v1/public/session-shares/:credential", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const origin = requestOrigin(c);

    // 浏览器打开 API URL：302 到人类页。raw token 必须保留原 token，禁止改成 alias
    if (wantsHtmlRedirect(c)) {
      const pageCredential =
        access.resolved.kind === "raw" ? access.resolved.token : access.resolved.alias;
      return c.redirect(
        `${origin}/#/share/${pageCredential}${shareScopeQuery(shareScope(access.share))}`,
        302,
      );
    }

    const session = db
      .query(`
        SELECT id, title, AISummary, agent, provider, model,
          started_at, ended_at, request_count,
          total_input_tokens, total_output_tokens, total_tokens, total_cost_usd
        FROM sessions WHERE id = $id
      `)
      .get({ $id: access.share.session_id }) as SessionRow | null;
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    // agent_prompt 在持有原始 token 时继续引用 raw API URL（创建响应 / curl 场景）
    const credentialForUrls =
      access.resolved.kind === "raw" ? access.resolved.token : access.resolved.alias;
    const apiUrl = publicShareBaseUrl(origin, credentialForUrls);
    const restricted = isRestrictedShare(access.share);
    const resources = restricted
      ? { trace: `${apiUrl}/trace?limit=50` }
      : {
          search: `${apiUrl}/search`,
          trace: `${apiUrl}/trace?limit=50`,
          messages: `${apiUrl}/messages?format=jsonl&limit=50`,
          turns: `${apiUrl}/turns?format=jsonl&limit=50`,
          tool_calls: `${apiUrl}/tool-calls?format=jsonl&limit=50`,
        };

    const summaryMarkdown =
      session.AISummary == null || String(session.AISummary).trim() === ""
        ? null
        : String(session.AISummary);

    return c.json({
      share: { expires_at: access.share.expires_at },
      session: withTotalCostCny(serializeShareSession(db, session)),
      summary_markdown: summaryMarkdown,
      scope: shareScope(access.share),
      resources,
      agent_prompt: buildAgentPrompt(apiUrl, restricted),
    });
  });

  app.get("/v1/public/session-shares/:credential/search", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    if (isRestrictedShare(access.share)) {
      return c.json({ error: "Use the scoped trace resource" }, 403);
    }

    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) {
      return c.json({ error: "Invalid q", hint: "q must be at least 2 characters" }, 400);
    }
    const kind = (c.req.query("kind") ?? "all").toLowerCase();
    if (kind !== "all" && kind !== "message" && kind !== "tool") {
      return c.json({ error: "Invalid kind", allowed: ["all", "message", "tool"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 20, 1, SEARCH_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: SEARCH_LIMIT_MAX }, 400);
    }

    const like = `%${escapeLikePattern(q)}%`;
    type SearchItem = {
      kind: "message" | "tool";
      id: string;
      created_at: string;
      role?: string;
      tool_name?: string;
      snippet: string;
    };
    const items: SearchItem[] = [];

    if (kind === "all" || kind === "message") {
      const rows = db
        .query(
          `SELECT id, role, content, created_at
           FROM messages
           WHERE session_id = $session_id AND content LIKE $q ESCAPE '\\'
           ORDER BY created_at ASC
           LIMIT $limit`,
        )
        .all({
          $session_id: access.share.session_id,
          $q: like,
          $limit: limit,
        }) as Array<{ id: string; role: string; content: string | null; created_at: string }>;
      for (const row of rows) {
        items.push({
          kind: "message",
          id: row.id,
          created_at: row.created_at,
          role: row.role,
          snippet: truncateText(row.content, SEARCH_SNIPPET_MAX).text,
        });
      }
    }

    if (kind === "all" || kind === "tool") {
      const remaining = Math.max(0, limit - items.length);
      if (remaining > 0) {
        const rows = db
          .query(
            `SELECT id, tool_name, output_title, output_text, created_at
             FROM tool_calls
             WHERE session_id = $session_id
               AND (
                 tool_name LIKE $q ESCAPE '\\'
                 OR IFNULL(output_title, '') LIKE $q ESCAPE '\\'
                 OR IFNULL(output_text, '') LIKE $q ESCAPE '\\'
               )
             ORDER BY created_at ASC
             LIMIT $limit`,
          )
          .all({
            $session_id: access.share.session_id,
            $q: like,
            $limit: remaining,
          }) as Array<{
          id: string;
          tool_name: string;
          output_title: string | null;
          output_text: string | null;
          created_at: string;
        }>;
        for (const row of rows) {
          const snippetSource =
            (row.output_title && row.output_title.includes(q) && row.output_title) ||
            (row.output_text && row.output_text) ||
            row.tool_name;
          items.push({
            kind: "tool",
            id: row.id,
            created_at: row.created_at,
            tool_name: row.tool_name,
            snippet: truncateText(snippetSource, SEARCH_SNIPPET_MAX).text,
          });
        }
      }
    }

    items.sort((a, b) => {
      if (a.created_at < b.created_at) return -1;
      if (a.created_at > b.created_at) return 1;
      return 0;
    });

    return c.json({ items: items.slice(0, limit) });
  });

  /** 公开分享调用链：按分类分页读取根 Session 时间线 */
  app.get("/v1/public/session-shares/:credential/trace", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const scope = shareScope(access.share);
    const types = scope.types;
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }

    const scopeSessionId = scope.node && scope.child ? scope.child : access.share.session_id;
    const session = db
      .query<{ agent: string | null }, { $id: string }>("SELECT agent FROM sessions WHERE id = $id")
      .get({ $id: scopeSessionId });
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    const typeParams: Record<string, string> = {};
    const scopeClauses: string[] = [];
    if (types.length) {
      scopeClauses.push(`category IN (${types.map((type, index) => {
          typeParams[`$type_${index}`] = type;
          return `$type_${index}`;
        }).join(", ")})`);
    }
    if (scope.node) {
      typeParams.$node_key = scope.node;
      scopeClauses.push("key = $node_key");
    }
    const typeWhere = scopeClauses.length ? `WHERE ${scopeClauses.join(" AND ")}` : "";
    const abortSql = (alias: string) => `(
      LOWER(IFNULL(${alias}.error, '')) = 'aborted'
      OR LOWER(IFNULL(${alias}.finish_reason, '')) = 'aborted'
      OR LOWER(IFNULL(${alias}.error, '')) LIKE '%messageaborted%'
      OR LOWER(IFNULL(${alias}.error, '')) LIKE '%interrupted by user%'
      OR LOWER(IFNULL(${alias}.error, '')) LIKE '%aborted by user%'
    )`;
    const categorySql = (alias: string) => `CASE
      WHEN ${abortSql(alias)} THEN 'abort'
      WHEN IFNULL(${alias}.error, '') != '' THEN 'error'
      ELSE 'turn'
    END`;

    type TraceIndexRow = {
      key: string;
      kind: FocusNodeKind;
      id: string;
      category: TraceType;
      created_at: string;
      tie: number;
    };
    const rows = db
      .query(
        `WITH timeline AS (
           SELECT 'msg-' || m.id AS key, 'message' AS kind, m.id AS id,
             CASE
               WHEN m.role = 'reasoning' THEN 'reasoning'
               WHEN m.role = 'assistant' THEN 'assistant'
               WHEN m.role = 'tool' THEN 'tool'
               ELSE 'user'
             END AS category,
             m.created_at AS created_at,
             CASE
               WHEN m.role = 'reasoning' THEN 3
               WHEN m.role = 'assistant' THEN 4
               WHEN m.role = 'user' OR m.role = 'system' THEN 1
               ELSE 5
             END AS tie
           FROM messages m
           WHERE m.session_id = $session_id

           UNION ALL

           SELECT 'turn-' || t.id AS key, 'turn' AS kind, t.id AS id,
             ${categorySql("t")} AS category,
             COALESCE(m.created_at, t.created_at) AS created_at,
             2 AS tie
           FROM turns t
           LEFT JOIN messages m ON m.session_id = t.session_id AND m.id = t.message_id
           WHERE t.session_id = $session_id AND t.id NOT LIKE 'cursor-usage-%'

           UNION ALL

           SELECT 'tool-' || tc.id AS key, 'tool' AS kind, tc.id AS id,
             'tool' AS category, tc.created_at AS created_at, 6 AS tie
           FROM tool_calls tc
           WHERE tc.session_id = $session_id

           UNION ALL

           SELECT 'subagent-' || s.id AS key, 'subagent' AS kind, s.id AS id,
             'subagent' AS category, s.started_at AS created_at, 7 AS tie
           FROM sessions s
           WHERE s.parent_session_id = $session_id

           UNION ALL

           SELECT 'cursor-turn-' || m.id AS key, 'cursor-turn' AS kind, m.id AS id,
             ${categorySql("b")} AS category,
             m.created_at AS created_at, 2 AS tie
           FROM messages m
           LEFT JOIN turns b ON b.id = (
             SELECT billing.id FROM turns billing
             WHERE billing.session_id = m.session_id
               AND billing.message_id = m.id
               AND billing.id LIKE 'cursor-usage-%'
             ORDER BY billing.created_at DESC, billing.id DESC
             LIMIT 1
           )
           WHERE $is_cursor = 1
             AND m.session_id = $session_id
             AND m.role = 'assistant'
             AND NOT EXISTS (
               SELECT 1 FROM turns hooked
               WHERE hooked.session_id = m.session_id
                 AND hooked.message_id = m.id
                 AND hooked.id NOT LIKE 'cursor-usage-%'
             )
         )
         SELECT key, kind, id, category, created_at, tie
         FROM timeline
         ${typeWhere}
         ORDER BY created_at ASC, tie ASC, key ASC
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        $session_id: scopeSessionId,
        $is_cursor: session.agent === "cursor" ? 1 : 0,
        $limit: limit + 1,
        $offset: offset,
        ...typeParams,
      }) as TraceIndexRow[];

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).flatMap((row) => {
      const parsed = parseFocusNodeKey(row.key);
      if (!parsed.ok) return [];
      const target = resolveFocusTarget(db, scopeSessionId, session.agent, parsed);
      if (!target) return [];
      return [{ ...projectFocusItem(target), category: row.category }];
    });

    return c.json({
      items,
      pagination: {
        limit,
        offset,
        returned: items.length,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
      },
      scope,
    });
  });

  app.get("/v1/public/session-shares/:credential/messages", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    if (isRestrictedShare(access.share)) {
      return c.json({ error: "Use the scoped trace resource" }, 403);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }
    const role = c.req.query("role");
    if (role != null && role !== "" && role !== "user" && role !== "assistant") {
      return c.json({ error: "Invalid role", allowed: ["user", "assistant"] }, 400);
    }

    const rows = (
      role
        ? db
            .query(
              `SELECT id, role, content, model, provider, created_at
               FROM messages
               WHERE session_id = $session_id AND role = $role
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $role: role,
              $limit: limit + 1,
              $offset: offset,
            })
        : db
            .query(
              `SELECT id, role, content, model, provider, created_at
               FROM messages
               WHERE session_id = $session_id
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $limit: limit + 1,
              $offset: offset,
            })
    ) as Array<{
      id: string;
      role: string;
      content: string | null;
      model: string | null;
      provider: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectMessage);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  app.get("/v1/public/session-shares/:credential/turns", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    if (isRestrictedShare(access.share)) {
      return c.json({ error: "Use the scoped trace resource" }, 403);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }

    const rows = db
      .query(
        `SELECT id, message_id, model, provider,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, total_tokens, duration_ms, cost_usd,
           finish_reason, error, created_at
         FROM turns
         WHERE session_id = $session_id
         ORDER BY created_at ASC
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        $session_id: access.share.session_id,
        $limit: limit + 1,
        $offset: offset,
      }) as Array<{
      id: string;
      message_id: string | null;
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
      duration_ms: number;
      cost_usd: number;
      finish_reason: string | null;
      error: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectTurn);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  app.get("/v1/public/session-shares/:credential/tool-calls", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    if (isRestrictedShare(access.share)) {
      return c.json({ error: "Use the scoped trace resource" }, 403);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }
    const toolName = c.req.query("tool_name");

    const rows = (
      toolName
        ? db
            .query(
              `SELECT id, tool_name, call_id, args, output_title, output_text,
                 file_path, duration_ms, error, created_at
               FROM tool_calls
               WHERE session_id = $session_id AND tool_name = $tool_name
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $tool_name: toolName,
              $limit: limit + 1,
              $offset: offset,
            })
        : db
            .query(
              `SELECT id, tool_name, call_id, args, output_title, output_text,
                 file_path, duration_ms, error, created_at
               FROM tool_calls
               WHERE session_id = $session_id
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $limit: limit + 1,
              $offset: offset,
            })
    ) as Array<{
      id: string;
      tool_name: string;
      call_id: string | null;
      args: string | null;
      output_title: string | null;
      output_text: string | null;
      file_path: string | null;
      duration_ms: number;
      error: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectToolCall);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  /** 公开分享聚焦摘录：GET /v1/public/session-shares/:token/focus（凭据保护，精确节点） */
  app.get("/v1/public/session-shares/:credential/focus", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const parsed = parseFocusNodeKey(c.req.query("node"));
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    const storedScope = shareScope(access.share);
    const childRaw = (c.req.query("child") ?? "").trim();
    if (storedScope.node) {
      if (parsed.key !== storedScope.node || childRaw !== (storedScope.child ?? "")) {
        return c.json({ error: "Not found" }, 404);
      }
    }
    const scopeId = childRaw || access.share.session_id;
    if (!isShareScopeSession(db, access.share.session_id, scopeId)) {
      return c.json({ error: "Not found" }, 404);
    }

    const scope = db
      .query<{ id: string; agent: string | null }, { $id: string }>(
        "SELECT id, agent FROM sessions WHERE id = $id",
      )
      .get({ $id: scopeId });
    if (!scope) {
      return c.json({ error: "Not found" }, 404);
    }

    const target = resolveFocusTarget(db, scope.id, scope.agent, parsed);
    if (!target) {
      return c.json({ error: "Not found" }, 404);
    }
    const category = focusItemCategory(target);
    if (!shareAllowsCategory(access.share, category)) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({
      child: scope.id === access.share.session_id ? null : scope.id,
      node: parsed.key,
      item: { ...projectFocusItem(target), category },
    });
  });

  return app;
}
