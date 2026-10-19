import { HTTPException } from "hono/http-exception";

export type StatsRange = "today" | "24h" | "7d" | "month" | "last_month" | "custom" | "all";
export type ModelSort = "cost" | "tokens";

export const DEFAULT_STATS_RANGE: StatsRange = "month";

/** 统计日历固定为北京时间（Asia/Shanghai，UTC+8，无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function beijingParts(now = new Date()): { year: number; month: number; day: number } {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** 北京时间某日 00:00 对应的 UTC 瞬间。month 为 0-based，允许溢出。 */
export function beijingDateStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - BEIJING_OFFSET_MS);
}

/** SQLite：UTC ISO 时间戳列 → 北京日历日 YYYY-MM-DD。 */
export function beijingDateExpr(column: string): string {
  return `DATE(${column}, '+8 hours')`;
}

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
  const { year, month, day } = beijingParts(now);

  switch (effective) {
    case "today":
      return { from: beijingDateStart(year, month, day).toISOString(), to };
    case "24h":
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), to };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to };
    case "month":
      return { from: beijingDateStart(year, month, 1).toISOString(), to };
    case "last_month":
      return {
        from: beijingDateStart(year, month - 1, 1).toISOString(),
        to: new Date(beijingDateStart(year, month, 1).getTime() - 1).toISOString(),
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
