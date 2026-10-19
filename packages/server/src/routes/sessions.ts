import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { type ModelPricing } from "@agent-tracker/shared";
import { getPricing } from "../db";
import { displayCny, withCostCny, withPricingCny, withTotalCostCny } from "../services/currency";
import { DEFAULT_STATS_RANGE, beijingDateExpr, parseModelSort, resolveStatsRange, sessionsTimeClause, turnsTimeClause } from "../services/stats";
import { forkFieldsForSession } from "../services/fork";
import { costService } from "../services/cost";
import { repriceTurns } from "../services/reprice";

type SessionRow = Record<string, unknown> & {
  id: string;
  title?: string | null;
  parent_session_id?: string | null;
  started_at: string;
  ended_at?: string | null;
  provider?: string | null;
  model?: string | null;
  total_tokens?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  request_count?: number;
};

type ChildAggRow = {
  total_tokens?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  request_count?: number;
};

const lastMessageStmt = (db: Database) =>
  db.query<{ last_at: string | null }, { $id: string }>(
    "SELECT MAX(created_at) as last_at FROM messages WHERE session_id = $id",
  );

const lastTurnStmt = (db: Database) =>
  db.query<{ last_at: string | null }, { $id: string }>(
    "SELECT MAX(created_at) as last_at FROM turns WHERE session_id = $id",
  );

const firstMessageStmt = (db: Database) =>
  db.query<{ first_at: string | null }, { $id: string }>(
    "SELECT MIN(created_at) as first_at FROM messages WHERE session_id = $id",
  );

const firstTurnStmt = (db: Database) =>
  db.query<{ first_at: string | null }, { $id: string }>(
    "SELECT MIN(created_at) as first_at FROM turns WHERE session_id = $id",
  );

/** 取 ISO 时间字符串中最新的一条（用于 last_activity_at） */
function maxIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

/** 取 ISO 时间字符串中最早的一条（用于 duration 起点；排除 sessionStart 与首条消息之间的空闲） */
function minIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

/** 将查询参数钳制为整数范围 */
function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** LIKE 模式转义：% _ \ */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** 会话列表按最后活动时间倒序（消息 / turn / ended_at / started_at 取最大） */
const SESSION_LAST_ACTIVITY_ORDER = `(
  SELECT MAX(t) FROM (
    SELECT started_at AS t FROM sessions s0 WHERE s0.id = sessions.id
    UNION ALL
    SELECT ended_at AS t FROM sessions s1 WHERE s1.id = sessions.id AND ended_at IS NOT NULL
    UNION ALL
    SELECT created_at AS t FROM messages WHERE session_id = sessions.id
    UNION ALL
    SELECT created_at AS t FROM turns WHERE session_id = sessions.id
  )
)`;

/** 用量导入脚本写入的合成 / mock session，默认不进入 Dashboard 会话列表 */
const SYNTHETIC_SESSION_EXCLUDE_SQL = `
  id NOT LIKE 'agent-tracker-synthetic-import%'
  AND COALESCE(title, '') NOT LIKE '[runmark-import]%'
`;

/** OpenCode SmartFetch 临时会话（与 OpenChamber HIDDEN_SESSION_TITLES 对齐） */
const HIDDEN_SESSION_EXCLUDE_SQL = `
  COALESCE(title, '') != 'smartfetch-secondary'
`;

/** 无 message / turn / tool 的空壳会话（Cursor sessionStart 或 tool FK 幽灵），默认不进列表 */
const EMPTY_SESSION_EXCLUDE_SQL = `
  (
    EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
    OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = sessions.id)
    OR EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.session_id = sessions.id)
  )
`;

const childAggStmt = (db: Database) =>
  db.query<ChildAggRow, { $id: string }>(`
    SELECT
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
      COALESCE(SUM(total_input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(request_count), 0) as request_count
    FROM sessions
    WHERE parent_session_id = $id
  `);

/** 子 session 聚合进父会话展示（token / cost / 请求数） */
function withChildRollup(db: Database, row: SessionRow): SessionRow {
  if (row.parent_session_id) return row;
  const child = childAggStmt(db).get({ $id: row.id });
  if (!child) return row;
  return {
    ...row,
    total_tokens: (row.total_tokens ?? 0) + (child.total_tokens ?? 0),
    total_cost_usd: (row.total_cost_usd ?? 0) + (child.total_cost_usd ?? 0),
    total_input_tokens: (row.total_input_tokens ?? 0) + (child.total_input_tokens ?? 0),
    total_output_tokens: (row.total_output_tokens ?? 0) + (child.total_output_tokens ?? 0),
    request_count: (row.request_count ?? 0) + (child.request_count ?? 0),
  };
}

/** 子 session 若未写入 model，从 turn 聚合回填（subagent 展示用） */
function enrichSessionModelHints(db: Database, row: SessionRow): SessionRow {
  if (row.model) return row;
  const turn = db.query(
    "SELECT model, provider FROM turns WHERE session_id = $id ORDER BY created_at DESC LIMIT 1",
  ).get({ $id: row.id }) as { model?: string | null; provider?: string | null } | null;
  if (!turn?.model) return row;
  return {
    ...row,
    model: turn.model,
    provider: row.provider ?? turn.provider ?? null,
  };
}

/** 将 sessions.model（逗号分隔）拆成展示用 models[] */
function splitStoredModels(value: string | null | undefined): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(value || "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(name);
  }
  return parts;
}

/** 会话列表/详情序列化：summary 优先 title，duration_ms 为 started_at 至最后活动时间 */
function serializeSession(db: Database, row: SessionRow) {
  const rolled = withChildRollup(db, row);
  const lastMsg = lastMessageStmt(db).get({ $id: rolled.id });
  const lastTurn = lastTurnStmt(db).get({ $id: rolled.id });
  const firstMsg = firstMessageStmt(db).get({ $id: rolled.id });
  const firstTurn = firstTurnStmt(db).get({ $id: rolled.id });
  const models = splitStoredModels(rolled.model as string | null | undefined);
  const lastActivityAt = maxIsoTimestamp(
    rolled.started_at,
    rolled.ended_at,
    lastMsg?.last_at,
    lastTurn?.last_at,
  );
  const firstActivityAt = minIsoTimestamp(firstMsg?.first_at, firstTurn?.first_at) || rolled.started_at;
  const durationMs = Math.max(
    0,
    new Date(lastActivityAt).getTime() - new Date(firstActivityAt).getTime(),
  );
  return {
    ...rolled,
    ...forkFieldsForSession(db, rolled),
    // model 保持原存储串；models 为展示用拆分结果
    models,
    summary: (rolled.title && String(rolled.title).trim()) || rolled.id,
    duration_ms: durationMs,
    last_activity_at: lastActivityAt,
  };
}

export function createSessionsRoute(db: Database) {
  const app = new Hono();

  app.get("/v1/sessions", (c) => {
    const limit = clampInt(c.req.query("limit"), 50, 1, 200);
    const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);
    const user_email = c.req.query("user_email");
    const includeImports = c.req.query("include_imports") === "1";
    const q = (c.req.query("q") ?? "").trim();

    let query = "SELECT * FROM sessions WHERE parent_session_id IS NULL";
    const params: {
      $limit: number;
      $offset: number;
      $user_email?: string;
      $q?: string;
    } = { $limit: limit, $offset: offset };

    // 合成用量导入（mock）默认不进入「最近会话」列表；调试可加 ?include_imports=1
    if (!includeImports) {
      query += ` AND (${SYNTHETIC_SESSION_EXCLUDE_SQL})`;
    }

    // SmartFetch 临时会话默认隐藏；详情页仍可按 id 直达
    query += ` AND (${HIDDEN_SESSION_EXCLUDE_SQL})`;

    // 空壳会话（无对话内容）默认隐藏；详情页仍可按 id 直达
    query += ` AND (${EMPTY_SESSION_EXCLUDE_SQL})`;

    if (user_email) {
      query += " AND user_email = $user_email";
      params.$user_email = user_email;
    }

    // 全局搜索：标题 / AISummary / 消息正文（含子会话正文，结果归到根会话）
    if (q) {
      params.$q = `%${escapeLikePattern(q)}%`;
      query += ` AND (
        COALESCE(title, '') LIKE $q ESCAPE '\\'
        OR COALESCE(AISummary, '') LIKE $q ESCAPE '\\'
        OR id IN (
          SELECT CASE
            WHEN s2.parent_session_id IS NOT NULL AND TRIM(s2.parent_session_id) != ''
            THEN s2.parent_session_id
            ELSE s2.id
          END
          FROM messages m
          JOIN sessions s2 ON s2.id = m.session_id
          WHERE m.content LIKE $q ESCAPE '\\'
        )
      )`;
    }

    query += ` ORDER BY ${SESSION_LAST_ACTIVITY_ORDER} DESC LIMIT $limit OFFSET $offset`;
    const rows = db.query(query).all(params) as SessionRow[];

    return c.json(rows.map((row) => withTotalCostCny(serializeSession(db, row))));
  });

  app.get("/v1/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: id }) as SessionRow | null;
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(withTotalCostCny(serializeSession(db, session)));
  });

  app.get("/v1/sessions/:id/messages", (c) => {
    const id = c.req.param("id");
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);

    const rows = db.query(
      "SELECT * FROM messages WHERE session_id = $id ORDER BY created_at ASC LIMIT $limit OFFSET $offset",
    ).all({ $id: id, $limit: limit, $offset: offset });

    return c.json(rows);
  });

  app.get("/v1/sessions/:id/turns", (c) => {
    const id = c.req.param("id");
    const rows = db.query(
      "SELECT * FROM turns WHERE session_id = $id ORDER BY created_at ASC",
    ).all({ $id: id }) as { cost_usd?: number }[];
    return c.json(rows.map(withCostCny));
  });

  app.get("/v1/sessions/:id/children", (c) => {
    const id = c.req.param("id");
    const rows = db.query(
      "SELECT * FROM sessions WHERE parent_session_id = $id ORDER BY started_at ASC",
    ).all({ $id: id }) as SessionRow[];
    return c.json(rows.map((row) => withTotalCostCny(serializeSession(db, enrichSessionModelHints(db, row)))));
  });

  app.get("/v1/sessions/:id/tool-calls", (c) => {
    const id = c.req.param("id");
    const rows = db.query(
      "SELECT * FROM tool_calls WHERE session_id = $id ORDER BY created_at ASC",
    ).all({ $id: id });
    return c.json(rows);
  });

  return app;
}

export function createTurnsRoute(db: Database) {
  const app = new Hono();

  app.get("/v1/turns", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const model = c.req.query("model");
    const provider = c.req.query("provider");

    let query = "SELECT * FROM turns";
    const params: { $limit: number; $offset: number; $model?: string; $provider?: string } = { $limit: limit, $offset: offset };

    const conditions: string[] = [];
    if (model) {
      conditions.push("model = $model");
      params.$model = model;
    }
    if (provider) {
      conditions.push("provider = $provider");
      params.$provider = provider;
    }
    if (conditions.length) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY created_at DESC LIMIT $limit OFFSET $offset";
    const rows = db.query(query).all(params) as { cost_usd?: number }[];
    return c.json(rows.map(withCostCny));
  });

  return app;
}

export function createPricingRoute(db: Database) {
  const app = new Hono();

  app.get("/v1/pricing", (c) => {
    const rows = getPricing(db).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    return c.json(rows.map(withPricingCny));
  });

  app.put("/v1/pricing", async (c) => {
    const body = await c.req.json<{
      provider: string;
      model: string;
      input_price: number;
      output_price: number;
      cache_read_price?: number;
      cache_write_price?: number;
      reasoning_price?: number;
      context_tiers?: ModelPricing["context_tiers"];
    }>();

    if (body.context_tiers !== undefined && (!Array.isArray(body.context_tiers) || body.context_tiers.some((tier) =>
      !tier || ![tier.above, tier.input_price, tier.output_price].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
      [tier.cache_read_price, tier.cache_write_price, tier.reasoning_price].some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
    ))) return c.json({ error: "Invalid context_tiers" }, 400);
    // 旧版价格编辑器不传分档字段时保留已有分档；显式 [] 可清除。
    const tiers = body.context_tiers ?? getPricing(db).find((p) => p.provider === body.provider && p.model === body.model)?.context_tiers;

    const stmt = db.query(`
      INSERT INTO pricing (provider, model, input_price, output_price, cache_read_price, cache_write_price, reasoning_price, context_tiers, updated_at)
      VALUES ($provider, $model, $input_price, $output_price, $cache_read_price, $cache_write_price, $reasoning_price, $context_tiers, $updated_at)
      ON CONFLICT(provider, model) DO UPDATE SET
        input_price = excluded.input_price,
        output_price = excluded.output_price,
        cache_read_price = excluded.cache_read_price,
        cache_write_price = excluded.cache_write_price,
        reasoning_price = excluded.reasoning_price,
        context_tiers = excluded.context_tiers,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      $provider: body.provider,
      $model: body.model,
      $input_price: body.input_price,
      $output_price: body.output_price,
      $cache_read_price: body.cache_read_price ?? null,
      $cache_write_price: body.cache_write_price ?? null,
      $reasoning_price: body.reasoning_price ?? null,
      $context_tiers: tiers ? JSON.stringify(tiers) : null,
      $updated_at: new Date().toISOString(),
    });

    costService.addOrUpdatePricing({
      provider: body.provider,
      model: body.model,
      input_price: body.input_price,
      output_price: body.output_price,
      cache_read_price: body.cache_read_price,
      cache_write_price: body.cache_write_price,
      reasoning_price: body.reasoning_price,
      context_tiers: tiers,
    });

    return c.json({ ok: true }, 200);
  });

  /**
   * 按当前定价表重算历史 turns（修复 open-grok-build 漏 cache 等）。
   * Body 可选：from / to / providers / model_contains / limit
   */
  app.post("/v1/pricing/reprice", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      from?: string;
      to?: string;
      providers?: string[];
      model_contains?: string;
      limit?: number;
      session_id?: string;
      dry_run?: boolean;
    };

    if (body.session_id !== undefined && (typeof body.session_id !== "string" || !body.session_id.trim())) {
      return c.json({ error: "Invalid session_id" }, 400);
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
      return c.json({ error: "Invalid dry_run" }, 400);
    }

    const result = repriceTurns(db, {
      from: body.from,
      to: body.to,
      providers: body.providers,
      modelContains: body.model_contains,
      limit: body.limit,
      sessionId: body.session_id,
      dryRun: body.dry_run,
    });

    return c.json({ ok: true, ...result }, 200);
  });

  return app;
}

export function createStatsRoute(db: Database) {
  const app = new Hono();

  app.get("/v1/stats/summary", (c) => {
    const { from, to } = resolveStatsRange(c.req.query("range"), { from: c.req.query("from"), to: c.req.query("to") });
    const params = { $from: from, $to: to };

    const totalSessions = db.query(
      `SELECT COUNT(*) as count FROM sessions WHERE parent_session_id IS NULL AND ${sessionsTimeClause()}`,
    ).get(params) as { count?: number };

    const turnStats = db.query(`
      SELECT
        COUNT(*) as turn_count,
        COALESCE(SUM(total_tokens), 0) as total,
        COALESCE(SUM(input_tokens), 0) as input,
        COALESCE(SUM(output_tokens), 0) as output,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM turns
      WHERE ${turnsTimeClause()}
    `).get(params) as {
      turn_count?: number;
      total?: number;
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      reasoning?: number;
      cost_usd?: number;
    };

    const costUsd = turnStats?.cost_usd ?? 0;
    return c.json({
      sessions: totalSessions?.count ?? 0,
      turns: turnStats?.turn_count ?? 0,
      tokens: {
        total: turnStats?.total ?? 0,
        input: turnStats?.input ?? 0,
        output: turnStats?.output ?? 0,
        cache_read: turnStats?.cache_read ?? 0,
        cache_write: turnStats?.cache_write ?? 0,
        reasoning: turnStats?.reasoning ?? 0,
      },
      cost_usd: costUsd,
      cost_cny: displayCny(costUsd),
      range: c.req.query("range") ?? DEFAULT_STATS_RANGE,
      from,
      to,
    });
  });

  app.get("/v1/stats/by-model", (c) => {
    const { from, to } = resolveStatsRange(c.req.query("range"), { from: c.req.query("from"), to: c.req.query("to") });
    const sort = parseModelSort(c.req.query("sort"));
    const orderBy = sort === "tokens" ? "total_tokens DESC" : "total_cost_usd DESC";

    const rows = db.query(`
      SELECT model, provider,
        COUNT(*) as turn_count,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens,
        SUM(reasoning_tokens) as reasoning_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost_usd) as total_cost_usd,
        AVG(duration_ms) as avg_duration_ms
      FROM turns
      WHERE ${turnsTimeClause()} AND model != ''
      GROUP BY model, provider
      ORDER BY ${orderBy}
    `).all({ $from: from, $to: to }) as { total_cost_usd?: number }[];

    return c.json(rows.map(withTotalCostCny));
  });

  app.get("/v1/stats/by-agent", (c) => {
    const { from, to } = resolveStatsRange(c.req.query("range"), { from: c.req.query("from"), to: c.req.query("to") });
    const params = { $from: from, $to: to };

    const rows = db.query(`
      SELECT s.agent,
        COUNT(DISTINCT s.id) as session_count,
        COUNT(*) as turn_count,
        COALESCE(SUM(s.total_tokens), 0) as total_tokens,
        COALESCE(SUM(s.total_cost_usd), 0) as total_cost_usd
      FROM sessions s
      WHERE s.parent_session_id IS NULL AND s.agent != '' AND COALESCE(s.total_cost_usd, 0) > 0
        AND ${sessionsTimeClause("s")}
      GROUP BY s.agent
      ORDER BY total_cost_usd DESC
    `).all(params) as { total_cost_usd?: number }[];

    return c.json(rows.map(withTotalCostCny));
  });

  app.get("/v1/stats/by-tool", (c) => {
    const rows = db.query(`
      SELECT tool_name,
        COUNT(*) as call_count,
        SUM(additions) as total_additions,
        SUM(deletions) as total_deletions,
        AVG(duration_ms) as avg_duration_ms
      FROM tool_calls GROUP BY tool_name ORDER BY call_count DESC
    `).all();
    return c.json(rows);
  });

  app.get("/v1/stats/daily", (c) => {
    const { from, to } = resolveStatsRange(c.req.query("range"), { from: c.req.query("from"), to: c.req.query("to") });
    const params = { $from: from, $to: to };

    const beijingDate = beijingDateExpr("t.created_at");
    const rows = db.query(`
      SELECT ${beijingDate} as date,
        COUNT(DISTINCT t.session_id) as session_count,
        COUNT(*) as turn_count,
        COALESCE(SUM(t.input_tokens), 0) as input_tokens,
        COALESCE(SUM(t.cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(t.cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(t.output_tokens), 0) as output_tokens,
        COALESCE(SUM(t.reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(SUM(t.total_tokens), 0) as total_tokens,
        COALESCE(SUM(t.cost_usd), 0) as total_cost_usd
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
      WHERE s.parent_session_id IS NULL AND ${turnsTimeClause("t")}
      GROUP BY ${beijingDate}
      ORDER BY date ASC
    `).all(params) as { date: string; total_cost_usd?: number }[];

    const modelRows = db.query(`
      SELECT ${beijingDate} as date,
        t.provider,
        t.model,
        COUNT(*) as turn_count,
        COALESCE(SUM(t.total_tokens), 0) as total_tokens,
        COALESCE(SUM(t.cost_usd), 0) as total_cost_usd
      FROM turns t
      JOIN sessions s ON s.id = t.session_id
      WHERE s.parent_session_id IS NULL AND ${turnsTimeClause("t")}
      GROUP BY ${beijingDate}, t.provider, t.model
      ORDER BY date ASC, total_cost_usd DESC
    `).all(params) as { date: string; provider: string; model: string; turn_count: number; total_tokens: number; total_cost_usd: number }[];

/** 按 date 聚合模型行 */
    const modelsByDate = new Map<string, any[]>();
    for (const mr of modelRows) {
      if (!modelsByDate.has(mr.date)) modelsByDate.set(mr.date, []);
      const { provider, model } = mr;
      const pNorm = (provider ?? "").trim().toLowerCase();
      const mNorm = (model ?? "").trim().toLowerCase();
      const label = (!pNorm || pNorm === mNorm) ? model : (!mNorm || mNorm === pNorm) ? provider : `${provider} / ${model}`;
      modelsByDate.get(mr.date)!.push(withTotalCostCny({ ...mr, label }));
    }

    return c.json(rows.map((row) => ({
      ...withTotalCostCny(row),
      models: modelsByDate.get(row.date) ?? [],
    })));
  });

  return app;
}
