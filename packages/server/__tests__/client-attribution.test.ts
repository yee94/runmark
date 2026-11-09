import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createOpenCode2TrackerState, mapOpenCode2Event } from "../../plugin-opencode/src/opencode2-events";
import { initializeDatabase } from "../src/db";
import { SCHEMA_SQL } from "../src/db/schema";
import { createSessionsRoute } from "../src/routes/sessions";
import { ingestService } from "../src/services/ingest";
import type { IngestEvent } from "@agent-tracker/shared";

const databases: Database[] = [];
const database = () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(SCHEMA_SQL);
  return db;
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("client provenance round trip", () => {
  it("validates client ids at ingestion and deduplicates only matching sources without changing costs", async () => {
    const db = database();
    const messages: IngestEvent[] = ["yuri", "other", undefined, "INVALID ID"].map((client_id, index) => ({
      type: "message", session_id: "sources", message_id: `input-${index}`, role: "user", content: "identical", client_id, created_at: "2026-01-01",
    }));
    const turn: IngestEvent = { type: "turn.completed", session_id: "sources", turn_id: "turn", model: "test", provider: "openai", input_tokens: 1, output_tokens: 2, total_tokens: 3, cost_usd: 0.1, duration_ms: 1, client_id: "yuri", created_at: "2026-01-01" };
    expect(ingestService.ingestBatch(db, [...messages, turn, turn]).errors).toEqual([]);
    const app = createSessionsRoute(db);
    const rows = await (await app.request("/v1/sessions/sources/messages")).json();
    expect(rows.map((row: any) => row.client_id)).toEqual(["yuri", "other", null]);
    const session = await (await app.request("/v1/sessions/sources")).json();
    expect(session.total_tokens).toBe(3);
    expect(session.total_cost_usd).toBeCloseTo(0.1);
    expect(session.request_count).toBe(1);
    expect(session.client_ids).toEqual(["other", "yuri"]);
    expect(session.has_unknown_client).toBe(true);
  });

  it("retains per-request sources, stable identities and mixed/unknown session summaries", async () => {
    const db = database();
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => {
      const mapped = mapOpenCode2Event(state, { type, created: 1_700_000_000_000, data: { sessionID: "shared", ...data } }, { includeMessageContent: true, includeToolOutput: false });
      const result = ingestService.ingestBatch(db, mapped);
      expect(result.errors).toEqual([]);
    };
    event("session.created", { agent: "build", title: "Mixed clients" });
    for (const [index, client] of ["yuri", "other", undefined].entries()) {
      const id = `input-${index}`;
      event("session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: "same text", metadata: client ? { client: { id: client } } : {} } } });
      event("session.inbox.delivered", { inboxID: id });
      event("session.step.started", { agent: "build", assistantMessageID: `answer-${index}`, model: { id: "test-model", providerID: "openai" } });
      event("session.step.ended", { assistantMessageID: `answer-${index}`, tokens: { input: 1, output: 1 }, cost: 0 });
      event("session.execution.succeeded", {});
    }
    const app = createSessionsRoute(db);
    const session = await (await app.request("/v1/sessions/shared")).json();
    expect(session.agent).toBe("other");
    expect(session.client_ids).toEqual(["other", "yuri"]);
    expect(session.has_unknown_client).toBe(true);
    const messages = await (await app.request("/v1/sessions/shared/messages")).json();
    expect(messages.map((message: any) => message.client_id)).toEqual(["yuri", "other", null]);
    expect(messages.every((message: any) => message.agent_key === "opencode/build")).toBe(true);
    const turns = await (await app.request("/v1/sessions/shared/turns")).json();
    expect(turns.map((turn: any) => turn.client_id)).toEqual(["yuri", "other", null]);
    expect(db.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 3 });
    expect(session.total_tokens).toBe(6);
  });

  it("adds nullable source columns to existing databases without relabelling history", () => {
    const db = database();
    db.exec("INSERT INTO sessions(id,agent,started_at) VALUES ('old','opencode','2026-01-01')");
    db.exec("INSERT INTO messages(id,session_id,role,content,created_at) VALUES ('old-input','old','user','history','2026-01-01')");
    db.exec("ALTER TABLE messages DROP COLUMN client_id");
    db.exec("ALTER TABLE turns DROP COLUMN client_id");
    initializeDatabase(db);
    initializeDatabase(db);
    expect(db.query("SELECT client_id FROM messages WHERE id='old-input'").get()).toEqual({ client_id: null });
    expect(db.query("SELECT client_id FROM turns").all()).toEqual([]);
  });
});
