import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { createIngestRoute } from "../src/routes/ingest";
import { createSessionsRoute, createTurnsRoute, createStatsRoute } from "../src/routes/sessions";
import { ingestService } from "../src/services/ingest";
import { costService } from "../src/services/cost";
import type { IngestEvent, ModelPricing } from "@agent-tracker/shared";
import { USD_TO_CNY } from "@agent-tracker/shared";

describe("API integration", () => {
  let db: Database;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);

    const pricing: ModelPricing[] = [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        input_price: 3.0,
        output_price: 15.0,
      },
    ];
    costService.setPricing(pricing);

    app = new Hono();
    app.route("/", createIngestRoute(db));
    app.route("/", createSessionsRoute(db));
    app.route("/", createTurnsRoute(db));
    app.route("/", createStatsRoute(db));
  });

  it("POST /v1/ingest → GET /v1/sessions", async () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        user_email: "user@test.com",
      },
      {
        type: "message",
        session_id: "s-1",
        message_id: "m-list-1",
        role: "user",
        content: "hi",
        created_at: new Date().toISOString(),
      },
    ];

    const ingestRes = await app.request("/v1/ingest", {
      method: "POST",
      body: JSON.stringify({ events }),
      headers: { "Content-Type": "application/json" },
    });
    expect(ingestRes.status).toBe(200);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.ingested).toBe(2);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("s-1");
  });

  it("GET /v1/sessions hides empty shells without messages/turns/tools", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES
        ('empty-shell', 'cursor', '空会话', '2026-07-09T03:00:00.000Z', NULL, 0, 0, 0, 0, 0),
        ('with-msg', 'cursor', '有内容', '2026-07-09T03:01:00.000Z', NULL, 0, 0, 0, 0, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-with', 'with-msg', 'user', 'hello', '2026-07-09T03:01:01.000Z')
    `);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.map((s: any) => s.id)).toEqual(["with-msg"]);

    const detailRes = await app.request("/v1/sessions/empty-shell");
    expect(detailRes.status).toBe(200);
  });

  it("GET /v1/sessions/:id returns session with messages", async () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
        title: "修复登录 bug",
      },
      {
        type: "message",
        session_id: "s-1",
        message_id: "m-1",
        role: "user",
        content: "Hello",
        created_at: new Date().toISOString(),
      },
      {
        type: "turn.completed",
        session_id: "s-1",
        turn_id: "t-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1200,
        duration_ms: 500,
        created_at: new Date().toISOString(),
      },
    ];

    ingestService.ingestBatch(db, events);

    const sessionRes = await app.request("/v1/sessions/s-1");
    const session = await sessionRes.json();
    expect(session.id).toBe("s-1");
    expect(session.title).toBe("修复登录 bug");
    expect(session.summary).toBe("修复登录 bug");
    expect(session.duration_ms).toBeGreaterThanOrEqual(0);
    expect(session.request_count).toBe(1);

    const turnsRes = await app.request("/v1/sessions/s-1/turns");
    const turns = await turnsRes.json();
    expect(turnsRes.status).toBe(200);
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe("t-1");

    const msgsRes = await app.request("/v1/sessions/s-1/messages");
    const msgs = await msgsRes.json();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("Hello");
  });

  it("hides subagent sessions from list and rolls up parent cost", async () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "parent-1",
        agent: "opencode",
        title: "主任务",
      },
      {
        type: "session.created",
        session_id: "child-1",
        agent: "opencode",
        title: "子 Agent",
        parent_session_id: "parent-1",
        metadata: { opencode_agent: "explore" },
      },
      {
        type: "turn.completed",
        session_id: "parent-1",
        turn_id: "t-parent",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        duration_ms: 200,
        created_at: new Date().toISOString(),
      },
      {
        type: "turn.completed",
        session_id: "child-1",
        turn_id: "t-child",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 500,
        output_tokens: 200,
        total_tokens: 700,
        duration_ms: 800,
        created_at: new Date().toISOString(),
      },
    ];

    ingestService.ingestBatch(db, events);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("parent-1");
    expect(sessions[0].total_tokens).toBe(850);

    const childrenRes = await app.request("/v1/sessions/parent-1/children");
    const children = await childrenRes.json();
    expect(children.length).toBe(1);
    expect(children[0].id).toBe("child-1");
    expect(children[0].total_tokens).toBe(700);
  });

  it("GET /v1/sessions orders by last activity desc (continued chats bubble up)", async () => {
    const olderStart = "2026-06-10T08:00:00.000Z";
    const newerMessage = "2026-06-15T18:00:00.000Z";

    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES
        ('old-chat', 'cursor', '旧会话', '${olderStart}', '${olderStart}', 0, 0, 0, 0, 0),
        ('recent-chat', 'cursor', '新会话', '2026-06-14T10:00:00.000Z', NULL, 0, 0, 0, 0, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('m-old', 'old-chat', 'user', '继续对话', '${newerMessage}'),
        ('m-recent', 'recent-chat', 'user', '新开的', '2026-06-14T10:00:01.000Z')
    `);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe("old-chat");
    expect(sessions[0].last_activity_at).toBe(newerMessage);
    expect(sessions[1].id).toBe("recent-chat");
  });

  it("GET /v1/sessions/:id duration spans first message to last activity, not sessionStart idle gap", async () => {
    const sessionStart = "2026-06-16T05:23:11.124Z";
    const firstMsg = "2026-06-16T11:39:14.127Z";
    const lastMsg = "2026-06-16T12:29:32.117Z";

    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('cursor-idle-gap', 'cursor', 'Cursor 长开', '${sessionStart}', NULL, 1, 0, 0, 100, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('m1', 'cursor-idle-gap', 'user', 'first', '${firstMsg}'),
        ('m2', 'cursor-idle-gap', 'user', 'last', '${lastMsg}')
    `);

    const sessionRes = await app.request("/v1/sessions/cursor-idle-gap");
    const session = await sessionRes.json();
    expect(session.last_activity_at).toBe(lastMsg);
    expect(session.duration_ms).toBe(
      new Date(lastMsg).getTime() - new Date(firstMsg).getTime(),
    );
    expect(session.duration_ms).toBeLessThan(60 * 60 * 1000);
  });

  it("GET /v1/sessions excludes synthetic import sessions by default", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES
        ('agent-tracker-synthetic-import-daily-2026-06-16-gpt-5-5-0', '', '[runmark-import] 2026-06-16 GPT-5.5', '2026-06-16T12:00:00.000Z', '2026-06-16T12:00:00.000Z', 1, 0, 0, 1000, 0),
        ('legacy-import-id', 'IMate', '[runmark-import] IMate 本月', '2026-06-16T09:00:00.000Z', NULL, 0, 0, 0, 500, 0),
        ('real-session', 'cursor', '真实会话', '2026-06-16T09:00:00.000Z', NULL, 0, 0, 0, 100, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('m-synthetic', 'agent-tracker-synthetic-import-daily-2026-06-16-gpt-5-5-0', 'user', 'import', '2026-06-16T12:00:00.000Z'),
        ('m-legacy', 'legacy-import-id', 'user', 'import', '2026-06-16T09:00:00.000Z'),
        ('m-real', 'real-session', 'user', 'hello', '2026-06-16T09:00:00.000Z')
    `);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("real-session");

    const withImportsRes = await app.request("/v1/sessions?include_imports=1");
    const withImports = await withImportsRes.json();
    expect(withImports.length).toBe(3);
  });

  it("GET /v1/sessions excludes smartfetch-secondary temporary sessions", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES
        ('smartfetch-1', 'opencode', 'smartfetch-secondary', '2026-06-16T12:00:00.000Z', NULL, 1, 10, 20, 30, 0),
        ('real-opencode', 'opencode', '正常 OpenCode 会话', '2026-06-16T11:00:00.000Z', NULL, 1, 10, 20, 30, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('m-sf', 'smartfetch-1', 'user', 'temp', '2026-06-16T12:00:00.000Z'),
        ('m-real-oc', 'real-opencode', 'user', 'hello', '2026-06-16T11:00:00.000Z')
    `);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(["real-opencode"]);

    const detailRes = await app.request("/v1/sessions/smartfetch-1");
    expect(detailRes.status).toBe(200);
  });

  it("GET /v1/stats/summary returns aggregate stats", async () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
      },
      {
        type: "turn.completed",
        session_id: "s-1",
        turn_id: "t-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 2000,
        cache_write_tokens: 300,
        reasoning_tokens: 100,
        total_tokens: 3900,
        duration_ms: 1000,
        created_at: new Date().toISOString(),
      },
    ];

    ingestService.ingestBatch(db, events);

    const res = await app.request("/v1/stats/summary");
    const stats = await res.json();
    expect(stats.sessions).toBe(1);
    expect(stats.turns).toBe(1);
    expect(stats.tokens.total).toBe(3900);
    expect(stats.tokens.input).toBe(1000);
    expect(stats.tokens.output).toBe(500);
    expect(stats.tokens.cache_read).toBe(2000);
    expect(stats.tokens.cache_write).toBe(300);
    expect(stats.tokens.reasoning).toBe(100);
    expect(stats.cost_usd).toBeGreaterThan(0);
    expect(stats.cost_cny).toBeCloseTo(stats.cost_usd * USD_TO_CNY, 6);
  });

  it("GET /v1/stats/by-model groups by model and provider", async () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
      },
      {
        type: "session.created",
        session_id: "s-2",
        agent: "opencode",
      },
      {
        type: "turn.completed",
        session_id: "s-1",
        turn_id: "t-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 500,
        cache_write_tokens: 100,
        total_tokens: 1800,
        duration_ms: 500,
        created_at: new Date().toISOString(),
      },
      {
        type: "turn.completed",
        session_id: "s-2",
        turn_id: "t-2",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 2000,
        output_tokens: 400,
        cache_read_tokens: 800,
        total_tokens: 3200,
        duration_ms: 800,
        created_at: new Date().toISOString(),
      },
    ];

    ingestService.ingestBatch(db, events);

    const res = await app.request("/v1/stats/by-model");
    const rows = await res.json();
    expect(rows.length).toBe(1);
    expect(rows[0].turn_count).toBe(2);
    expect(rows[0].total_tokens).toBe(5000);
    expect(rows[0].cache_read_tokens).toBe(1300);
    expect(rows[0].cache_write_tokens).toBe(100);
  });

  it("GET /v1/stats/by-model filters by range and sorts by tokens", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    ingestService.ingestBatch(db, [
      {
        type: "turn.completed",
        session_id: "s-old",
        turn_id: "t-old",
        model: "old-model",
        provider: "p",
        input_tokens: 9000,
        output_tokens: 100,
        total_tokens: 9100,
        duration_ms: 100,
        cost_usd: 0.5,
        created_at: old,
      },
      {
        type: "turn.completed",
        session_id: "s-new",
        turn_id: "t-new",
        model: "new-model",
        provider: "p",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        duration_ms: 100,
        cost_usd: 0.01,
        created_at: recent,
      },
    ]);

    const res = await app.request("/v1/stats/by-model?range=7d&sort=tokens");
    const rows = await res.json();
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("new-model");
    expect(rows[0].total_tokens).toBe(150);
  });

  it("GET /v1/stats/by-agent groups by agent within range", async () => {
    ingestService.ingestBatch(db, [
      {
        type: "session.created",
        session_id: "s-oc",
        agent: "opencode",
      },
      {
        type: "session.created",
        session_id: "s-cu",
        agent: "cursor",
      },
      {
        type: "turn.completed",
        session_id: "s-oc",
        turn_id: "t-oc",
        model: "m1",
        provider: "p",
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        duration_ms: 100,
        cost_usd: 0.02,
        created_at: new Date().toISOString(),
      },
      {
        type: "turn.completed",
        session_id: "s-cu",
        turn_id: "t-cu",
        model: "m2",
        provider: "p",
        input_tokens: 500,
        output_tokens: 200,
        total_tokens: 700,
        duration_ms: 200,
        cost_usd: 0.08,
        created_at: new Date().toISOString(),
      },
    ]);

    const res = await app.request("/v1/stats/by-agent");
    const rows = await res.json();
    expect(rows.length).toBe(2);
    expect(rows[0].agent).toBe("cursor");
    expect(rows[0].turn_count).toBe(1);
    expect(rows[0].total_tokens).toBe(700);
    expect(rows[0].total_cost_cny).toBeCloseTo(0.08 * USD_TO_CNY, 6);
  });

  it("GET /v1/stats/daily groups turns by date within range", async () => {
    const today = new Date().toISOString();
    ingestService.ingestBatch(db, [
      {
        type: "turn.completed",
        session_id: "s-daily",
        turn_id: "t-daily",
        model: "m",
        provider: "p",
        input_tokens: 300,
        output_tokens: 100,
        total_tokens: 400,
        duration_ms: 100,
        cost_usd: 0.03,
        created_at: today,
      },
    ]);

    const res = await app.request("/v1/stats/daily?range=7d");
    const rows = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r: { turn_count?: number }) => r.turn_count === 1);
    expect(row).toBeDefined();
    expect(row.total_tokens).toBe(400);
    expect(row.total_cost_cny).toBeCloseTo(0.03 * USD_TO_CNY, 6);
  });

  it("GET /v1/stats/daily returns models array with provider/model/total_cost_cny", async () => {
    const today = new Date().toISOString();
    ingestService.ingestBatch(db, [
      {
        type: "session.created",
        session_id: "s-dm1",
        agent: "opencode",
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
      {
        type: "session.created",
        session_id: "s-dm2",
        agent: "opencode",
        provider: "openai",
        model: "gpt-4.1",
      },
      {
        type: "turn.completed",
        session_id: "s-dm1",
        turn_id: "t-dm1",
        model: "claude-sonnet-4",
        provider: "anthropic",
        input_tokens: 500,
        output_tokens: 200,
        total_tokens: 700,
        duration_ms: 100,
        cost_usd: 0.05,
        created_at: today,
      },
      {
        type: "turn.completed",
        session_id: "s-dm2",
        turn_id: "t-dm2",
        model: "gpt-4.1",
        provider: "openai",
        input_tokens: 300,
        output_tokens: 100,
        total_tokens: 400,
        duration_ms: 80,
        cost_usd: 0.02,
        created_at: today,
      },
    ]);

    const res = await app.request("/v1/stats/daily?range=7d");
    const rows = await res.json();
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r: any) => r.models?.length >= 2);
    expect(row).toBeDefined();
    expect(row.models.length).toBe(2);

    // 每个模型行含关键字段
    const anthropicModel = row.models.find((m: any) => m.model === "claude-sonnet-4");
    expect(anthropicModel).toBeDefined();
    expect(anthropicModel.provider).toBe("anthropic");
    expect(anthropicModel.turn_count).toBe(1);
    expect(anthropicModel.total_tokens).toBe(700);
    expect(anthropicModel.total_cost_cny).toBeCloseTo(0.05 * USD_TO_CNY, 6);
    expect(anthropicModel.label).toBe("anthropic / claude-sonnet-4");

    const openaiModel = row.models.find((m: any) => m.model === "gpt-4.1");
    expect(openaiModel).toBeDefined();
    expect(openaiModel.provider).toBe("openai");
    expect(openaiModel.total_cost_cny).toBeCloseTo(0.02 * USD_TO_CNY, 6);

    // 保留顶层汇总字段
    expect(row.session_count).toBe(2);
    expect(row.turn_count).toBe(2);
    expect(row.total_tokens).toBe(1100);
  });

  it("GET /v1/sessions returns models[] split from comma-separated sessions.model", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, model, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('multi-1', 'opencode', '多模型会话', 'glm-5-1, deepseek-v4-pro', '2026-07-09T04:00:00.000Z', NULL, 0, 0, 0, 0, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-multi-1', 'multi-1', 'user', 'hi', '2026-07-09T04:00:01.000Z')
    `);

    const sessionsRes = await app.request("/v1/sessions");
    const sessions = await sessionsRes.json();
    const row = sessions.find((s: any) => s.id === "multi-1");
    expect(row).toBeTruthy();
    expect(row.model).toBe("glm-5-1, deepseek-v4-pro");
    expect(row.models).toEqual(["glm-5-1", "deepseek-v4-pro"]);
  });

  it("GET /v1/sessions?q= searches message body and supports offset pagination", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES
        ('search-a', 'opencode', '普通标题', '2026-07-09T05:00:00.000Z', NULL, 0, 0, 0, 0, 0),
        ('search-b', 'opencode', '另一会话', '2026-07-09T05:01:00.000Z', NULL, 0, 0, 0, 0, 0),
        ('search-c', 'opencode', '无关会话', '2026-07-09T05:02:00.000Z', NULL, 0, 0, 0, 0, 0)
    `);
    db.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('m-search-a', 'search-a', 'user', '请修复 runmark 分页卡顿', '2026-07-09T05:00:01.000Z'),
        ('m-search-b', 'search-b', 'assistant', '这里提到 runmark 搜索正文', '2026-07-09T05:01:01.000Z'),
        ('m-search-c', 'search-c', 'user', '完全无关的内容', '2026-07-09T05:02:01.000Z')
    `);

    const hitRes = await app.request("/v1/sessions?q=runmark&limit=10");
    const hits = await hitRes.json();
    expect(hits.map((s: any) => s.id).sort()).toEqual(["search-a", "search-b"]);

    const page1 = await (await app.request("/v1/sessions?q=runmark&limit=1&offset=0")).json();
    const page2 = await (await app.request("/v1/sessions?q=runmark&limit=1&offset=1")).json();
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0].id).not.toBe(page2[0].id);
    expect([page1[0].id, page2[0].id].sort()).toEqual(["search-a", "search-b"]);
  });
});
