import { withTotalCostCny } from "./currency";
import type { ModelSort } from "./stats";

const SUM_FIELDS = [
  "turn_count", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "reasoning_tokens", "total_tokens", "total_cost_usd",
] as const;

export type ModelStatsRow = Record<typeof SUM_FIELDS[number], number> & {
  model: string;
  provider: string;
  avg_duration_ms: number;
};

export type DailyModelStatsRow = Pick<ModelStatsRow, "model" | "provider" | "turn_count" | "total_tokens" | "total_cost_usd"> & {
  date: string;
};

const VERSIONED_MODEL = /^(?:claude-[a-z]+-\d|gpt-\d|o\d(?:-|$)|deepseek-(?:v\d|r\d)|gemini-\d|grok-\d|glm-\d|qwen\d|hy-\d|composer-\d|doubao-seed-\d|kimi-k\d|llama-\d)/;

/** 仅折叠明确的渠道、上下文标记；路由别名和模型能力变体不推断为某个版本。 */
function modelIdentity(model: string, provider: string): { key: string; name: string } {
  let name = model.trim().toLowerCase();
  const magpieGroup = /^(?:magpie\/)?(?:group|auto)\//.test(name) || /^magpie(?:-|$)/i.test(provider);
  name = name.slice(name.lastIndexOf("/") + 1).replace(/[\s_-]+/gu, "-").replace(/^-|-$/g, "");
  if (magpieGroup) name = name.replace(/^auto-/, "");
  if (!VERSIONED_MODEL.test(name)) return { key: model, name: model };

  // 不能复用定价别名：haiku、preview 等按同价估算，不代表同一个实际模型。
  name = name.replace(/(?:-volc-ioa|-ioa|-official|-external|-internal)+$/, "");
  // 对齐 Magpie provider/group.go 的 sameModel：仅去掉紧凑日期，不动 OpenAI 的 YYYY-MM-DD 或四位版本。
  name = name.replace(/[-@](?:20\d{6}|(?:2[3-9]|3\d)(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/, "");
  name = name.replace(/\[\d+(?:k|m)\]$/, "").replace(/(?:@|-)\d+(?:k|m)(?=$|[-:][a-z])/, "");
  return { key: name.replace(/(\d)[.p](?=\d)/g, "$1-"), name };
}

/** 展示名与来源行顺序无关；同一版本同时有点号与连字符写法时优先保留点号。 */
function compareModelNames(a: string, b: string): number {
  return Number(/\d\.\d/.test(b)) - Number(/\d\.\d/.test(a)) || a.length - b.length || a.localeCompare(b);
}

/** 全部来源先确定同一展示名，避免同一模型在不同日期因写法不同而拆成多个图例。 */
function groupModelSources<T extends Pick<ModelStatsRow, "model" | "provider">>(rows: T[]) {
  const groups = new Map<string, { model: string; sources: T[] }>();
  for (const row of rows) {
    const identity = modelIdentity(row.model, row.provider);
    let group = groups.get(identity.key);
    if (!group) {
      group = { model: identity.name, sources: [] };
      groups.set(identity.key, group);
    }
    if (compareModelNames(identity.name, group.model) < 0) group.model = identity.name;
    group.sources.push(row);
  }
  return [...groups.values()];
}

/** 对已按原始 model/provider 汇总的行再分组；费用直接相加，不重新计价或改写历史。 */
export function groupModelStats(rows: ModelStatsRow[], sort: ModelSort) {
  const sortField = sort === "tokens" ? "total_tokens" : "total_cost_usd";
  return groupModelSources(rows)
    .map(({ model, sources }) => {
      const totals: Omit<ModelStatsRow, "model" | "provider"> = {
        turn_count: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
        total_tokens: 0, total_cost_usd: 0, avg_duration_ms: 0,
      };
      for (const row of sources) {
        for (const field of SUM_FIELDS) totals[field] += row[field];
        totals.avg_duration_ms += row.avg_duration_ms * row.turn_count;
      }
      return withTotalCostCny({
        model,
        ...totals,
        avg_duration_ms: totals.turn_count ? totals.avg_duration_ms / totals.turn_count : 0,
        sources: [...sources]
          .sort((a, b) => b[sortField] - a[sortField] || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
          .map(withTotalCostCny),
      });
    })
    .sort((a, b) => b[sortField] - a[sortField] || a.model.localeCompare(b.model));
}

/** 每日趋势按同一模型合并渠道，日期边界和每日总量仍由原统计查询决定。 */
export function groupDailyModelStats(rows: DailyModelStatsRow[]) {
  type DailyModelGroup = Omit<DailyModelStatsRow, "provider"> & { label: string };
  const modelsByDate = new Map<string, Array<DailyModelGroup & { total_cost_cny: number }>>();
  for (const { model, sources } of groupModelSources(rows)) {
    const days = new Map<string, DailyModelGroup>();
    for (const row of sources) {
      let day = days.get(row.date);
      if (!day) {
        day = { date: row.date, model, label: model, turn_count: 0, total_tokens: 0, total_cost_usd: 0 };
        days.set(row.date, day);
      }
      day.turn_count += row.turn_count;
      day.total_tokens += row.total_tokens;
      day.total_cost_usd += row.total_cost_usd;
    }
    for (const day of days.values()) {
      const models = modelsByDate.get(day.date) ?? [];
      models.push(withTotalCostCny(day));
      modelsByDate.set(day.date, models);
    }
  }
  for (const models of modelsByDate.values()) {
    models.sort((a, b) => b.total_cost_usd - a.total_cost_usd || a.model.localeCompare(b.model));
  }
  return modelsByDate;
}
