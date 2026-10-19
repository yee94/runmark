import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { DEFAULT_PRICING } from "@agent-tracker/shared";
import { costService } from "../src/services/cost";
import { repriceTurns } from "../src/services/reprice";
import { SCHEMA_SQL } from "../src/db/schema";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  return db;
}

describe("repriceTurns", () => {
  beforeEach(() => {
    costService.setPricing(DEFAULT_PRICING);
  });

  it("previews and repairs one Astra session atomically without replacing cumulative tokens", () => {
    const db = setupDb();
    for (const id of ["astra", "other"]) {
      db.query("INSERT INTO sessions (id, agent, started_at, total_tokens, total_cost_usd) VALUES (?, 'opencode', '2026-10-18', 43017847, 0.15449)").run(id);
      db.query(`INSERT INTO turns (id, session_id, provider, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
        VALUES (?, ?, 'openai', 'gpt-6-astra', 1118, 302, 279680, 510, 281610, 0, 0.15449, '2026-10-18')`).run(id, id);
    }
    const preview = repriceTurns(db, { sessionId: "astra", dryRun: true });
    expect(preview.updated).toBe(1);
    expect(preview.delta_usd).toBeCloseTo(0.48813, 9);
    expect(db.query("SELECT cost_usd FROM turns WHERE id = 'astra'").get()).toEqual({ cost_usd: 0.15449 });
    repriceTurns(db, { sessionId: "astra" });
    expect(db.query("SELECT total_tokens, total_cost_usd FROM sessions WHERE id = 'astra'").get()).toEqual({ total_tokens: 43017847, total_cost_usd: 0.64262 });
    expect(db.query("SELECT cost_usd FROM turns WHERE id = 'other'").get()).toEqual({ cost_usd: 0.15449 });
    expect(repriceTurns(db, { sessionId: "astra" }).updated).toBe(0);
    db.close();
  });

  it("recalculates under-reported grok-build cost including cache", () => {
    const db = setupDb();
    const now = "2026-07-25T12:00:00.000Z";

    db.query(`
      INSERT INTO sessions (id, agent, title, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('s1', 'opencode', 't', $now, 1, 1000000, 0, 2000000, 0.01)
    `).run({ $now: now });

    // 客户端只记了 input $2，漏了 cache $0.30
    db.query(`
      INSERT INTO turns (
        id, session_id, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_tokens, duration_ms, cost_usd, created_at
      ) VALUES (
        't1', 's1', 'grok-4.5', 'grok-build',
        1000000, 0, 1000000, 0, 0,
        2000000, 0, 2.0, $now
      )
    `).run({ $now: now });

    const result = repriceTurns(db, { providers: ["grok-build"] });
    expect(result.updated).toBe(1);
    expect(result.delta_usd).toBeCloseTo(0.3, 6);

    const turn = db.query("SELECT cost_usd FROM turns WHERE id = 't1'").get() as { cost_usd: number };
    expect(turn.cost_usd).toBeCloseTo(2.3, 6);

    const session = db
      .query("SELECT total_cost_usd FROM sessions WHERE id = 's1'")
      .get() as { total_cost_usd: number };
    expect(session.total_cost_usd).toBeCloseTo(2.3, 6);
  });
});
