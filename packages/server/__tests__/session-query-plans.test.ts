import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_SQL } from "../src/db/schema";
import { initializeDatabase } from "../src/db";
import { createSessionsRoute, createStatsRoute } from "../src/routes/sessions";

let db: Database;
let app: Hono;
let observed: string[];
let prepare: Database["query"];

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO sessions (id, agent, started_at, ended_at, total_tokens, total_cost_usd, parent_session_id) VALUES
      ('history', 'yuri', '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 100, 1, NULL),
      ('ended', 'opencode', '2026-11-02T00:00:00.000Z', '2026-11-09T00:00:00.000Z', 200, 2, NULL),
      ('child', 'yuri', '2026-11-04T00:00:00.000Z', NULL, 300, 3, 'history'),
      ('empty', 'opencode', '2026-11-10T00:00:00.000Z', NULL, 0, 0, NULL);
    INSERT INTO messages (id, session_id, role, content, created_at) VALUES
      ('later', 'history', 'user', 'later', '2026-11-08T00:00:00.000Z'),
      ('earlier', 'history', 'user', 'earlier', '2026-11-01T01:00:00.000Z'),
      ('ended-message', 'ended', 'user', 'ended', '2026-11-04T00:00:00.000Z');
    INSERT INTO turns (id, session_id, model, provider, total_tokens, cost_usd, created_at) VALUES
      ('turn', 'history', 'test', 'test', 100, 1, '2026-11-06T00:00:00.000Z'),
      ('old-turn', 'history', 'test', 'test', 50, 0.5, '2026-10-30T00:00:00.000Z');
    INSERT INTO tool_calls (id, session_id, tool_name, call_id, created_at) VALUES
      ('tool', 'history', 'test', 'call', '2026-11-02T00:00:00.000Z');
  `);
  observed = [];
  prepare = db.query.bind(db);
  Object.defineProperty(db, "query", { value: (sql: string) => {
    observed.push(sql);
    return prepare(sql);
  } });
  app = new Hono().route("/", createSessionsRoute(db)).route("/", createStatsRoute(db));
});
afterEach(() => db.close());

function plan(sql: string, params: Record<string, string | number | null>) {
  return (prepare("EXPLAIN QUERY PLAN " + sql).all(params) as Array<{ detail: string }>).map(row => row.detail).join("\n");
}

test("startup migrates existing databases with session/time indexes and is safe to repeat", () => {
  const indexes = {
    idx_sessions_parent_started_at: ["parent_session_id", "started_at"],
    idx_messages_session_created_at: ["session_id", "created_at"],
    idx_turns_session_created_at: ["session_id", "created_at"],
    idx_tool_calls_session_created_at: ["session_id", "created_at"],
  };
  for (const name of Object.keys(indexes)) db.exec(`DROP INDEX ${name}`);
  const snapshot = () => ({
    sessions: prepare("SELECT id, agent, started_at, ended_at, total_tokens, total_cost_usd FROM sessions ORDER BY id").all(),
    messages: prepare("SELECT * FROM messages ORDER BY id").all(),
    turns: prepare("SELECT * FROM turns ORDER BY id").all(),
    tools: prepare("SELECT * FROM tool_calls ORDER BY id").all(),
  });
  const before = snapshot();
  for (let startup = 0; startup < 2; startup++) {
    initializeDatabase(db);
    for (const [name, columns] of Object.entries(indexes)) {
      const rows = prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>;
      expect(rows.map(row => row.name)).toEqual(columns);
    }
    expect(snapshot()).toEqual(before);
  }
});

test.each(["messages", "turns", "tool-calls"])("session %s reads ordered history directly from a session/time index", async (endpoint) => {
  const response = await app.request(`/v1/sessions/history/${endpoint}`);
  expect(response.status).toBe(200);
  const sql = observed.find(sql => sql.includes("ORDER BY created_at ASC"))!;
  expect(sql).toBeDefined();
  const params = endpoint === "messages" ? { $id: "history", $limit: 100, $offset: 0 } : { $id: "history" };
  const detail = plan(sql, params);
  expect(detail).not.toContain("TEMP B-TREE");
  expect(detail).toContain("session_created_at");
  if (endpoint === "messages") expect((await response.json()).map((row: any) => row.id)).toEqual(["earlier", "later"]);
});

test("session list looks up the last timestamp instead of enumerating each session's whole history", async () => {
  const response = await app.request("/v1/sessions");
  expect(response.status).toBe(200);
  const rows = await response.json();
  expect(rows.map((row: any) => row.id)).toEqual(["ended", "history"]);
  expect(rows[1].last_activity_at).toBe("2026-11-08T00:00:00.000Z");
  const sql = observed.find(sql => sql.includes("SELECT * FROM sessions WHERE parent_session_id IS NULL"))!;
  expect(sql).toContain("SELECT MAX(created_at) AS t FROM messages");
  expect(sql).toContain("SELECT MAX(created_at) AS t FROM turns");
  const detail = plan(sql, { $limit: 50, $offset: 0 });
  expect(detail).toContain("COVERING INDEX idx_messages_session_created_at");
  expect(detail).toContain("COVERING INDEX idx_turns_session_created_at");
});

test("session details use covering indexes for first/last activity and avoid sorting child sessions", async () => {
  expect((await app.request("/v1/sessions/history")).status).toBe(200);
  const activity = observed.filter(sql => /SELECT (MIN|MAX)\(created_at\)/.test(sql));
  expect(activity).toHaveLength(4);
  for (const sql of activity) expect(plan(sql, { $id: "history" })).toContain("COVERING INDEX");
  observed.length = 0;
  expect((await app.request("/v1/sessions/history/children")).status).toBe(200);
  const sql = observed.find(sql => sql.includes("ORDER BY started_at ASC"))!;
  expect(plan(sql, { $id: "history" })).not.toContain("TEMP B-TREE");
});

test.each(["summary", "by-model", "daily"])("bounded %s statistics use time indexes rather than scanning all history", async (endpoint) => {
  const response = await app.request(`/v1/stats/${endpoint}?range=custom&from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z`);
  expect(response.status).toBe(200);
  const queries = observed.filter(sql => /FROM turns(?:\s|$)/.test(sql));
  expect(queries.length).toBeGreaterThan(0);
  for (const sql of queries) {
    const detail = plan(sql, { $from: "2026-11-01T00:00:00.000Z", $to: "2026-11-30T23:59:59.000Z" });
    expect(detail).toContain("SEARCH");
    expect(detail).not.toMatch(/SCAN (?:turns|t)\b/);
  }
  if (endpoint === "summary") expect(await response.json()).toMatchObject({ turns: 1, tokens: { total: 100 }, cost_usd: 1 });
});

test("all-time statistics still include every timestamp and retain their totals", async () => {
  const response = await app.request("/v1/stats/summary?range=all");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ turns: 2, tokens: { total: 150 }, cost_usd: 1.5 });
});
