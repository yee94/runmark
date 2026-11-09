import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_SQL } from "../src/db/schema";
import { createStatsRoute } from "../src/routes/sessions";
import { ingestService } from "../src/services/ingest";
import { createOpenCode2TrackerState, mapOpenCode2Event } from "../../plugin-opencode/src/opencode2-events";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  app = new Hono().route("/", createStatsRoute(db));
});
afterEach(() => db.close());

test.each([true, false])("reported client becomes sessions.agent and existing Agent statistics work unchanged (capture=%s)", async (includeMessageContent) => {
  const state = createOpenCode2TrackerState();
  const event = (type: string, data: Record<string, unknown> = {}) => {
    const events = mapOpenCode2Event(state, { type, data: { sessionID: "session", ...data } }, { includeMessageContent, includeToolOutput: true });
    expect(ingestService.ingestBatch(db, events).errors).toEqual([]);
  };
  event("session.created", { title: "example" });
  expect(db.query("SELECT agent FROM sessions WHERE id = 'session'").get()).toMatchObject({ agent: "opencode" });
  event("session.inbox.enqueued", { inboxID: "input", item: { type: "user", payload: { text: "hello", metadata: { client: { id: "yuri" } } } } });
  event("session.inbox.delivered", { inboxID: "input" });
  expect(db.query("SELECT agent FROM sessions WHERE id = 'session'").get()).toMatchObject({ agent: "yuri" });
  event("session.step.started", { assistantMessageID: "answer", agent: "build", model: { id: "model", providerID: "provider" } });
  event("session.step.ended", { assistantMessageID: "answer", cost: 2, tokens: { input: 100, output: 50 } });
  event("session.execution.succeeded");
  event("session.renamed", { title: "renamed" });
  event("session.usage.updated", { cost: 10, tokens: { input: 900, output: 100 } });
  const response = await app.request("/v1/stats/by-agent?range=all");
  expect(response.status).toBe(200);
  const rows = await response.json();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ agent: "yuri", session_count: 1, total_tokens: 1000, total_cost_usd: 10 });
  expect(db.query("SELECT agent, total_cost_usd FROM sessions WHERE id = 'session'").get()).toMatchObject({ agent: "yuri", total_cost_usd: 10 });
  if (includeMessageContent) {
    expect(db.query("SELECT agent_key FROM messages WHERE id = 'input'").get()).toMatchObject({ agent_key: "opencode/build" });
  }
});

test("unmarked clients keep OpenCode as the reported Agent", async () => {
  const state = createOpenCode2TrackerState();
  for (const event of [
    { type: "session.created", data: { sessionID: "cli" } },
    { type: "session.usage.updated", data: { sessionID: "cli", cost: 1, tokens: { input: 100 } } },
  ]) {
    expect(ingestService.ingestBatch(db, mapOpenCode2Event(state, event, { includeMessageContent: true, includeToolOutput: true })).errors).toEqual([]);
  }
  expect(await (await app.request("/v1/stats/by-agent?range=all")).json()).toMatchObject([
    { agent: "opencode", total_tokens: 100, total_cost_usd: 1 },
  ]);
});
