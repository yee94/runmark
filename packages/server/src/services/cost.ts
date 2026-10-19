import { computeCost, DEFAULT_PRICING, type ModelPricing } from "@agent-tracker/shared";

/**
 * 这些 provider 的客户端 cost 常漏计 cache（open-grok-build / 旧 Grok 表），
 * ingest 时强制按服务端 API 定价表估算。
 * Cursor / OpenAI 等仍优先信任客户端 / 账单 cost。
 */
const FORCE_SERVER_PRICING_PROVIDERS = new Set(["grok-build", "xai", "grok"]);

function shouldForceServerPricing(provider: string): boolean {
  return FORCE_SERVER_PRICING_PROVIDERS.has(provider.toLowerCase());
}

class CostService {
  private pricing: ModelPricing[] = [...DEFAULT_PRICING];

  setPricing(table: ModelPricing[]): void {
    this.pricing = [...table];
  }

  getPricing(): ModelPricing[] {
    return this.pricing;
  }

  addOrUpdatePricing(entry: ModelPricing): void {
    const idx = this.pricing.findIndex(
      (p) => p.provider === entry.provider && p.model === entry.model,
    );
    if (idx >= 0) {
      this.pricing[idx] = entry;
    } else {
      this.pricing.push(entry);
    }
  }

  compute(
    provider: string,
    model: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      reasoning_tokens?: number;
      output_includes_reasoning?: boolean;
    },
  ): number {
    return computeCost(provider, model, usage, this.pricing);
  }

  /**
   * 解析 turn 费用。
   * - grok-build / xai / grok：强制服务端表（含 cache），避免 open-grok-build 漏计
   * - 其他：客户端 cost_usd > 0 优先；否则表估算
   */
  resolveTurnCost(
    provider: string,
    model: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      reasoning_tokens?: number;
      output_includes_reasoning?: boolean;
    },
    costUsd?: number | null,
  ): number {
    const computed = this.compute(provider, model, usage);

    if (shouldForceServerPricing(provider) && computed > 0) {
      return computed;
    }

    if (costUsd != null && costUsd > 0) return costUsd;
    return computed;
  }
}

export const costService = new CostService();
