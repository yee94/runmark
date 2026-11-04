import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { createStatsRoute } from "../src/routes/sessions";

describe("model statistics grouping", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.query("INSERT INTO sessions (id, agent, started_at) VALUES ('s', 'opencode', '2026-11-01T00:00:00.000Z')").run();
  });

  afterEach(() => db.close());

  function seed(model: string, provider: string, tokens = 100, cost = 1, duration = 1000, created = "2026-11-01T00:00:00.000Z") {
    db.query(`INSERT INTO turns
      (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_usd, duration_ms, created_at)
      VALUES (?, 's', ?, ?, ?, 2, 3, 4, 5, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), model, provider, tokens - 14, tokens, cost, duration, created);
  }

  async function rows(query = "group=model&range=all") {
    const response = await createStatsRoute(db).request(`/v1/stats/by-model?${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Array<Record<string, any>>;
  }

  async function daily(query = "group=model&range=all") {
    const response = await createStatsRoute(db).request(`/v1/stats/daily?${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Array<Record<string, any>>;
  }

  it("merges the same model across providers without changing stored identities or agents", async () => {
    seed("gpt-6.1-sol", "openai", 100, 1);
    seed("gpt-6.1-sol", "magpie-openai", 200, 2);
    const before = db.query("SELECT * FROM turns ORDER BY id").all();

    const result = await rows();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ model: "gpt-6.1-sol", turn_count: 2, total_tokens: 300, total_cost_usd: 3 });
    expect(result[0].sources.map((source: any) => source.provider).sort()).toEqual(["magpie-openai", "openai"]);
    expect(result[0].sources.every((source: any) => source.total_cost_cny > 0)).toBe(true);
    expect(result[0].total_cost_cny).toBeCloseTo(result[0].sources.reduce((sum: number, source: any) => sum + source.total_cost_cny, 0), 6);
    expect(db.query("SELECT * FROM turns ORDER BY id").all()).toEqual(before);
    expect(db.query("SELECT agent FROM sessions").get()).toEqual({ agent: "opencode" });
  });

  it("merges explicit routing namespaces and context sizes but preserves original source names", async () => {
    seed("group/claude-sonnet-5.5", "magpie-remote-magpie%2Fgroup");
    seed("claude-sonnet-5.5", "anthropic");
    seed("claude-opus-5.5@300k", "magpie-cursor");
    seed("claude-opus-5.5-1m", "anthropic");
    seed("Claude_Opus_5_5", "codebuddy");

    const result = await rows();
    expect(result).toHaveLength(2);
    const opus = result.find((row) => row.model === "claude-opus-5.5");
    expect(opus?.turn_count).toBe(3);
    expect(opus?.sources.map((source: any) => source.model).sort()).toEqual([
      "Claude_Opus_5_5", "claude-opus-5.5-1m", "claude-opus-5.5@300k",
    ]);
    expect(result.find((row) => row.model === "claude-sonnet-5.5")?.turn_count).toBe(2);
  });

  it("keeps uncertain routes, different versions and capability variants separate", async () => {
    const models = [
      "auto-deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash", "combo-smart",
      "gpt-6.1", "gpt-6.1-sol", "gpt-6.1-codex", "gpt-6.1-preview",
      "claude-opus-5.5", "claude-opus-5.5-thinking", "haiku", "claude-haiku-5.5",
      "custom@300k", "custom", "tenant/custom", "other/custom",
    ];
    for (const model of models) seed(model, "magpie-group");
    const result = await rows();
    expect(result.map((row) => row.model).sort()).toEqual(models.sort());
    expect(result.every((row) => row.turn_count === 1)).toBe(true);
  });

  it("merges explicit channel suffixes without borrowing pricing aliases", async () => {
    seed("glm-5.2-ioa", "codebuddy");
    seed("glm-5.2-official", "boxai");
    seed("glm-5.2", "zhipu");
    seed("grok-4.7-256k-fast", "cursor");
    seed("grok-4.7-500k-fast", "magpie-cursor");
    seed("grok-4.7", "xai");
    const result = await rows();
    expect(result).toHaveLength(3);
    expect(result.find((row) => row.model === "glm-5.2")?.turn_count).toBe(3);
    expect(result.find((row) => row.model === "grok-4.7-fast")?.turn_count).toBe(2);
    expect(result.find((row) => row.model === "grok-4.7")?.turn_count).toBe(1);
  });

  it("follows Magpie vendor spelling and compact snapshot date rules", async () => {
    for (const model of [
      "deepseek-v4.1-flash", "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek_v4_1_flash",
      "accounts/fireworks/models/deepseek-v4p1-flash", "deepseek-v4-1-flash-260910",
    ]) seed(model, "relay");
    seed("Claude Opus 5.5", "relay");
    seed("claude-opus-5-5@20260801", "vertex");
    seed("anthropic/claude-opus-5.5-20260801", "openrouter");
    seed("claude-opus-5.5[1m]", "claude");
    const result = await rows();
    expect(result).toHaveLength(2);
    expect(result.find((row) => row.model === "deepseek-v4.1-flash")?.turn_count).toBe(5);
    expect(result.find((row) => row.model === "claude-opus-5.5")?.turn_count).toBe(4);
  });

  it("recognizes Magpie auto group spellings only when they identify a versioned model", async () => {
    seed("group/auto-claude-opus-5-5", "magpie-group");
    seed("auto/claude-opus-5.5", "magpie-auto");
    seed("auto-claude-opus-5-5", "magpie-remote-magpie%2Fgroup");
    seed("claude-opus-5.5", "anthropic");
    seed("auto-deepseek-flash", "magpie-group");
    seed("auto-claude-opus-5-5", "custom-router");
    const result = await rows();
    expect(result).toHaveLength(3);
    expect(result.find((row) => row.model === "claude-opus-5.5")?.turn_count).toBe(4);
    expect(result.find((row) => row.model === "auto-deepseek-flash")?.turn_count).toBe(1);
    expect(result.find((row) => row.model === "auto-claude-opus-5-5")?.turn_count).toBe(1);
  });

  it("keeps the distinct releases and variants Magpie deliberately does not merge", async () => {
    const models = [
      "deepseek-v4.1-flash", "deepseek-v4.11-flash", "deepseek-v4.1-thinking",
      "deepseek-v4-1-flash-128000", "deepseek-v4-1-flash-261301",
      "qwen3-235b-a22b", "qwen3-235b-a22b-2507", "kimi-k2", "kimi-k2-0905",
      "claude-opus-5.5", "claude-opus-5.5:batch", "gpt-4o", "gpt-4o-2024-08-06",
    ];
    for (const model of models) seed(model, "relay");
    expect((await rows()).map((row) => row.model).sort()).toEqual(models.sort());
  });

  it("keeps the display name stable when sorting changes the order of source rows", async () => {
    seed("GPT_6_1_SOL", "relay", 10000, 1);
    seed("gpt-6.1-sol", "openai", 100, 10);
    const byCost = await rows("group=model&range=all&sort=cost");
    const byTokens = await rows("group=model&range=all&sort=tokens");
    expect(byCost[0].model).toBe("gpt-6.1-sol");
    expect(byTokens[0].model).toBe(byCost[0].model);
    expect(byTokens[0].sources[0].provider).toBe("relay");
    expect(byCost[0].sources[0].provider).toBe("openai");
  });

  it("sums all token components and weights durations by turn counts, including zero durations", async () => {
    seed("gpt-6.1-sol", "a", 100, 1, 1000);
    seed("gpt-6.1-sol", "a", 200, 2, 3000);
    seed("gpt-6.1-sol", "b", 300, 3, 8000);
    seed("gpt-6.1-sol", "a", 400, 4, 0);
    const [result] = await rows();
    expect(result).toMatchObject({
      turn_count: 4, input_tokens: 944, output_tokens: 8, cache_read_tokens: 12,
      cache_write_tokens: 16, reasoning_tokens: 20, total_tokens: 1000, total_cost_usd: 10,
      avg_duration_ms: 3000,
    });
    expect(result.sources.find((source: any) => source.provider === "a").avg_duration_ms).toBeCloseTo(4000 / 3);
    expect(result).not.toHaveProperty("duration_count");
    expect(result.sources[0]).not.toHaveProperty("duration_count");
  });

  it("sorts after merging and retains custom time range filtering", async () => {
    seed("gpt-6.1-sol", "a", 100, 2);
    seed("gpt-6.1-sol", "b", 100, 2);
    seed("claude-sonnet-5.5", "a", 1000, 3);
    seed("gpt-6.1-sol", "old", 10000, 100, 1000, "2026-10-01T00:00:00.000Z");
    const bounds = "group=model&range=custom&from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00.000Z";
    const cost = await rows(`${bounds}&sort=cost`);
    expect(cost.map((row) => row.model)).toEqual(["gpt-6.1-sol", "claude-sonnet-5.5"]);
    expect(cost[0].sources).toHaveLength(2);
    const tokens = await rows(`${bounds}&sort=tokens`);
    expect(tokens.map((row) => row.model)).toEqual(["claude-sonnet-5.5", "gpt-6.1-sol"]);
  });

  it("keeps the legacy ungrouped API unchanged", async () => {
    seed("group/claude-sonnet-5.5", "magpie-group");
    seed("claude-sonnet-5.5", "anthropic");
    const result = await rows("range=all");
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.model).sort()).toEqual(["claude-sonnet-5.5", "group/claude-sonnet-5.5"]);
    expect(result.every((row) => !row.sources && !("duration_count" in row))).toBe(true);
    expect(result.every((row) => row.avg_duration_ms === 1000)).toBe(true);
  });

  it("returns an empty list when there are no turns", async () => {
    expect(await rows()).toEqual([]);
  });

  it("merges daily model segments across providers while preserving each day totals", async () => {
    seed("gpt-6.1-sol", "openai", 100, 1);
    seed("gpt-6.1-sol", "magpie-codex", 200, 2);
    seed("claude-opus-5.5@300k", "magpie-cursor", 300, 3);
    seed("group/claude-opus-5.5", "magpie-group", 400, 4);
    const [result] = await daily();
    expect(result.date).toBe("2026-11-01");
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ model: "claude-opus-5.5", label: "claude-opus-5.5", turn_count: 2, total_tokens: 700, total_cost_usd: 7 });
    expect(result.models[1]).toMatchObject({ model: "gpt-6.1-sol", label: "gpt-6.1-sol", turn_count: 2, total_tokens: 300, total_cost_usd: 3 });
    expect(result.models.every((row: any) => !("provider" in row))).toBe(true);
    expect(result.models.reduce((sum: number, row: any) => sum + row.turn_count, 0)).toBe(result.turn_count);
    expect(result.models.reduce((sum: number, row: any) => sum + row.total_tokens, 0)).toBe(result.total_tokens);
    expect(result.models.reduce((sum: number, row: any) => sum + row.total_cost_usd, 0)).toBe(result.total_cost_usd);
    expect(result.models.reduce((sum: number, row: any) => sum + row.total_cost_cny, 0)).toBeCloseTo(result.total_cost_cny, 6);
  });

  it("uses one model label across days even when only one spelling is present on each day", async () => {
    seed("group/auto-claude-opus-5-5", "magpie-group", 100, 1, 1000, "2026-11-01T15:59:59.999Z");
    seed("claude-opus-5.5@300k", "magpie-cursor", 200, 2, 1000, "2026-11-01T16:00:00.000Z");
    const result = await daily();
    expect(result.map((row) => row.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(result.map((row) => row.models[0].label)).toEqual(["claude-opus-5.5", "claude-opus-5.5"]);
    expect(result.map((row) => row.models[0].total_tokens)).toEqual([100, 200]);
  });

  it("keeps daily routing aliases and model variants separate", async () => {
    for (const model of ["auto-deepseek-flash", "deepseek-v4.1-flash", "claude-opus-5.5", "claude-opus-5.5-thinking"]) seed(model, "magpie-group");
    const [result] = await daily();
    expect(result.models).toHaveLength(4);
    expect(result.models.map((row: any) => row.label).sort()).toEqual([
      "auto-deepseek-flash", "claude-opus-5.5", "claude-opus-5.5-thinking", "deepseek-v4.1-flash",
    ]);
  });

  it("retains daily custom boundaries and subagent exclusion", async () => {
    seed("gpt-6.1-sol", "openai", 100, 1, 1000, "2026-11-01T15:59:59.999Z");
    seed("gpt-6.1-sol", "magpie-codex", 200, 2, 1000, "2026-11-01T16:00:00.000Z");
    db.query("INSERT INTO sessions (id, agent, parent_session_id, started_at) VALUES ('child', 'opencode', 's', '2026-11-01T16:00:00.000Z')").run();
    db.query("INSERT INTO turns (id, session_id, provider, model, total_tokens, cost_usd, created_at) VALUES ('child-turn', 'child', 'openai', 'gpt-6.1-sol', 9999, 99, '2026-11-01T16:00:00.000Z')").run();
    const result = await daily("group=model&range=custom&from=2026-11-01T16:00:00.000Z&to=2026-11-02T15:59:59.999Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ date: "2026-11-02", turn_count: 1, total_tokens: 200, total_cost_usd: 2 });
    expect(result[0].models).toHaveLength(1);
    expect(result[0].models[0]).toMatchObject({ label: "gpt-6.1-sol", turn_count: 1, total_tokens: 200 });
  });

  it("preserves daily raw-provider breakdown when grouping is not requested", async () => {
    seed("gpt-6.1-sol", "openai");
    seed("gpt-6.1-sol", "magpie-codex");
    const [result] = await daily("range=all");
    expect(result.models).toHaveLength(2);
    expect(result.models.map((row: any) => row.label).sort()).toEqual(["magpie-codex / gpt-6.1-sol", "openai / gpt-6.1-sol"]);
    expect(await daily("group=model&range=custom&from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z")).toEqual([]);
  });
});
