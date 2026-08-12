import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";
import { DEFAULT_PRICING, type ModelPricing } from "@agent-tracker/shared";
import { seedBuiltinAgentConfig } from "../services/agents";
import { mergeSessionModels } from "../services/ingest";

export type { Database };

let dbInstance: Database | null = null;

export function getDatabase(path: string): Database {
  if (dbInstance) return dbInstance;

  dbInstance = new Database(path, { create: true });
  initializeDatabase(dbInstance);

  return dbInstance;
}

export function initializeDatabase(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  // 先补齐旧表缺失的列，确保 SCHEMA_SQL 中的索引/约束能成功执行。
  ensureSessionsColumns(db);
  ensureMessagesColumns(db);
  ensureTurnsColumns(db);
  ensureToolCallsColumns(db);
  ensurePricingColumns(db);
  ensureCursorConfigColumns(db);
  ensureCursorColumns(db);
  ensureAgentColumns(db);
  db.exec(SCHEMA_SQL);
  migrateSchema(db);
  seedBuiltinAgentConfig(db);
  seedPricing(db);
}

export function resetDatabase(path: string): Database {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  return getDatabase(path);
}

function ensureTableColumns(db: Database, table: string, columns: Array<[string, string]>): void {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=$table").get({ $table: table });
  if (!exists) return;
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const names = new Set(rows.map((c) => c.name));
  for (const [name, definition] of columns) {
    if (!names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** 旧库 sessions 表补列（须在 SCHEMA_SQL 之前执行） */
function ensureSessionsColumns(db: Database): void {
  ensureTableColumns(db, "sessions", [
    ["title", "TEXT"],
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["project_name", "TEXT"],
    ["repo_url", "TEXT"],
    ["branch", "TEXT"],
    ["user_email", "TEXT"],
    ["hostname", "TEXT"],
    ["worktree", "TEXT"],
    ["directory", "TEXT"],
    ["parent_session_id", "TEXT"],
    ["ended_at", "TEXT"],
    ["AISummary", "TEXT"],
    ["request_count", "INTEGER NOT NULL DEFAULT 0"],
    ["total_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_output_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_cost_usd", "REAL NOT NULL DEFAULT 0"],
    ["metadata", "TEXT"],
  ]);
}

function ensureMessagesColumns(db: Database): void {
  ensureTableColumns(db, "messages", [
    ["content", "TEXT"],
    ["model", "TEXT"],
    ["provider", "TEXT"],
    ["parent_message_id", "TEXT"],
    ["tool_calls", "TEXT"],
    ["tool_call_id", "TEXT"],
  ]);
}

function ensureTurnsColumns(db: Database): void {
  ensureTableColumns(db, "turns", [
    ["message_id", "TEXT"],
    ["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["finish_reason", "TEXT"],
    ["error", "TEXT"],
  ]);
}

function ensureToolCallsColumns(db: Database): void {
  ensureTableColumns(db, "tool_calls", [
    ["turn_id", "TEXT"],
    ["args", "TEXT"],
    ["output_title", "TEXT"],
    ["output_metadata", "TEXT"],
    ["output_text", "TEXT"],
    ["file_path", "TEXT"],
    ["language", "TEXT"],
    ["additions", "INTEGER NOT NULL DEFAULT 0"],
    ["deletions", "INTEGER NOT NULL DEFAULT 0"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["error", "TEXT"],
  ]);
}

function ensurePricingColumns(db: Database): void {
  ensureTableColumns(db, "pricing", [
    ["input_price", "REAL NOT NULL DEFAULT 0"],
    ["output_price", "REAL NOT NULL DEFAULT 0"],
    ["cache_read_price", "REAL"],
    ["cache_write_price", "REAL"],
    ["reasoning_price", "REAL"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
}

function ensureCursorConfigColumns(db: Database): void {
  ensureTableColumns(db, "cursor_cookies", [
    ["source", "TEXT"],
    ["jar_encrypted", "TEXT NOT NULL DEFAULT ''"],
    ["updated_at", "TEXT"],
  ]);
  ensureTableColumns(db, "cursor_sync_jobs", [
    ["started_at", "TEXT"],
    ["finished_at", "TEXT"],
    ["status", "TEXT"],
    ["events_count", "INTEGER"],
    ["error", "TEXT"],
    ["range_start", "TEXT"],
    ["range_end", "TEXT"],
  ]);
  ensureTableColumns(db, "cursor_enrich_queue", [
    ["enqueued_at", "TEXT NOT NULL DEFAULT ''"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["last_sync_at", "TEXT"],
    ["error", "TEXT"],
  ]);
}

/** 旧库 cursor_usage_events 表补列（须在 SCHEMA_SQL 之前执行） */
function ensureCursorColumns(db: Database): void {
  ensureTableColumns(db, "cursor_usage_events", [
    ["timestamp", "INTEGER"],
    ["model", "TEXT"],
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_read_tokens", "INTEGER"],
    ["cache_write_tokens", "INTEGER"],
    ["reasoning_tokens", "INTEGER DEFAULT 0"],
    ["cost_usd_cents", "INTEGER"],
    ["is_chargeable", "INTEGER"],
    ["is_headless", "INTEGER"],
    ["raw_json", "TEXT"],
    ["synced_at", "TEXT"],
    ["enriched_at", "TEXT"],
  ]);
}

/** Agent 配置与产物表补列（须在 SCHEMA_SQL 之前执行） */
function ensureAgentColumns(db: Database): void {
  ensureTableColumns(db, "agent_providers", [
    ["name", "TEXT NOT NULL DEFAULT ''"],
    ["type", "TEXT NOT NULL DEFAULT 'openai'"],
    ["base_url", "TEXT NOT NULL DEFAULT ''"],
    ["api_key", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'available'"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "agent_models", [
    ["provider_id", "TEXT NOT NULL DEFAULT 'provider-deepseek-default'"],
    ["label", "TEXT NOT NULL DEFAULT ''"],
    ["model", "TEXT NOT NULL DEFAULT ''"],
    ["purpose", "TEXT"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "agents", [
    ["name", "TEXT NOT NULL DEFAULT ''"],
    ["label", "TEXT NOT NULL DEFAULT ''"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["model_id", "TEXT NOT NULL DEFAULT 'model-deepseek-flash'"],
    ["mode", "TEXT NOT NULL DEFAULT 'ReAct'"],
    ["description", "TEXT"],
    ["tools", "TEXT"],
    ["triggers", "TEXT"],
    ["system_prompt", "TEXT"],
    ["task_brief", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "agent_prompts", [
    ["system_prompt", "TEXT NOT NULL DEFAULT ''"],
    ["task_brief", "TEXT NOT NULL DEFAULT ''"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "agent_jobs", [
    ["agent_id", "TEXT NOT NULL DEFAULT ''"],
    ["status", "TEXT NOT NULL DEFAULT 'running'"],
    ["trigger", "TEXT"],
    ["run_reason", "TEXT"],
    ["target_session_id", "TEXT"],
    ["matter_id", "TEXT"],
    ["candidate_matter_ids", "TEXT"],
    ["started_at", "TEXT NOT NULL DEFAULT ''"],
    ["finished_at", "TEXT"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["provider_id", "TEXT"],
    ["model", "TEXT"],
    ["input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["output_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "REAL NOT NULL DEFAULT 0"],
    ["summary", "TEXT"],
    ["error", "TEXT"],
    ["input_json", "TEXT"],
    ["prompt", "TEXT"],
    ["output_json", "TEXT"],
  ]);
  ensureTableColumns(db, "agent_tool_calls", [
    ["job_id", "TEXT NOT NULL DEFAULT ''"],
    ["tool_name", "TEXT NOT NULL DEFAULT ''"],
    ["state", "TEXT NOT NULL DEFAULT ''"],
    ["detail", "TEXT"],
    ["args", "TEXT"],
    ["result", "TEXT"],
    ["created_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "session_summaries", [
    ["session_id", "TEXT NOT NULL DEFAULT ''"],
    ["job_id", "TEXT"],
    ["title", "TEXT"],
    ["markdown", "TEXT NOT NULL DEFAULT ''"],
    ["prompt_version", "TEXT"],
    ["input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["output_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "REAL NOT NULL DEFAULT 0"],
    ["created_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "matter_archives", [
    ["no", "TEXT NOT NULL DEFAULT ''"],
    ["type", "TEXT NOT NULL DEFAULT 'Feature'"],
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["title", "TEXT NOT NULL DEFAULT ''"],
    ["topic", "TEXT"],
    ["summary", "TEXT"],
    ["result", "TEXT"],
    ["markdown", "TEXT NOT NULL DEFAULT ''"],
    ["effort_level", "TEXT"],
    ["word_target", "INTEGER NOT NULL DEFAULT 600"],
    ["source_session_count", "INTEGER NOT NULL DEFAULT 0"],
    ["dependency_refs", "TEXT"],
    ["timeline_points", "TEXT"],
    ["archived_at", "TEXT"],
    ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ]);
  ensureTableColumns(db, "matter_sessions", [
    ["matter_id", "TEXT NOT NULL DEFAULT ''"],
    ["session_id", "TEXT NOT NULL DEFAULT ''"],
  ]);
}

/** 增量迁移：索引等 SCHEMA_SQL 之后执行 */
function migrateSchema(db: Database): void {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (!exists) return;
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)");
  backfillSessionModelsFromTurns(db);
}

/**
 * 历史会话：sessions.model 只存了首个模型时，从 turns 去重回填为逗号分隔串。
 * 已含逗号的字段视为已迁移，跳过。
 */
function backfillSessionModelsFromTurns(db: Database): void {
  const rows = db.query(`
    SELECT s.id, s.model,
      (
        SELECT GROUP_CONCAT(DISTINCT t.model)
        FROM turns t
        WHERE t.session_id = s.id AND t.model IS NOT NULL AND TRIM(t.model) != ''
      ) AS turn_models
    FROM sessions s
    WHERE EXISTS (
      SELECT 1 FROM turns t
      WHERE t.session_id = s.id AND t.model IS NOT NULL AND TRIM(t.model) != ''
    )
  `).all() as Array<{ id: string; model: string | null; turn_models: string | null }>;

  const update = db.query("UPDATE sessions SET model = $model WHERE id = $id");
  for (const row of rows) {
    if (row.model && String(row.model).includes(",")) continue;
    const merged = mergeSessionModels(row.model, row.turn_models);
    if (!merged || merged === (row.model || null)) continue;
    // 仅当 turns 里确实有多个不同模型时才回写，避免无意义 UPDATE
    const distinct = merged.split(",").map((s) => s.trim()).filter(Boolean);
    if (distinct.length <= 1 && (row.model || "") === (merged || "")) continue;
    if (distinct.length <= 1 && row.model) continue;
    update.run({ $id: row.id, $model: merged });
  }
}

function seedPricing(db: Database): void {
  // 启动时与 DEFAULT_PRICING 对齐（含官方 API 调价）；自定义价可再 PUT /v1/pricing 覆盖
  const stmt = db.query(`
    INSERT INTO pricing (provider, model, input_price, output_price, cache_read_price, cache_write_price, reasoning_price, updated_at)
    VALUES ($provider, $model, $input_price, $output_price, $cache_read_price, $cache_write_price, $reasoning_price, $updated_at)
    ON CONFLICT(provider, model) DO UPDATE SET
      input_price = excluded.input_price,
      output_price = excluded.output_price,
      cache_read_price = excluded.cache_read_price,
      cache_write_price = excluded.cache_write_price,
      reasoning_price = excluded.reasoning_price,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();
  for (const p of DEFAULT_PRICING) {
    stmt.run({
      $provider: p.provider,
      $model: p.model,
      $input_price: p.input_price,
      $output_price: p.output_price,
      $cache_read_price: p.cache_read_price ?? null,
      $cache_write_price: p.cache_write_price ?? null,
      $reasoning_price: p.reasoning_price ?? null,
      $updated_at: now,
    });
  }
}

export function getPricing(db: Database): ModelPricing[] {
  return db.query(`SELECT * FROM pricing`).all() as ModelPricing[];
}
