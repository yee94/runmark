/**
 * SQLite schema definitions (mirrors shared types for persistent storage).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  title TEXT,
  provider TEXT,
  model TEXT,
  project_name TEXT,
  repo_url TEXT,
  branch TEXT,
  user_email TEXT,
  hostname TEXT,
  worktree TEXT,
  directory TEXT,
  parent_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  AISummary TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_email ON sessions(user_email);
CREATE INDEX IF NOT EXISTS idx_sessions_repo_url ON sessions(repo_url);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  model TEXT,
  provider TEXT,
  parent_message_id TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  finish_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  tool_name TEXT NOT NULL,
  call_id TEXT NOT NULL,
  args TEXT,
  output_title TEXT,
  output_metadata TEXT,
  output_text TEXT,
  file_path TEXT,
  language TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_id ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_call_id ON tool_calls(session_id, call_id);

CREATE TABLE IF NOT EXISTS pricing (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_price REAL NOT NULL DEFAULT 0,
  output_price REAL NOT NULL DEFAULT 0,
  cache_read_price REAL,
  cache_write_price REAL,
  reasoning_price REAL,
  context_tiers TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS cursor_cookies (
  id INTEGER PRIMARY KEY,
  source TEXT,
  jar_encrypted TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS cursor_usage_events (
  event_id TEXT PRIMARY KEY,
  timestamp INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER DEFAULT 0,
  cost_usd_cents INTEGER,
  is_chargeable INTEGER,
  is_headless INTEGER,
  raw_json TEXT,
  synced_at TEXT,
  enriched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cursor_events_timestamp ON cursor_usage_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_cursor_events_enriched ON cursor_usage_events(enriched_at);

CREATE TABLE IF NOT EXISTS cursor_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  events_count INTEGER,
  error TEXT,
  range_start TEXT,
  range_end TEXT
);

/** Hook 上报会话的对账队列；归属以 session_id 为准，Usage API 仅补充 cost */
CREATE TABLE IF NOT EXISTS cursor_enrich_queue (
  session_id TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_sync_at TEXT,
  error TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cursor_enrich_queue_status ON cursor_enrich_queue(status, enqueued_at);

CREATE TABLE IF NOT EXISTS agent_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES agent_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ReAct',
  description TEXT,
  tools TEXT,
  triggers TEXT,
  system_prompt TEXT,
  task_brief TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES agent_models(id)
);

CREATE TABLE IF NOT EXISTS agent_prompts (
  agent_id TEXT PRIMARY KEY,
  system_prompt TEXT NOT NULL,
  task_brief TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT,
  run_reason TEXT,
  target_session_id TEXT,
  matter_id TEXT,
  candidate_matter_ids TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  input_json TEXT,
  prompt TEXT,
  output_json TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (target_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (matter_id) REFERENCES matter_archives(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_started_at ON agent_jobs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_id ON agent_jobs(agent_id, started_at);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  args TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_job_id ON agent_tool_calls(job_id);

CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  job_id TEXT,
  title TEXT,
  markdown TEXT NOT NULL,
  prompt_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session_id ON session_summaries(session_id, created_at);

CREATE TABLE IF NOT EXISTS matter_archives (
  id TEXT PRIMARY KEY,
  no TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  topic TEXT,
  summary TEXT,
  result TEXT,
  markdown TEXT NOT NULL,
  effort_level TEXT,
  word_target INTEGER NOT NULL DEFAULT 600,
  source_session_count INTEGER NOT NULL DEFAULT 0,
  dependency_refs TEXT,
  timeline_points TEXT,
  archived_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matter_archives_updated_at ON matter_archives(updated_at);
CREATE INDEX IF NOT EXISTS idx_matter_archives_status ON matter_archives(status, updated_at);

CREATE TABLE IF NOT EXISTS matter_sessions (
  matter_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (matter_id, session_id),
  FOREIGN KEY (matter_id) REFERENCES matter_archives(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_matter_sessions_session_id ON matter_sessions(session_id);

CREATE TABLE IF NOT EXISTS session_shares (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  trace_types TEXT NOT NULL DEFAULT '',
  node_key TEXT,
  child_session_id TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_shares_session_id ON session_shares(session_id);
CREATE INDEX IF NOT EXISTS idx_session_shares_expires_at ON session_shares(expires_at);
`;
