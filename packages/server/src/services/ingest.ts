import type { Database } from "bun:sqlite";
import type {
  IngestEvent,
  IngestBatchResponse,
  IngestSessionEvent,
  IngestTurnEvent,
  IngestMessageEvent,
  IngestToolResultEvent,
} from "@agent-tracker/shared";
import { isHiddenSessionTitle } from "@agent-tracker/shared";
import { costService } from "./cost";
import { enrichForkSessionMetadata, parseSessionMetadataJson } from "./fork";

/** 将 sessions.model 按逗号拆成去重列表（大小写不敏感，保留首次写法） */
export function splitSessionModels(value: string | null | undefined): string[] {
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

/** 合并已有 model 与新上报 model，去重后用 ", " 连接存储 */
export function mergeSessionModels(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const parts = splitSessionModels(
    [existing, incoming].filter((v) => v != null && String(v).trim() !== "").join(","),
  );
  return parts.length ? parts.join(", ") : null;
}

class IngestService {
  ingestBatch(db: Database, events: IngestEvent[]): IngestBatchResponse {
    const result: IngestBatchResponse = { ingested: 0, errors: [] };

    const insertSessionStmt = db.query(`
      INSERT OR IGNORE INTO sessions
      (id, agent, title, provider, model, project_name, repo_url, branch, user_email, hostname, worktree, directory, parent_session_id, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd, metadata)
      VALUES ($id, $agent, $title, $provider, $model, $project_name, $repo_url, $branch, $user_email, $hostname, $worktree, $directory, $parent_session_id, $started_at, 0, 0, 0, 0, 0, $metadata)
    `);

    const updateSessionStmt = db.query(`
      UPDATE sessions SET
        agent = COALESCE($agent, agent),
        title = CASE
          WHEN title IS NOT NULL AND TRIM(title) != '' THEN title
          ELSE COALESCE($title, title)
        END,
        provider = COALESCE($provider, provider),
        project_name = COALESCE($project_name, project_name),
        repo_url = COALESCE($repo_url, repo_url),
        branch = COALESCE($branch, branch),
        user_email = COALESCE($user_email, user_email),
        hostname = COALESCE($hostname, hostname),
        worktree = COALESCE($worktree, worktree),
        directory = COALESCE($directory, directory),
        parent_session_id = COALESCE($parent_session_id, parent_session_id),
        metadata = COALESCE($metadata, metadata)
      WHERE id = $id
    `);

    const endSessionStmt = db.query(`
      UPDATE sessions SET ended_at = $ended_at, request_count = $request_count WHERE id = $id
    `);

    const syncSessionTotalsStmt = db.query(`
      UPDATE sessions SET
        total_cost_usd = CASE WHEN $session_cost_usd IS NOT NULL AND $session_cost_usd > total_cost_usd THEN $session_cost_usd ELSE total_cost_usd END,
        total_input_tokens = CASE WHEN $session_input_tokens IS NOT NULL AND $session_input_tokens > total_input_tokens THEN $session_input_tokens ELSE total_input_tokens END,
        total_output_tokens = CASE WHEN $session_output_tokens IS NOT NULL AND $session_output_tokens > total_output_tokens THEN $session_output_tokens ELSE total_output_tokens END,
        total_tokens = CASE WHEN $session_total_tokens IS NOT NULL AND $session_total_tokens > total_tokens THEN $session_total_tokens ELSE total_tokens END
      WHERE id = $id
    `);

    const insertTurnStmt = db.query(`
      INSERT OR IGNORE INTO turns
      (id, session_id, message_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, finish_reason, error, created_at)
      VALUES ($id, $session_id, $message_id, $model, $provider, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $reasoning_tokens, $total_tokens, $duration_ms, $cost_usd, $finish_reason, $error, $created_at)
    `);

    const insertMessageStmt = db.query(`
      INSERT OR IGNORE INTO messages
      (id, session_id, role, content, model, provider, parent_message_id, tool_calls, tool_call_id, created_at)
      VALUES ($id, $session_id, $role, $content, $model, $provider, $parent_message_id, $tool_calls, $tool_call_id, $created_at)
    `);

    const insertToolStmt = db.query(`
      INSERT INTO tool_calls
      (id, session_id, turn_id, tool_name, call_id, args, output_title, output_metadata, output_text, file_path, language, additions, deletions, duration_ms, error, created_at)
      VALUES ($id, $session_id, $turn_id, $tool_name, $call_id, $args, $output_title, $output_metadata, $output_text, $file_path, $language, $additions, $deletions, $duration_ms, $error, $created_at)
    `);

    const hasToolCallStmt = db.query(`
      SELECT 1 FROM tool_calls WHERE session_id = $session_id AND call_id = $call_id LIMIT 1
    `);

    const bumpSessionStmt = db.query(`
      UPDATE sessions SET
        request_count = request_count + $request_count,
        total_input_tokens = total_input_tokens + $input_tokens,
        total_output_tokens = total_output_tokens + $output_tokens,
        total_tokens = total_tokens + $total_tokens,
        total_cost_usd = total_cost_usd + $cost_usd
      WHERE id = $id
    `);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      try {
        switch (ev.type) {
          case "session.created":
          case "session.updated": {
            const e = ev as IngestSessionEvent;
            // OpenCode SmartFetch 临时会话：与 OpenChamber 一致，不入库
            if (isHiddenSessionTitle(e.title)) break;
            const now = new Date().toISOString();
            const forkMeta = enrichForkSessionMetadata(
              db,
              e.session_id,
              e.title ?? null,
              { ...parseSessionMetadataJson(e.metadata), ...e.metadata },
            );
            const metadataJson = forkMeta ? JSON.stringify(forkMeta) : (e.metadata ? JSON.stringify(e.metadata) : null);
            insertSessionStmt.run({
              $id: e.session_id,
              $agent: e.agent,
              $title: e.title ?? null,
              $provider: e.provider ?? null,
              $model: mergeSessionModels(null, e.model ?? null),
              $project_name: e.project_name ?? null,
              $repo_url: e.repo_url ?? null,
              $branch: e.branch ?? null,
              $user_email: e.user_email ?? null,
              $hostname: e.hostname ?? null,
              $worktree: e.worktree ?? null,
              $directory: e.directory ?? null,
              $parent_session_id: e.parent_session_id ?? null,
              $started_at: now,
              $metadata: metadataJson,
            });
            updateSessionStmt.run({
              $id: e.session_id,
              $agent: e.agent ?? null,
              $title: e.title ?? null,
              $provider: e.provider ?? null,
              $project_name: e.project_name ?? null,
              $repo_url: e.repo_url ?? null,
              $branch: e.branch ?? null,
              $user_email: e.user_email ?? null,
              $hostname: e.hostname ?? null,
              $worktree: e.worktree ?? null,
              $directory: e.directory ?? null,
              $parent_session_id: e.parent_session_id ?? null,
              $metadata: metadataJson,
            });
            // model 单独去重追加（逗号分隔），避免 COALESCE 只保留首个模型
            this.appendSessionModel(db, e.session_id, e.model);
            if (
              e.session_cost_usd != null ||
              e.session_input_tokens != null ||
              e.session_output_tokens != null ||
              e.session_total_tokens != null
            ) {
              syncSessionTotalsStmt.run({
                $id: e.session_id,
                $session_cost_usd: e.session_cost_usd ?? null,
                $session_input_tokens: e.session_input_tokens ?? null,
                $session_output_tokens: e.session_output_tokens ?? null,
                $session_total_tokens: e.session_total_tokens ?? null,
              });
            }
            break;
          }

          case "session.idle":
          case "session.compacted": {
            const e = ev as IngestSessionEvent;
            this.ensureSession(db, e.session_id, {
              agent: e.agent,
              title: e.title ?? null,
              provider: e.provider ?? null,
              model: e.model ?? null,
              project_name: e.project_name ?? null,
              repo_url: e.repo_url ?? null,
              branch: e.branch ?? null,
              user_email: e.user_email ?? null,
              hostname: e.hostname ?? null,
              worktree: e.worktree ?? null,
              directory: e.directory ?? null,
              parent_session_id: e.parent_session_id ?? null,
              metadata: e.metadata ? JSON.stringify(e.metadata) : null,
            });
            endSessionStmt.run({
              $id: e.session_id,
              $ended_at: e.ended_at ?? new Date().toISOString(),
              $request_count: e.request_count ?? 0,
            });
            if (
              e.session_cost_usd != null ||
              e.session_input_tokens != null ||
              e.session_output_tokens != null ||
              e.session_total_tokens != null
            ) {
              syncSessionTotalsStmt.run({
                $id: e.session_id,
                $session_cost_usd: e.session_cost_usd ?? null,
                $session_input_tokens: e.session_input_tokens ?? null,
                $session_output_tokens: e.session_output_tokens ?? null,
                $session_total_tokens: e.session_total_tokens ?? null,
              });
            }
            break;
          }

          case "turn.completed":
          case "turn.error": {
            const e = ev as IngestTurnEvent;
            this.ensureSession(db, e.session_id, {
              // turn 早于 session.created 时按 provider 推断 agent，避免误标 opencode
              agent: e.provider === "cursor" || e.provider === "codex" ? e.provider : undefined,
              provider: e.provider,
              model: e.model,
              started_at: e.created_at,
            });
            const cost = costService.resolveTurnCost(e.provider, e.model, {
              input_tokens: e.input_tokens,
              output_tokens: e.output_tokens,
              cache_read_tokens: e.cache_read_tokens,
              cache_write_tokens: e.cache_write_tokens,
              reasoning_tokens: e.reasoning_tokens,
            }, e.cost_usd);

            insertTurnStmt.run({
              $id: e.turn_id,
              $session_id: e.session_id,
              $message_id: e.message_id ?? null,
              $model: e.model,
              $provider: e.provider,
              $input_tokens: e.input_tokens,
              $output_tokens: e.output_tokens,
              $cache_read_tokens: e.cache_read_tokens ?? 0,
              $cache_write_tokens: e.cache_write_tokens ?? 0,
              $reasoning_tokens: e.reasoning_tokens ?? 0,
              $total_tokens: e.total_tokens,
              $duration_ms: e.duration_ms,
              $cost_usd: cost,
              $finish_reason: e.finish_reason ?? null,
              $error: e.error ?? null,
              $created_at: e.created_at,
            });

            const inserted = (db.query("SELECT changes() as c").get() as any)?.c === 1;
            if (inserted) {
              bumpSessionStmt.run({
                $id: e.session_id,
                $request_count: 1,
                $input_tokens: e.input_tokens,
                $output_tokens: e.output_tokens,
                $total_tokens: e.total_tokens,
                $cost_usd: cost,
              });
            } else {
              // 已有 turn：回写 Abort / Error 终态（Cursor stop 与 afterAgentResponse 同 turn_id）
              if (e.error || e.finish_reason) {
                db.query(`
                  UPDATE turns
                  SET finish_reason = COALESCE($finish_reason, finish_reason),
                      error = COALESCE($error, error),
                      message_id = COALESCE(message_id, $message_id)
                  WHERE id = $turn_id
                `).run({
                  $turn_id: e.turn_id,
                  $finish_reason: e.finish_reason ?? null,
                  $error: e.error ?? null,
                  $message_id: e.message_id ?? null,
                });
              }
              // 已有 turn 但 cost 为 0：用最新定价回填（如补 glm 定价后重报）
              if (cost > 0) {
                const existingCost = db
                  .query("SELECT cost_usd, provider FROM turns WHERE id = $turn_id")
                  .get({ $turn_id: e.turn_id }) as { cost_usd?: number; provider?: string } | null;
                if (existingCost && Number(existingCost.cost_usd ?? 0) <= 0) {
                  db.query(`
                    UPDATE turns
                    SET cost_usd = $cost_usd,
                        provider = CASE
                          WHEN provider IS NULL OR provider = '' OR provider = 'unknown'
                          THEN $provider ELSE provider END
                    WHERE id = $turn_id
                  `).run({
                    $turn_id: e.turn_id,
                    $cost_usd: cost,
                    $provider: e.provider,
                  });
                  db.query(`
                    UPDATE sessions
                    SET total_cost_usd = total_cost_usd + $cost_usd
                    WHERE id = $id
                  `).run({ $id: e.session_id, $cost_usd: cost });
                }
              }
              const existing = db.query("SELECT session_id FROM turns WHERE id = $turn_id").get({ $turn_id: e.turn_id }) as any;
              if (existing && existing.session_id !== e.session_id) {
                const cur = db.query("SELECT parent_session_id FROM sessions WHERE id = $id").get({ $id: e.session_id }) as any;
                if (cur && cur.parent_session_id === null) {
                  db.query("UPDATE sessions SET parent_session_id = $parent WHERE id = $id").run({ $parent: existing.session_id, $id: e.session_id });
                }
              }
            }
            break;
          }

          case "message": {
            const e = ev as IngestMessageEvent;
            this.ensureSession(db, e.session_id, {
              agent: e.provider === "cursor" || e.provider === "codex" ? e.provider : undefined,
              provider: e.provider ?? null,
              model: e.model ?? null,
              started_at: e.created_at,
            });
            insertMessageStmt.run({
              $id: e.message_id,
              $session_id: e.session_id,
              $role: e.role,
              $content: typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? {}),
              $model: e.model ?? null,
              $provider: e.provider ?? null,
              $parent_message_id: e.parent_message_id ?? null,
              $tool_calls: e.tool_calls ? JSON.stringify(e.tool_calls) : null,
              $tool_call_id: e.tool_call_id ?? null,
              $created_at: e.created_at,
            });
            // Cursor assistant 消息同步占位 turn，供 Usage 对账 UPDATE cost（与 Hook 双路径一致）
            if (e.role === "assistant" && e.provider === "cursor") {
              insertTurnStmt.run({
                $id: e.message_id,
                $session_id: e.session_id,
                $message_id: e.message_id,
                $model: e.model ?? "unknown",
                $provider: e.provider,
                $input_tokens: 0,
                $output_tokens: 0,
                $cache_read_tokens: 0,
                $cache_write_tokens: 0,
                $reasoning_tokens: 0,
                $total_tokens: 0,
                $duration_ms: 0,
                $cost_usd: 0,
                $finish_reason: null,
                $error: null,
                $created_at: e.created_at,
              });
            }
            break;
          }

          case "tool.result": {
            const e = ev as IngestToolResultEvent;
            this.ensureSession(db, e.session_id, {
              agent: e.agent ?? undefined,
              started_at: e.created_at,
            });
            if (hasToolCallStmt.get({ $session_id: e.session_id, $call_id: e.call_id })) break;
            // turn_id 指向不存在的 turns 行时置 null，避免 tool_calls FK 失败留下空 session 壳
            let turnId: string | null = e.turn_id ?? null;
            if (turnId) {
              const turnExists = db.query("SELECT 1 AS ok FROM turns WHERE id = $id LIMIT 1").get({ $id: turnId });
              if (!turnExists) turnId = null;
            }
            insertToolStmt.run({
              $id: crypto.randomUUID(),
              $session_id: e.session_id,
              $turn_id: turnId,
              $tool_name: e.tool_name,
              $call_id: e.call_id,
              $args: e.args ? JSON.stringify(e.args) : null,
              $output_title: e.output_title ?? null,
              $output_metadata: e.output_metadata ? JSON.stringify(e.output_metadata) : null,
              $output_text: e.output_text ?? null,
              $file_path: e.file_path ?? null,
              $language: e.language ?? null,
              $additions: e.additions ?? 0,
              $deletions: e.deletions ?? 0,
              $duration_ms: e.duration_ms,
              $error: e.error ?? null,
              $created_at: e.created_at,
            });
            break;
          }
        }

        result.ingested++;
      } catch (err: any) {
        result.errors.push({ index: i, error: err?.message ?? String(err) });
      }
    }

    return result;
  }

  /** 将新 model 去重追加到 sessions.model（逗号分隔存储） */
  private appendSessionModel(db: Database, sessionId: string, model: string | null | undefined): void {
    const incoming = String(model || "").trim();
    if (!incoming) return;
    const row = db.query("SELECT model FROM sessions WHERE id = $id").get({ $id: sessionId }) as
      | { model?: string | null }
      | null;
    if (!row) return;
    const merged = mergeSessionModels(row.model, incoming);
    if (!merged || merged === (row.model || null)) return;
    db.query("UPDATE sessions SET model = $model WHERE id = $id").run({
      $id: sessionId,
      $model: merged,
    });
  }

  /** Upsert session — child events may arrive before session.created */
  private ensureSession(
    db: Database,
    sessionId: string,
    hints?: {
      agent?: string;
      title?: string | null;
      provider?: string | null;
      model?: string | null;
      project_name?: string | null;
      repo_url?: string | null;
      branch?: string | null;
      user_email?: string | null;
      hostname?: string | null;
      worktree?: string | null;
      directory?: string | null;
      parent_session_id?: string | null;
      started_at?: string;
      metadata?: string | null;
    },
  ): void {
    const existing = db.query("SELECT 1 FROM sessions WHERE id = $id").get({ $id: sessionId });
    if (existing) {
      if (!hints) return;
      db.query(`
        UPDATE sessions SET
          agent = COALESCE($agent, agent),
          title = CASE
            WHEN title IS NOT NULL AND TRIM(title) != '' THEN title
            ELSE COALESCE($title, title)
          END,
          provider = COALESCE($provider, provider),
          project_name = COALESCE($project_name, project_name),
          repo_url = COALESCE($repo_url, repo_url),
          branch = COALESCE($branch, branch),
          user_email = COALESCE($user_email, user_email),
          hostname = COALESCE($hostname, hostname),
          worktree = COALESCE($worktree, worktree),
          directory = COALESCE($directory, directory),
          parent_session_id = COALESCE($parent_session_id, parent_session_id),
          metadata = COALESCE($metadata, metadata)
        WHERE id = $id
      `).run({
        $id: sessionId,
        $agent: hints.agent ?? null,
        $title: hints.title ?? null,
        $provider: hints.provider ?? null,
        $project_name: hints.project_name ?? null,
        $repo_url: hints.repo_url ?? null,
        $branch: hints.branch ?? null,
        $user_email: hints.user_email ?? null,
        $hostname: hints.hostname ?? null,
        $worktree: hints.worktree ?? null,
        $directory: hints.directory ?? null,
        $parent_session_id: hints.parent_session_id ?? null,
        $metadata: hints.metadata ?? null,
      });
      // turn / message 上报的 model 去重追加进 sessions.model
      this.appendSessionModel(db, sessionId, hints.model);
      return;
    }

    const now = hints?.started_at ?? new Date().toISOString();
    db.query(`
      INSERT INTO sessions
      (id, agent, title, provider, model, project_name, repo_url, branch, user_email, hostname, worktree, directory, parent_session_id, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd, metadata)
      VALUES ($id, $agent, $title, $provider, $model, $project_name, $repo_url, $branch, $user_email, $hostname, $worktree, $directory, $parent_session_id, $started_at, 0, 0, 0, 0, 0, $metadata)
    `).run({
      $id: sessionId,
      // 子事件早到时不得默认成 opencode（Cursor tool.result 曾因此被误标）
      $agent: hints?.agent ?? "unknown",
      $title: hints?.title ?? null,
      $provider: hints?.provider ?? null,
      $model: mergeSessionModels(null, hints?.model ?? null),
      $project_name: hints?.project_name ?? null,
      $repo_url: hints?.repo_url ?? null,
      $branch: hints?.branch ?? null,
      $user_email: hints?.user_email ?? null,
      $hostname: hints?.hostname ?? null,
      $worktree: hints?.worktree ?? null,
      $directory: hints?.directory ?? null,
      $parent_session_id: hints?.parent_session_id ?? null,
      $started_at: now,
      $metadata: hints?.metadata ?? null,
    });
  }
}

export const ingestService = new IngestService();
