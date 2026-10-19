import { usdToCny } from "@agent-tracker/shared";
import { getUsdToCny } from "./fx";

/** 展示用人民币。实时汇率不可用时退回 USD_TO_CNY。 */
export function displayCny(usd: number): number {
  return usdToCny(usd, getUsdToCny());
}

/** 为展示 API 附加 cost_cny（存储仍为 cost_usd） */
export function withCostCny<T extends { cost_usd?: number | null }>(
  row: T,
): T & { cost_cny: number } {
  return { ...row, cost_cny: displayCny(Number(row.cost_usd ?? 0)) };
}

/** 为展示 API 附加 total_cost_cny（存储仍为 total_cost_usd） */
export function withTotalCostCny<T extends { total_cost_usd?: number | null }>(
  row: T,
): T & { total_cost_cny: number } {
  return { ...row, total_cost_cny: displayCny(Number(row.total_cost_usd ?? 0)) };
}

/** 为展示 API 附加单价人民币字段（存储仍为 USD/1M tokens） */
export function withPricingCny<
  T extends {
    input_price: number;
    output_price: number;
    cache_read_price?: number | null;
    cache_write_price?: number | null;
    reasoning_price?: number | null;
  },
>(row: T) {
  return {
    ...row,
    input_price_cny: displayCny(row.input_price),
    output_price_cny: displayCny(row.output_price),
    cache_read_price_cny:
      row.cache_read_price != null ? displayCny(row.cache_read_price) : null,
    cache_write_price_cny:
      row.cache_write_price != null ? displayCny(row.cache_write_price) : null,
    reasoning_price_cny:
      row.reasoning_price != null ? displayCny(row.reasoning_price) : null,
  };
}
