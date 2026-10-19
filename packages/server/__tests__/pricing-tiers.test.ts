import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase, getPricing } from "../src/db";
import { createPricingRoute } from "../src/routes/sessions";
import { costService } from "../src/services/cost";
import { ingestService } from "../src/services/ingest";

describe("pricing tiers persistence and ingestion", () => {
  it("migrates old pricing tables and uses persisted Astra tiers for OAuth fallback", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE pricing (provider TEXT, model TEXT, PRIMARY KEY(provider, model))");
    initializeDatabase(db);
    const pricing = getPricing(db);
    costService.setPricing(pricing);
    const astra = pricing.find((p) => p.provider === "openai" && p.model === "gpt-6-astra")!;
    expect(astra.context_tiers?.[0].above).toBe(272000);

    for (const agent of ["opencode", "codex"]) {
      ingestService.ingestBatch(db, [
        { type: "session.created", session_id: agent, agent },
        { type: "turn.completed", session_id: agent, turn_id: agent, provider: "openai", model: "gpt-6-astra",
          input_tokens: 1118, cache_read_tokens: 279680, output_tokens: agent === "codex" ? 812 : 302, reasoning_tokens: 510,
          total_tokens: 281610, duration_ms: 100, cost_usd: 0, created_at: "2026-10-18T09:00:00Z" },
      ]);
      expect(db.query("SELECT cost_usd FROM turns WHERE id = ?").get(agent)).toEqual({ cost_usd: 0.64262 });
    }

    const app = createPricingRoute(db);
    const preview = await app.request("/v1/pricing/reprice", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "opencode", dry_run: true }) });
    expect(await preview.json()).toMatchObject({ ok: true, dry_run: true, scanned: 1, updated: 0 });
    const invalid = await app.request("/v1/pricing/reprice", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "", dry_run: true }) });
    expect(invalid.status).toBe(400);
    const response = await app.request("/v1/pricing");
    const rows = await response.json() as typeof pricing;
    expect(rows.find((p) => p.provider === "openai" && p.model === "gpt-6-astra")?.context_tiers).toEqual(astra.context_tiers);

    const put = (body: unknown) => app.request("/v1/pricing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const custom = { provider: "custom", model: "tiered", input_price: 1, output_price: 2,
      context_tiers: [{ above: 100, input_price: 3, output_price: 4 }] };
    expect((await put(custom)).status).toBe(200);
    costService.setPricing(getPricing(db));
    expect(costService.compute("custom", "tiered", { input_tokens: 101, output_tokens: 1 })).toBe(0.000307);
    expect((await put({ ...custom, context_tiers: undefined })).status).toBe(200);
    expect(getPricing(db).find((p) => p.provider === "custom")?.context_tiers).toEqual(custom.context_tiers);
    expect((await put({ ...custom, context_tiers: [{ above: -1, input_price: 3, output_price: 4 }] })).status).toBe(400);
    expect((await put({ ...custom, context_tiers: [] })).status).toBe(200);
    expect(getPricing(db).find((p) => p.provider === "custom")?.context_tiers).toEqual([]);
    db.close();
  });
});
