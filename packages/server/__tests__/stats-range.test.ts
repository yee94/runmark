import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_SQL } from "../src/db/schema";
import { createStatsRoute } from "../src/routes/sessions";
import { resolveStatsRange } from "../src/services/stats";

afterEach(() => setSystemTime());

describe("stats time ranges", () => {
  it("resolves previous month across year and leap-year boundaries", () => {
    setSystemTime(new Date("2026-01-15T12:00:00Z"));
    expect(resolveStatsRange("last_month")).toEqual({ from: "2025-12-01T00:00:00.000Z", to: "2025-12-31T23:59:59.999Z" });
    setSystemTime(new Date("2024-03-15T12:00:00Z"));
    expect(resolveStatsRange("last_month").to).toBe("2024-02-29T23:59:59.999Z");
  });

  it("normalizes explicit local boundaries and overrides presets", () => {
    expect(resolveStatsRange("today", { from: "2026-10-18T00:00:00+08:00", to: "2026-10-18T23:59:59.999+08:00" })).toEqual({
      from: "2026-10-17T16:00:00.000Z", to: "2026-10-18T15:59:59.999Z",
    });
  });

  it("validates bounds on every date-filtered endpoint", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const app = new Hono().route("/", createStatsRoute(db));
    try {
      for (const endpoint of ["summary", "by-model", "by-agent", "daily"]) {
        for (const query of ["range=custom", "from=bad&to=bad", "from=2026-10-19T00:00:00Z&to=2026-10-18T00:00:00Z", "from=2026-10-18&to=2026-10-19"]) {
          expect((await app.request(`/v1/stats/${endpoint}?${query}`)).status).toBe(400);
        }
        expect((await app.request(`/v1/stats/${endpoint}?range=custom&from=2026-10-17T16:00:00Z&to=2026-10-18T15:59:59.999Z`)).status).toBe(200);
      }
    } finally {
      db.close();
    }
  });

  it("counts local-midnight turns and excludes adjacent dates", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.run("INSERT INTO sessions (id, agent, started_at) VALUES ('s', 'opencode', '2026-10-17T16:00:00.000Z')");
    for (const [id, time] of [
      ["before", "2026-10-17T15:59:59.999Z"],
      ["start", "2026-10-17T16:00:00.000Z"],
      ["end", "2026-10-18T15:59:59.999Z"],
      ["after", "2026-10-18T16:00:00.000Z"],
    ]) {
      db.run("INSERT INTO turns (id, session_id, provider, model, total_tokens, cost_usd, created_at) VALUES (?, 's', 'test', 'test', 100, 1, ?)", [id, time]);
    }
    const app = new Hono().route("/", createStatsRoute(db));
    try {
      const query = new URLSearchParams({ range: "custom", from: "2026-10-18T00:00:00+08:00", to: "2026-10-18T23:59:59.999+08:00" });
      const res = await app.request(`/v1/stats/summary?${query}`);
      const data = await res.json();
      expect(data.turns).toBe(2);
      expect(data.tokens.total).toBe(200);
      expect(data.cost_usd).toBe(2);
      expect(data.from).toBe("2026-10-17T16:00:00.000Z");
    } finally {
      db.close();
    }
  });
});
