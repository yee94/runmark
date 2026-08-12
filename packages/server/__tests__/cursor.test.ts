import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { enrichSessionUsage, recalculateSessionTotals, normalizeCursorModel, modelsCompatible } from "../src/services/cursorEnrich";
import { enqueueCursorSessions, dequeueNextPending } from "../src/services/cursorEnrichQueue";
import { sessionTokenToCookies, CursorService } from "../src/services/cursor";
import { encryptCookieJar } from "../src/services/cursorCrypto";

const CRYPTO_KEY = new Uint8Array(32).fill(7);

describe("cursorEnrich", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
  });

  it("enriches usage onto hook turn by UPDATE only (no new turn row)", () => {
    const startedAt = "2026-06-15T10:00:00.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('conv-abc', 'cursor', 'Test chat', 'cursor', 'composer-2.5', $started_at, 0, 0, 0, 0, 0)
    `).run({ $started_at: startedAt });

    const msgAt = "2026-06-15T10:05:00.000Z";
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m1', 'conv-abc', 'assistant', 'hello', $c)
    `).run({ $c: msgAt });

    db.query(`
      INSERT INTO turns (id, session_id, message_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('m1', 'conv-abc', 'm1', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: msgAt });

    const tsSec = Math.floor(new Date(msgAt).getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES ('ev-1', $ts, 'composer-2.5', 1000, 500, 200, 0, 0, 42, 1, 0, '{}', $synced_at)
    `).run({
      $ts: tsSec,
      $synced_at: new Date().toISOString(),
    });

    const enriched = enrichSessionUsage(db, "conv-abc");
    expect(enriched).toBe(1);

    const session = db.query("SELECT * FROM sessions WHERE id = 'conv-abc'").get() as any;
    expect(session.total_tokens).toBe(1700);
    expect(session.total_cost_usd).toBeCloseTo(0.42, 4);

    const turn = db.query("SELECT * FROM turns WHERE id = 'm1'").get() as any;
    expect(turn.session_id).toBe("conv-abc");
    expect(turn.cost_usd).toBeCloseTo(0.42, 4);
    expect(turn.created_at).toBe(msgAt);

    const legacy = db.query("SELECT id FROM turns WHERE id = 'cursor-usage-ev-1'").get();
    expect(legacy).toBeNull();
  });

  it("does not assign usage when hook turn is missing", () => {
    const t0 = "2026-06-15T10:00:00.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('sess-a', 'cursor', $t0, 0, 0, 0, 0, 0)
    `).run({ $t0: t0 });

    const tsSec = Math.floor(new Date("2026-06-15T10:02:30.000Z").getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES ('ev-only', $ts, 'composer-2.5', 100, 50, 0, 0, 0, 10, 1, 0, '{}', $synced_at)
    `).run({ $ts: tsSec, $synced_at: new Date().toISOString() });

    expect(enrichSessionUsage(db, "sess-a")).toBe(0);

    const row = db.query("SELECT enriched_at FROM cursor_usage_events WHERE event_id = 'ev-only'").get() as any;
    expect(row.enriched_at).toBeNull();
  });

  it("matches each usage event to its turn interval (one event per turn)", () => {
    const startedAt = "2026-06-15T10:00:00.000Z";
    const t1At = "2026-06-15T10:05:00.000Z";
    const t2At = "2026-06-15T10:06:00.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('s-multi', 'cursor', $started_at, 0, 0, 0, 0, 0)
    `).run({ $started_at: startedAt });

    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t1', 's-multi', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: t1At });
    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t2', 's-multi', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: t2At });

    const sec1 = Math.floor(new Date("2026-06-15T10:04:55.000Z").getTime() / 1000); // round 1 billing before t1
    const sec2 = Math.floor(new Date("2026-06-15T10:05:55.000Z").getTime() / 1000); // round 2 billing between t1 and t2
    for (const [id, ts, inTok, cents] of [["ev-a", sec1, 100, 10], ["ev-b", sec2, 200, 20]] as const) {
      db.query(`
        INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
        VALUES ($id, $ts, 'composer-2.5', $in_tok, 0, 0, 0, 0, $cents, 1, 0, '{}', $synced_at)
      `).run({ $id: id, $ts: ts, $in_tok: inTok, $cents: cents, $synced_at: new Date().toISOString() });
    }

    expect(enrichSessionUsage(db, "s-multi")).toBe(2);

    const t1 = db.query("SELECT * FROM turns WHERE id = 't1'").get() as any;
    expect(t1.input_tokens).toBe(100);
    expect(t1.cost_usd).toBeCloseTo(0.1, 4);
    expect(t1.created_at).toBe(t1At);

    const t2 = db.query("SELECT * FROM turns WHERE id = 't2'").get() as any;
    expect(t2.input_tokens).toBe(200);
    expect(t2.cost_usd).toBeCloseTo(0.2, 4);
    expect(t2.created_at).toBe(t2At);
  });

  it("leaves future usage pending instead of piling it onto the last hook turn", () => {
    const startedAt = "2026-06-15T10:00:00.000Z";
    const turnAt = "2026-06-15T10:05:00.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('s-overflow', 'cursor', $started_at, 0, 0, 0, 0, 0)
    `).run({ $started_at: startedAt });

    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t1', 's-overflow', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: turnAt });

    const nearSec = Math.floor(new Date("2026-06-15T10:04:50.000Z").getTime() / 1000);
    const futureSec = Math.floor(new Date("2026-06-15T10:10:01.000Z").getTime() / 1000);
    for (const [id, ts, inTok, cents] of [["ev-near", nearSec, 100, 10], ["ev-future", futureSec, 900, 90]] as const) {
      db.query(`
        INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
        VALUES ($id, $ts, 'composer-2.5', $in_tok, 0, 0, 0, 0, $cents, 1, 0, '{}', $synced_at)
      `).run({
        $id: id,
        $ts: ts,
        $in_tok: inTok,
        $cents: cents,
        $synced_at: new Date().toISOString(),
      });
    }

    expect(enrichSessionUsage(db, "s-overflow")).toBe(1);

    const turn = db.query("SELECT * FROM turns WHERE id = 't1'").get() as any;
    expect(turn.input_tokens).toBe(100);
    expect(turn.cost_usd).toBeCloseTo(0.1, 4);

    const pending = db.query("SELECT enriched_at FROM cursor_usage_events WHERE event_id = 'ev-future'").get() as any;
    expect(pending.enriched_at).toBeNull();
  });

  it("accumulates multiple usage events onto one hook turn (one-to-many)", () => {
    const startedAt = "2026-06-15T10:00:00.000Z";
    const turnAt = "2026-06-15T10:05:00.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('s-one-many', 'cursor', $started_at, 0, 0, 0, 0, 0)
    `).run({ $started_at: startedAt });

    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t1', 's-one-many', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: turnAt });

    const evRows = [
      ["ev-a", "2026-06-15T10:02:41.000Z", 32394, 5027, 14],
      ["ev-b", "2026-06-15T10:04:50.000Z", 1250, 752, 2],
      ["ev-c", "2026-06-15T10:04:55.000Z", 3915, 1196, 4],
    ] as const;
    for (const [id, at, inTok, outTok, cents] of evRows) {
      const ts = Math.floor(new Date(at).getTime() / 1000);
      db.query(`
        INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
        VALUES ($id, $ts, 'composer-2.5', $in_tok, $out_tok, 0, 0, 0, $cents, 1, 0, '{}', $synced_at)
      `).run({
        $id: id,
        $ts: ts,
        $in_tok: inTok,
        $out_tok: outTok,
        $cents: cents,
        $synced_at: new Date().toISOString(),
      });
    }

    expect(enrichSessionUsage(db, "s-one-many")).toBe(3);

    const turn = db.query("SELECT * FROM turns WHERE id = 't1'").get() as any;
    expect(turn.input_tokens).toBe(37559);
    expect(turn.output_tokens).toBe(6975);
    expect(turn.total_tokens).toBe(44534);
    expect(turn.cost_usd).toBeCloseTo(0.2, 4);

    const session = db.query("SELECT * FROM sessions WHERE id = 's-one-many'").get() as any;
    expect(session.total_tokens).toBe(44534);
    expect(session.total_cost_usd).toBeCloseTo(0.2, 4);
  });

  it("matches usage when Hook model suffix differs from Usage API model", () => {
    const startedAt = "2026-07-09T03:20:00.000Z";
    const turnAt = "2026-07-09T03:37:50.000Z";
    db.query(`
      INSERT INTO sessions (id, agent, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('b38f07ce', 'cursor', $started_at, $ended_at, 0, 0, 0, 0, 0)
    `).run({ $started_at: startedAt, $ended_at: "2026-07-09T03:40:00.000Z" });

    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('assistant-1', 'b38f07ce', 'grok-4.5-fast-xhigh', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, $c)
    `).run({ $c: turnAt });

    // Usage 常在请求发起时记费，早于 Hook turn 完成时间
    const ts = Math.floor(new Date("2026-07-09T03:37:40.000Z").getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES ('ev-model', $ts, 'grok-4.5-fast-high', 10912, 3086, 538624, 0, 0, 31.89, 1, 0, $raw, $synced_at)
    `).run({
      $ts: ts,
      $raw: JSON.stringify({ conversationId: "b38f07ce" }),
      $synced_at: new Date().toISOString(),
    });

    expect(enrichSessionUsage(db, "b38f07ce")).toBe(1);
    const turn = db.query("SELECT * FROM turns WHERE id = 'assistant-1'").get() as any;
    expect(turn.input_tokens).toBe(10912);
    expect(turn.cost_usd).toBeCloseTo(0.3189, 4);
  });

  it("uses conversationId to claim usage outside the ended_at padding window", () => {
    // ended_at+5min = 03:26；event 在 03:28（窗外），turn 在 03:30（event 仍落在 turn 区间内）
    db.query(`
      INSERT INTO sessions (id, agent, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('conv-late', 'cursor', '2026-07-09T03:20:00.000Z', '2026-07-09T03:21:00.000Z', 0, 0, 0, 0, 0)
    `).run();

    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t-late', 'conv-late', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-07-09T03:30:00.000Z')
    `).run();

    const tsOutside = Math.floor(new Date("2026-07-09T03:28:00.000Z").getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES ('ev-late', $ts, 'composer-2.5', 100, 50, 0, 0, 0, 12, 1, 0, $raw, $synced_at)
    `).run({
      $ts: tsOutside,
      $raw: JSON.stringify({ conversationId: "conv-late" }),
      $synced_at: new Date().toISOString(),
    });

    expect(enrichSessionUsage(db, "conv-late")).toBe(1);
    const turn = db.query("SELECT * FROM turns WHERE id = 't-late'").get() as any;
    expect(turn.input_tokens).toBe(100);
    expect(turn.cost_usd).toBeCloseTo(0.12, 4);
  });

  it("recalculateSessionTotals ignores legacy cursor-usage-* rows", () => {
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('s1', 'cursor', $t, 0, 0, 0, 0, 0)
    `).run({ $t: new Date().toISOString() });

    const c = new Date().toISOString();
    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES ('t1', 's1', 'm', 'cursor', 10, 20, 0, 0, 0, 30, 0, 0.01, $c),
             ('cursor-usage-legacy', 's1', 'm', 'cursor', 999, 999, 0, 0, 0, 1998, 0, 9.99, $c)
    `).run({ $c: c });

    recalculateSessionTotals(db, "s1");
    const session = db.query("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(session.total_tokens).toBe(30);
    expect(session.total_cost_usd).toBeCloseTo(0.01, 4);
    expect(session.request_count).toBe(1);
  });
});

describe("normalizeCursorModel", () => {
  it("strips quality tiers but keeps product fast suffix", () => {
    expect(normalizeCursorModel("grok-4.5-fast-xhigh")).toBe("grok-4.5-fast");
    expect(normalizeCursorModel("grok-4.5-fast-high")).toBe("grok-4.5-fast");
    expect(modelsCompatible("grok-4.5-fast-xhigh", "grok-4.5-fast-high")).toBe(true);
    expect(modelsCompatible("composer-2.5-fast", "composer-2.5")).toBe(false);
    expect(modelsCompatible("composer-2.5", "claude-sonnet-4")).toBe(false);
  });
});

describe("conversationId exclusive enrich", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
  });

  it("does not swallow other sessions' no-cid events when this session has conversationId bills", () => {
    // 长开 session：6/25 开、7/9 才有第二轮；时间窗会覆盖大量无 cid 账单
    db.query(`
      INSERT INTO sessions (id, agent, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('sess-long', 'cursor', '2026-06-25T13:06:00.000Z', NULL, 0, 0, 0, 0, 0)
    `).run();
    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES
        ('t1', 'sess-long', 'composer-2.5-fast', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-06-25T13:07:00.000Z'),
        ('t2', 'sess-long', 'composer-2.5-fast', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-07-09T03:05:00.000Z')
    `).run();

    const ownTs = Math.floor(new Date("2026-07-09T03:03:40.000Z").getTime() / 1000);
    const strayTs = Math.floor(new Date("2026-07-08T12:00:00.000Z").getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES
        ('own-1', $own, 'composer-2.5-fast', 100, 50, 0, 0, 0, 20, 1, 0, $raw, $synced),
        ('stray-huge', $stray, 'composer-2.5-fast', 999999, 999999, 0, 0, 0, 99999, 1, 0, '{}', $synced)
    `).run({
      $own: ownTs,
      $stray: strayTs,
      $raw: JSON.stringify({ conversationId: "sess-long" }),
      $synced: new Date().toISOString(),
    });

    expect(enrichSessionUsage(db, "sess-long")).toBe(1);
    const t2 = db.query("SELECT * FROM turns WHERE id = 't2'").get() as any;
    expect(t2.input_tokens).toBe(100);
    expect(t2.cost_usd).toBeCloseTo(0.2, 4);
    const stray = db.query("SELECT enriched_at FROM cursor_usage_events WHERE event_id = 'stray-huge'").get() as any;
    expect(stray.enriched_at).toBeNull();
  });

  it("caps turn lookback so multi-day gaps do not pile no-cid bills onto the next turn", () => {
    db.query(`
      INSERT INTO sessions (id, agent, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('sess-gap', 'cursor', '2026-06-25T13:06:00.000Z', NULL, 0, 0, 0, 0, 0)
    `).run();
    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES
        ('g1', 'sess-gap', 'composer-2.5-fast', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-06-25T13:07:00.000Z'),
        ('g2', 'sess-gap', 'composer-2.5-fast', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-07-09T03:05:00.000Z')
    `).run();

    // 无 conversationId：落在两轮之间但距 g2 超过 20min，不应挂到 g2
    const midTs = Math.floor(new Date("2026-07-08T12:00:00.000Z").getTime() / 1000);
    const nearTs = Math.floor(new Date("2026-07-09T03:00:00.000Z").getTime() / 1000);
    db.query(`
      INSERT INTO cursor_usage_events (event_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at)
      VALUES
        ('far-mid', $mid, 'composer-2.5-fast', 1, 1, 0, 0, 0, 99999, 1, 0, '{}', $synced),
        ('near-g2', $near, 'composer-2.5-fast', 10, 5, 0, 0, 0, 15, 1, 0, '{}', $synced)
    `).run({
      $mid: midTs,
      $near: nearTs,
      $synced: new Date().toISOString(),
    });

    expect(enrichSessionUsage(db, "sess-gap")).toBe(1);
    const g2 = db.query("SELECT * FROM turns WHERE id = 'g2'").get() as any;
    expect(g2.input_tokens).toBe(10);
    expect(g2.cost_usd).toBeCloseTo(0.15, 4);
    const far = db.query("SELECT enriched_at FROM cursor_usage_events WHERE event_id = 'far-mid'").get() as any;
    expect(far.enriched_at).toBeNull();
  });
});

describe("cursorEnrichQueue", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('c1', 'cursor', '2026-06-15T10:00:00.000Z', 0, 0, 0, 0, 0)
    `).run();
  });

  it("enqueue dedupes cursor sessions and returns FIFO order", () => {
    expect(enqueueCursorSessions(db, ["c1", "missing"])).toBe(1);
    expect(enqueueCursorSessions(db, ["c1"])).toBe(1);

    const first = dequeueNextPending(db);
    expect(first?.session_id).toBe("c1");
    expect(first?.status).toBe("pending");
  });
});

describe("sessionTokenToCookies", () => {
  it("wraps WorkosCursorSessionToken", () => {
    const cookies = sessionTokenToCookies("abc123");
    expect(cookies[0].name).toBe("WorkosCursorSessionToken");
    expect(cookies[0].value).toBe("abc123");
  });
});

describe("CursorService session helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
  });

  it("resolveCursorSessionIds filters non-cursor sessions", () => {
    db.query(`
      INSERT INTO sessions (id, agent, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('c1', 'cursor', '2026-06-15T10:00:00.000Z', 0, 0, 0, 0, 0),
             ('o1', 'opencode', '2026-06-15T10:00:00.000Z', 0, 0, 0, 0, 0)
    `).run();

    const cfg = {
      cursorSyncEnabled: true,
      cursorCryptoKey: CRYPTO_KEY,
    } as any;
    const service = new CursorService(db, cfg, { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} } as any);

    expect(service.resolveCursorSessionIds(["c1", "o1", "missing"])).toEqual(["c1"]);
  });

  it("sessionTimeRangesMs splits multi-day turn gaps into separate pull windows", () => {
    db.query(`
      INSERT INTO sessions (id, agent, started_at, ended_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('c1', 'cursor', '2026-06-15T10:00:00.000Z', NULL, 0, 0, 0, 0, 0)
    `).run();
    db.query(`
      INSERT INTO turns (id, session_id, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, duration_ms, cost_usd, created_at)
      VALUES
        ('t-early', 'c1', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-06-15T10:05:00.000Z'),
        ('t-late', 'c1', 'composer-2.5', 'cursor', 0, 0, 0, 0, 0, 0, 0, 0, '2026-07-09T03:05:00.000Z')
    `).run();

    const cfg = { cursorSyncEnabled: true, cursorCryptoKey: CRYPTO_KEY } as any;
    const service = new CursorService(db, cfg, { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} } as any);
    const ranges = service.sessionTimeRangesMs(["c1"]);
    expect(ranges.length).toBe(2);

    const lookback = 20 * 60 * 1000;
    const padBefore = 10 * 60 * 1000;
    const earlyTurn = new Date("2026-06-15T10:05:00.000Z").getTime();
    const lateTurn = new Date("2026-07-09T03:05:00.000Z").getTime();
    expect(Number(ranges[0]!.startDate)).toBe(earlyTurn - lookback - padBefore);
    expect(Number(ranges[1]!.startDate)).toBe(lateTurn - lookback - padBefore);
    // 两窗不相连，不会合成跨周的一次大拉取
    expect(Number(ranges[0]!.endDate)).toBeLessThan(Number(ranges[1]!.startDate));
  });
});

describe("cursor cookie encryption", () => {
  it("roundtrips cookie jar", async () => {
    const jar = await encryptCookieJar(sessionTokenToCookies("secret"), CRYPTO_KEY);
    expect(jar.length).toBeGreaterThan(20);
  });
});
