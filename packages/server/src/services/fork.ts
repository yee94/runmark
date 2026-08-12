import type { Database } from "bun:sqlite";
import { forkSourceTitle, isForkSessionTitle } from "@agent-tracker/shared";

/** 解析 DB / ingest 中的 metadata JSON */
export function parseSessionMetadataJson(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 按来源 title 查找 fork 父会话（排除自身与其它 fork 行） */
export function resolveForkParentSessionId(
  db: Database,
  sessionId: string,
  sourceTitle: string,
): string | null {
  const row = db.query(
    `SELECT id FROM sessions
     WHERE title = $title AND id != $id
       AND (title IS NULL OR title NOT LIKE '%(fork #%')
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get({ $title: sourceTitle, $id: sessionId }) as { id?: string } | null;
  return row?.id ?? null;
}

/** fork 会话 metadata 补全：is_fork / fork_source_title / fork_parent_session_id */
export function enrichForkSessionMetadata(
  db: Database,
  sessionId: string,
  title: string | null | undefined,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!isForkSessionTitle(title)) return existing ?? null;

  const meta: Record<string, unknown> = { ...(existing ?? {}) };
  meta.is_fork = true;
  const sourceTitle = forkSourceTitle(title);
  if (sourceTitle) meta.fork_source_title = sourceTitle;

  if (!meta.fork_parent_session_id && sourceTitle) {
    const parentId = resolveForkParentSessionId(db, sessionId, sourceTitle);
    if (parentId) meta.fork_parent_session_id = parentId;
  }

  return meta;
}

/** 序列化时暴露 fork 字段，旧数据按 title 懒解析父会话 */
export function forkFieldsForSession(
  db: Database,
  row: { id: string; title?: string | null; metadata?: unknown },
) {
  const meta = enrichForkSessionMetadata(db, row.id, row.title, parseSessionMetadataJson(row.metadata)) ?? {};
  return {
    is_fork: meta.is_fork === true,
    fork_source_title: (meta.fork_source_title as string | undefined) ?? null,
    fork_parent_session_id: (meta.fork_parent_session_id as string | undefined) ?? null,
  };
}
