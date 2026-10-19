/**
 * 按当前定价表重算 turns.cost_usd，并回写 sessions.total_cost_usd。
 * 用于 open-grok-build 等客户端漏计 cache 后的历史修正。
 */
import type { Database } from "bun:sqlite";
import { costService } from "./cost";
import { recalculateSessionCost } from "./cursorEnrich";

export interface RepriceOptions {
  sessionId?: string;
  dryRun?: boolean;
  /** ISO 时间下界（含），默认不限 */
  from?: string;
  /** ISO 时间上界（含），默认不限 */
  to?: string;
  /** 仅这些 provider（小写比较） */
  providers?: string[];
  /** 模型名子串匹配（不区分大小写） */
  modelContains?: string;
  /** 最多处理条数，默认 50000 */
  limit?: number;
}

export interface RepriceResult {
  dry_run: boolean;
  scanned: number;
  updated: number;
  sessions_touched: number;
  delta_usd: number;
  sample: Array<{
    id: string;
    provider: string;
    model: string;
    old_cost: number;
    new_cost: number;
  }>;
}

type TurnRow = {
  agent: string | null;
  id: string;
  session_id: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
};

export function repriceTurns(db: Database, options: RepriceOptions = {}): RepriceResult {
  const limit = Math.min(Math.max(options.limit ?? 50_000, 1), 200_000);
  const clauses: string[] = ["1=1"];
  const params: Record<string, string | number> = { $limit: limit };

  if (options.sessionId) {
    clauses.push("session_id = $session_id");
    params.$session_id = options.sessionId;
  }
  if (options.from) {
    clauses.push("created_at >= $from");
    params.$from = options.from;
  }
  if (options.to) {
    clauses.push("created_at <= $to");
    params.$to = options.to;
  }
  if (options.providers?.length) {
    const placeholders = options.providers.map((_, i) => `$p${i}`);
    clauses.push(`lower(COALESCE(provider, '')) IN (${placeholders.join(", ")})`);
    options.providers.forEach((p, i) => {
      params[`$p${i}`] = p.toLowerCase();
    });
  }
  if (options.modelContains?.trim()) {
    clauses.push("lower(COALESCE(model, '')) LIKE $model_like");
    params.$model_like = `%${options.modelContains.trim().toLowerCase()}%`;
  }

  const rows = db
    .query(
      `
      SELECT id, session_id, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, cost_usd,
              (SELECT agent FROM sessions WHERE sessions.id = turns.session_id) AS agent
      FROM turns
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC
      LIMIT $limit
    `,
    )
    .all(params) as TurnRow[];

  const updateTurn = db.query(`UPDATE turns SET cost_usd = $cost WHERE id = $id`);
  const sessionIds = new Set<string>();
  let updated = 0;
  let delta = 0;
  const sample: RepriceResult["sample"] = [];

  const tx = db.transaction((turns: TurnRow[]) => {
    for (const t of turns) {
      const provider = t.provider || "";
      const model = t.model || "";
      if (!provider || !model) continue;

      const newCost = costService.compute(provider, model, {
        input_tokens: t.input_tokens ?? 0,
        output_tokens: t.output_tokens ?? 0,
        cache_read_tokens: t.cache_read_tokens ?? 0,
        cache_write_tokens: t.cache_write_tokens ?? 0,
        reasoning_tokens: t.reasoning_tokens ?? 0,
        output_includes_reasoning: t.agent === "codex",
      });

      // 估出 0 表示无定价匹配，保留原值
      if (newCost <= 0) continue;

      const oldCost = Number(t.cost_usd ?? 0);
      if (Math.abs(newCost - oldCost) < 1e-9) continue;

      if (!options.dryRun) {
        updateTurn.run({ $id: t.id, $cost: newCost });
      }
      updated += 1;
      delta += newCost - oldCost;
      sessionIds.add(t.session_id);
      if (sample.length < 20) {
        sample.push({
          id: t.id,
          provider,
          model,
          old_cost: oldCost,
          new_cost: newCost,
        });
      }
    }
    if (!options.dryRun) {
      for (const sid of sessionIds) recalculateSessionCost(db, sid);
    }
  });

  tx(rows);

  return {
    dry_run: options.dryRun ?? false,
    scanned: rows.length,
    updated,
    sessions_touched: sessionIds.size,
    delta_usd: Math.round(delta * 1_000_000_000) / 1_000_000_000,
    sample,
  };
}
