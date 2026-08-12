export type StatsRange = "today" | "24h" | "7d" | "month" | "all";
export type ModelSort = "cost" | "tokens";

export const DEFAULT_STATS_RANGE: StatsRange = "month";

export function resolveStatsRange(range: string | undefined): { from: string | null; to: string | null } {
  const effective = range || DEFAULT_STATS_RANGE;
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
