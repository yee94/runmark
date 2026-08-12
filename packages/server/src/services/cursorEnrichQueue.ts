/**
 * Cursor 会话对账队列。
 * Hook 上报的 session_id 为归属依据；Usage API 拉到的账单按队列顺序补充 cost。
 */

import type { Database } from "bun:sqlite";

export type CursorEnrichQueueStatus = "pending" | "syncing" | "done";

export interface CursorEnrichQueueRow {
  session_id: string;
  enqueued_at: string;
  status: CursorEnrichQueueStatus;
  last_sync_at?: string | null;
  error?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 将 Hook 上报的 cursor 会话加入对账队列（已存在则刷新 pending） */
export function enqueueCursorSessions(db: Database, sessionIds: string[]): number {
  if (!sessionIds.length) return 0;

  const placeholders = sessionIds.map(() => "?").join(", ");
  const cursorRows = db.query(`
    SELECT id FROM sessions WHERE agent = 'cursor' AND id IN (${placeholders})
  `).all(...sessionIds) as Array<{ id: string }>;

  if (!cursorRows.length) return 0;

  const stmt = db.query(`
    INSERT INTO cursor_enrich_queue (session_id, enqueued_at, status)
    VALUES ($session_id, $enqueued_at, 'pending')
    ON CONFLICT(session_id) DO UPDATE SET
      enqueued_at = excluded.enqueued_at,
      status = CASE
        WHEN cursor_enrich_queue.status = 'syncing' THEN 'syncing'
        ELSE 'pending'
      END,
      error = NULL
  `);

  const at = nowIso();
  for (const row of cursorRows) {
    stmt.run({ $session_id: row.id, $enqueued_at: at });
  }
  return cursorRows.length;
}

/** 将近期所有 cursor 会话批量入队（全量同步后补历史对账） */
export function enqueueRecentCursorSessions(db: Database, sinceIso: string): number {
  const rows = db.query(`
    SELECT id FROM sessions
    WHERE agent = 'cursor' AND datetime(started_at) >= datetime($since)
    ORDER BY started_at ASC
  `).all({ $since: sinceIso }) as Array<{ id: string }>;

  return enqueueCursorSessions(db, rows.map((r) => r.id));
}

/** 取下一条待处理会话（按入队时间 FIFO） */
export function dequeueNextPending(db: Database): CursorEnrichQueueRow | null {
  return db.query(`
    SELECT session_id, enqueued_at, status, last_sync_at, error
    FROM cursor_enrich_queue
    WHERE status = 'pending'
    ORDER BY enqueued_at ASC
    LIMIT 1
  `).get() as CursorEnrichQueueRow | null;
}

export function markQueueSyncing(db: Database, sessionId: string): void {
  db.query(`
    UPDATE cursor_enrich_queue
    SET status = 'syncing', error = NULL
    WHERE session_id = $session_id
  `).run({ $session_id: sessionId });
}

export function markQueueDone(db: Database, sessionId: string): void {
  db.query(`
    UPDATE cursor_enrich_queue
    SET status = 'done', last_sync_at = $at, error = NULL
    WHERE session_id = $session_id
  `).run({ $session_id: sessionId, $at: nowIso() });
}

export function markQueueFailed(db: Database, sessionId: string, error: string): void {
  db.query(`
    UPDATE cursor_enrich_queue
    SET status = 'pending', error = $error
    WHERE session_id = $session_id
  `).run({ $session_id: sessionId, $error: error });
}

export function hasPendingQueue(db: Database): boolean {
  const row = db.query(`
    SELECT 1 AS ok FROM cursor_enrich_queue WHERE status = 'pending' LIMIT 1
  `).get() as { ok: number } | undefined;
  return !!row?.ok;
}

export function countPendingQueue(db: Database): number {
  const row = db.query(`
    SELECT COUNT(*) AS c FROM cursor_enrich_queue WHERE status = 'pending'
  `).get() as { c: number };
  return row.c;
}

/** syncing 期间若再次上报，结束后需重新处理 */
export function isSessionRequeued(db: Database, sessionId: string): boolean {
  const row = db.query(`
    SELECT enqueued_at, last_sync_at
    FROM cursor_enrich_queue
    WHERE session_id = $session_id AND status IN ('syncing', 'done')
  `).get({ $session_id: sessionId }) as { enqueued_at: string; last_sync_at: string | null } | undefined;

  if (!row?.last_sync_at) return false;
  return row.enqueued_at > row.last_sync_at;
}

export function requeueSessionIfNeeded(db: Database, sessionId: string): void {
  if (!isSessionRequeued(db, sessionId)) return;
  db.query(`
    UPDATE cursor_enrich_queue SET status = 'pending' WHERE session_id = $session_id
  `).run({ $session_id: sessionId });
}
