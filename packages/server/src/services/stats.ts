import { HTTPException } from "hono/http-exception";

export type StatsRange = "today" | "24h" | "7d" | "month" | "last_month" | "custom" | "all";
export type ModelSort = "cost" | "tokens";

export const DEFAULT_STATS_RANGE: StatsRange = "month";

export function resolveStatsRange(range: string | undefined, bounds: { from?: string; to?: string } = {}): { from: string | null; to: string | null } {
  const effective = range || DEFAULT_STATS_RANGE;
  if (bounds.from !== undefined || bounds.to !== undefined || effective === "custom") {
    const parse = (value: string | undefined) => {
      if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new HTTPException(400, { message: "from and to must be ISO 8601 timestamps with timezone" });
      }
      return new Date(value).toISOString();
    };
    const from = parse(bounds.from);
    const to = parse(bounds.to);
    if (from > to) throw new HTTPException(400, { message: "from must not be after to" });
    return { from, to };
  }
  const now = new Date();
  const to = now.toISOString();

  switch (effective) {
    case "today": {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case "24h":
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), to };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to };
    case "month": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from: start.toISOString(), to };
    }
    case "last_month":
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString(),
        to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1).toISOString(),
      };
    default:
      return { from: null, to: null };
  }
}

export function parseModelSort(sort: string | undefined): ModelSort {
  return sort === "tokens" ? "tokens" : "cost";
}

export function turnsTimeClause(alias = ""): string {
  const col = alias ? `${alias}.created_at` : "created_at";
  return `(${col} >= $from OR $from IS NULL) AND (${col} <= $to OR $to IS NULL)`;
}

export function sessionsTimeClause(alias = ""): string {
  const col = alias ? `${alias}.started_at` : "started_at";
  return `(${col} >= $from OR $from IS NULL) AND (${col} <= $to OR $to IS NULL)`;
}
