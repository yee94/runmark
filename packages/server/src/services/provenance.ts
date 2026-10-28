import type { Database } from "bun:sqlite";
import type { IngestEvent, IngestBatchResponse } from "@agent-tracker/shared";
import { createHash } from "node:crypto";

export type SourcedEvent = IngestEvent & {
  otlp?: { traceId: string; spanId: string; nativeSession?: string; magpieOpenCode: boolean };
};

export type AppliedIngestResult = IngestBatchResponse & { appliedEvents: IngestEvent[] };

const SESSION_METADATA_FIELDS = ["title", "provider", "project_name", "repo_url", "branch", "user_email", "hostname", "worktree", "directory", "parent_session_id"] as const;

/** 只保存已有元数据作为未知来源的基线；混合累计不能成为原生快照。 */
function rememberMetadataBaseline(db: Database, sessionId: string): void {
  if (db.query("SELECT 1 FROM native_sessions WHERE session_id = ?").get(sessionId)) return;
  const baseline = db.query(`SELECT ${SESSION_METADATA_FIELDS.join(", ")}, metadata FROM sessions WHERE id = ?`).get(sessionId);
  db.query("INSERT INTO native_sessions (session_id, metadata_baseline) VALUES (?, ?)").run(sessionId, JSON.stringify(baseline ?? {}));
}

function restoreNativeMetadata(db: Database, sessionId: string): void {
  if (!active(db, sessionId)) return;
  const row = db.query("SELECT metadata_baseline FROM native_sessions WHERE session_id = ?").get(sessionId) as { metadata_baseline: string };
  const authority = JSON.parse(row.metadata_baseline) as Record<string, any>;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(authority.metadata ?? "{}"); } catch { /* 保留无法解析的历史正文。 */ }
  let hasNativeMetadata = false;
  const snapshots = db.query(`SELECT event_json FROM ingest_events WHERE source = 'native' AND session_id = ?
    AND json_extract(event_json, '$.type') LIKE 'session.%' ORDER BY id`).all(sessionId) as Array<{ event_json: string }>;
  for (const snapshot of snapshots) {
    const event = JSON.parse(snapshot.event_json);
    for (const field of SESSION_METADATA_FIELDS) if (Object.hasOwn(event, field)) authority[field] = event[field];
    if (event.metadata && typeof event.metadata === "object") {
      metadata = { ...metadata, ...event.metadata };
      hasNativeMetadata = true;
    }
  }
  if (!authority.provider) {
    const latest = db.query(`SELECT json_extract(event_json, '$.provider') AS provider FROM ingest_events
      WHERE source = 'native' AND session_id = ? AND json_extract(event_json, '$.provider') IS NOT NULL ORDER BY id DESC LIMIT 1`).get(sessionId) as { provider: string } | null;
    authority.provider = latest?.provider ?? null;
  }
  db.query(`UPDATE sessions SET ${SESSION_METADATA_FIELDS.map(field => `${field} = ?`).join(", ")}, metadata = ? WHERE id = ?`)
    .run(...SESSION_METADATA_FIELDS.map(field => authority[field] ?? null),
      hasNativeMetadata || authority.metadata == null ? JSON.stringify(metadata) : authority.metadata, sessionId);
}

function identity(event: IngestEvent): { key: string; table?: string; id: string } {
  if (event.type === "turn.completed" || event.type === "turn.error") return { key: `turn:${event.turn_id}`, table: "turns", id: event.turn_id };
  if (event.type === "message") return { key: `message:${event.message_id}`, table: "messages", id: event.message_id };
  if (event.type === "tool.result") return { key: `tool:${event.session_id}:${event.call_id}`, table: "tool_calls", id: event.call_id };
  return { key: `${event.type}:${event.session_id}`, table: "sessions", id: event.session_id };
}

function visibleState(db: Database, event: IngestEvent): string {
  const entity = identity(event);
  const session = db.query("SELECT * FROM sessions WHERE id = ?").get(event.session_id);
  const row = entity.table === "sessions" ? null : db.query(
    `SELECT * FROM ${entity.table} WHERE ${entity.table === "tool_calls" ? "call_id" : "id"} = ? AND session_id = ?`,
  ).get(entity.id, event.session_id);
  return JSON.stringify([session, row]);
}

function changedSessionEvents(db: Database, ids: string[]): IngestEvent[] {
  return ids.flatMap(id => {
    const session = db.query("SELECT agent FROM sessions WHERE id = ?").get(id) as { agent: string } | null;
    return session ? [{ type: "session.updated" as const, session_id: id, agent: session.agent }] : [];
  });
}

function linkExactCalls(db: Database, sessionId: string, traceId?: string): void {
  if (traceId === undefined && !active(db, sessionId)) return;
  const candidates = db.query(`SELECT DISTINCT trace_id, span_id FROM ingest_events
    WHERE source = 'otlp' AND native_turn_id IS NULL AND json_extract(event_json, '$.otlp.magpieOpenCode') = 1
    AND (? IS NULL OR trace_id = ?)`).all(traceId ?? null, traceId ?? null) as Array<{ trace_id: string; span_id: string }>;
  if (!candidates.length) return;
  const spansByTrace = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!spansByTrace.has(candidate.trace_id)) spansByTrace.set(candidate.trace_id, new Set());
    spansByTrace.get(candidate.trace_id)!.add(candidate.span_id);
  }
  const users = db.query(`SELECT DISTINCT e.session_id, json_extract(e.event_json, '$.message_id') AS id
    FROM ingest_events e JOIN native_sessions n ON n.session_id = e.session_id AND n.confirmed = 1 AND n.active = 1
    WHERE e.source = 'native' AND json_extract(e.event_json, '$.type') = 'message'
    AND json_extract(e.event_json, '$.role') = 'user' AND (? IS NULL OR e.session_id = ?)`)
    .all(traceId === undefined ? sessionId : null, traceId === undefined ? sessionId : null) as Array<{ session_id: string; id: string }>;
  for (const user of users) {
    const parts = ["opencode", user.session_id, user.id];
    const trace = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    const spans = spansByTrace.get(trace);
    if (!spans) continue;
    const turns = db.query(`SELECT DISTINCT t.id, t.message_id FROM turns t JOIN ingest_events e
      ON e.source = 'native' AND e.session_id = t.session_id AND e.event_key = 'turn:' || t.id
      WHERE t.session_id = ? AND t.total_tokens > 0 AND t.error IS NULL`).all(user.session_id) as Array<{ id: string; message_id: string | null }>;
    for (const turn of turns) {
      const span = createHash("sha256").update([...parts, turn.message_id ?? turn.id].join("\0")).digest("hex").slice(0, 16);
      if (!spans.has(span)) continue;
      db.query(`UPDATE ingest_events SET linked_session = ?, native_turn_id = ?
        WHERE source = 'otlp' AND trace_id = ? AND span_id = ? AND json_extract(event_json, '$.otlp.magpieOpenCode') = 1`)
        .run(user.session_id, turn.id, trace, span);
    }
  }
  for (const trace of spansByTrace.keys()) db.query(`UPDATE ingest_events SET linked_session = (
      SELECT e.linked_session FROM ingest_events e WHERE e.source = 'otlp'
      AND e.trace_id = ingest_events.trace_id AND e.native_turn_id IS NOT NULL LIMIT 1)
    WHERE source = 'otlp' AND native_turn_id IS NULL AND json_extract(event_json, '$.otlp.magpieOpenCode') = 1
    AND trace_id = ?
    AND EXISTS (SELECT 1 FROM ingest_events e WHERE e.source = 'otlp'
      AND e.trace_id = ingest_events.trace_id AND e.native_turn_id IS NOT NULL)`).run(trace);
}

function active(db: Database, sessionId: string | undefined): boolean {
  return !!sessionId && !!db.query("SELECT 1 FROM native_sessions WHERE session_id = ? AND confirmed = 1 AND active = 1").get(sessionId);
}

function reconcile(db: Database, sessionId: string, traceId?: string, initialSession?: string): string[] {
  const changed = new Set<string>();
  const params = { $session: sessionId, $trace: traceId ?? null };
  const scope = "(e.session_id = $session OR e.linked_session = $session OR e.trace_id = $trace)";
  const projections = db.query(`SELECT DISTINCT p.* FROM otlp_projections p
    JOIN ingest_events e ON e.source = 'otlp' AND e.event_key = p.event_key
    JOIN native_sessions n ON n.session_id = e.linked_session
    WHERE n.confirmed = 1 AND n.active = 1 AND ${scope}`).all(params) as Array<{ event_key: string; session_id: string; kind: string; entity_id: string }>;
  const touched = new Set<string>();
  for (const p of projections) {
    if (p.kind === "sessions") continue;
    const column = p.kind === "tool_calls" ? "call_id" : "id";
    if (db.query(`DELETE FROM ${p.kind} WHERE ${column} = ? AND session_id = ?`).run(p.entity_id, p.session_id).changes) changed.add(p.session_id);
    db.query("DELETE FROM otlp_projections WHERE event_key = ?").run(p.event_key);
    touched.add(p.session_id);
  }
  for (const p of projections.filter(p => p.kind === "sessions")) {
    const hasNative = db.query("SELECT 1 FROM ingest_events WHERE source = 'native' AND session_id = ? LIMIT 1").get(p.session_id);
    const hasContent = ["turns", "messages", "tool_calls"].some(table => db.query(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(p.session_id));
    if (!hasNative && !hasContent) db.query("DELETE FROM sessions WHERE id = ?").run(p.session_id);
    if (hasNative || !hasContent) db.query("DELETE FROM otlp_projections WHERE event_key = ?").run(p.event_key);
  }
  for (const row of db.query(`SELECT session_id FROM native_sessions n WHERE confirmed = 1 AND active = 1
    AND EXISTS (SELECT 1 FROM ingest_events e WHERE e.source = 'otlp' AND e.linked_session = n.session_id AND ${scope})`).all(params) as Array<{ session_id: string }>) touched.add(row.session_id);
  for (const id of touched) {
    const before = id === sessionId && initialSession !== undefined ? initialSession
      : JSON.stringify(db.query("SELECT * FROM sessions WHERE id = ?").get(id));
    const snapshot = db.query(`SELECT
      COALESCE(MAX(json_extract(event_json, '$.request_count')), 0) AS requests,
      COALESCE(MAX(json_extract(event_json, '$.session_input_tokens')), 0) AS input,
      COALESCE(MAX(json_extract(event_json, '$.session_output_tokens')), 0) AS output,
      COALESCE(MAX(json_extract(event_json, '$.session_total_tokens')), 0) AS tokens,
      COALESCE(MAX(json_extract(event_json, '$.session_cost_usd')), 0) AS cost
      FROM ingest_events WHERE source = 'native' AND session_id = ?
      AND json_extract(event_json, '$.type') LIKE 'session.%'`).get(id) as { requests: number; input: number; output: number; tokens: number; cost: number };
    db.query(`UPDATE sessions SET
      request_count = MAX($requests, (SELECT COUNT(*) FROM turns WHERE session_id = $id)),
      total_input_tokens = MAX($input, (SELECT COALESCE(SUM(input_tokens), 0) FROM turns WHERE session_id = $id)),
      total_output_tokens = MAX($output, (SELECT COALESCE(SUM(output_tokens), 0) FROM turns WHERE session_id = $id)),
      total_tokens = MAX($tokens, (SELECT COALESCE(SUM(total_tokens), 0) FROM turns WHERE session_id = $id)),
      total_cost_usd = MAX($cost, (SELECT COALESCE(SUM(cost_usd), 0) FROM turns WHERE session_id = $id)),
      model = (SELECT GROUP_CONCAT(model, ', ') FROM (SELECT model FROM turns WHERE session_id = $id AND LOWER(model) != 'unknown' GROUP BY LOWER(model)))
      WHERE id = $id`).run({ $id: id, $requests: snapshot.requests, $input: snapshot.input, $output: snapshot.output, $tokens: snapshot.tokens, $cost: snapshot.cost });
    restoreNativeMetadata(db, id);
    if (before !== JSON.stringify(db.query("SELECT * FROM sessions WHERE id = ?").get(id))) changed.add(id);
  }
  return [...changed];
}

/** 来源档案与可见投影同事务提交；只有有来源凭据的 OTLP 投影可被撤下。 */
export function ingestWithProvenance(
  db: Database, events: SourcedEvent[], source: "native" | "otlp",
  ingest: (events: IngestEvent[]) => IngestBatchResponse,
): AppliedIngestResult {
  const result: AppliedIngestResult = { ingested: 0, errors: [], appliedEvents: [] };
  for (const [index, event] of events.entries()) {
    try {
      const appliedEvents = db.transaction((): IngestEvent[] => {
        rememberMetadataBaseline(db, event.session_id);
        const entity = identity(event);
        const origin = source === "otlp" ? event.otlp : undefined;
        db.query(`INSERT OR IGNORE INTO ingest_events (source, event_key, session_id, trace_id, span_id, linked_session, event_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(source, entity.key, event.session_id, origin?.traceId ?? null, origin?.spanId ?? null, origin?.nativeSession ?? null, JSON.stringify(event));
        if (source === "otlp") {
          linkExactCalls(db, event.session_id, origin?.traceId);
          const linked = db.query("SELECT linked_session FROM ingest_events WHERE source = 'otlp' AND event_key = ? AND event_json = ?").get(entity.key, JSON.stringify(event)) as { linked_session: string | null };
          if (active(db, linked?.linked_session ?? undefined)) {
            return changedSessionEvents(db, reconcile(db, event.session_id, origin?.traceId));
          }
        }
        const column = entity.table === "tool_calls" ? "call_id" : "id";
        const existed = entity.table === "sessions" ? db.query("SELECT 1 FROM sessions WHERE id = ?").get(entity.id)
          : entity.table && db.query(`SELECT 1 FROM ${entity.table} WHERE ${column} = ? AND session_id = ?`).get(entity.id, event.session_id);
        const before = visibleState(db, event);
        const initialSession = JSON.stringify(db.query("SELECT * FROM sessions WHERE id = ?").get(event.session_id));
        const applied = ingest([event]);
        if (applied.errors.length) throw new Error(applied.errors[0].error);
        if (source === "otlp" && entity.table && !existed) {
          db.query("INSERT OR IGNORE INTO otlp_projections VALUES (?, ?, ?, ?)").run(entity.key, event.session_id, entity.table, entity.id);
        }
        if (source === "native") {
          const confirmed = event.type.startsWith("session.") && "agent" in event && event.agent === "opencode";
          const validTurn = event.type === "turn.completed" && event.total_tokens > 0 && !event.error &&
            !!db.query("SELECT 1 FROM turns WHERE id = ? AND session_id = ? AND total_tokens > 0 AND error IS NULL").get(event.turn_id, event.session_id);
          if (confirmed || validTurn) db.query(`INSERT INTO native_sessions (session_id, confirmed, active) VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET confirmed = MAX(confirmed, excluded.confirmed), active = MAX(active, excluded.active)`)
            .run(event.session_id, confirmed ? 1 : 0, validTurn ? 1 : 0);
          linkExactCalls(db, event.session_id);
        }
        const changed = reconcile(db, event.session_id, origin?.traceId, initialSession);
        const visible = before !== visibleState(db, event);
        return [
          ...(visible ? [event] : []),
          ...changedSessionEvents(db, changed.filter(id => !visible || id !== event.session_id)),
        ];
      })();
      result.appliedEvents.push(...appliedEvents);
      result.ingested++;
    } catch (error) {
      result.errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.appliedEvents = result.appliedEvents.filter(event => {
    const entity = identity(event);
    return entity.table === "sessions"
      ? !!db.query("SELECT 1 FROM sessions WHERE id = ?").get(event.session_id)
      : !!db.query(`SELECT 1 FROM ${entity.table} WHERE ${entity.table === "tool_calls" ? "call_id" : "id"} = ? AND session_id = ?`).get(entity.id, event.session_id);
  });
  return result;
}
