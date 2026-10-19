import { describe, it, expect, beforeEach } from "bun:test";
import { costService } from "../src/services/cost";
import { computeCost, DEFAULT_PRICING, type ModelPricing } from "@agent-tracker/shared";

describe("costService", () => {
  const pricing: ModelPricing[] = [
    {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      input_price: 3.0,
      output_price: 15.0,
      cache_read_price: 0.3,
      cache_write_price: 3.75,
    },
    { provider: "openai", model: "gpt-4.1", input_price: 2.0, output_price: 8.0 },
    { provider: "codebuddy", model: "deepseek-v4-flash", input_price: 0.429, output_price: 1.286 },
  ];

  beforeEach(() => {
    costService.setPricing(pricing);
  });

  it("computes basic input/output cost", () => {
    const cost = costService.compute("anthropic", "claude-sonnet-4-20250514", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    });

    expect(cost).toBeCloseTo(3.0 + 7.5, 6);
  });

  it("includes cache tokens when pricing available", () => {
    const cost = costService.compute("anthropic", "claude-sonnet-4-20250514", {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 2_000_000,
      cache_write_tokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(3.0 + 0.6 + 3.75, 6);
  });

  it("returns 0 when pricing not found", () => {
    costService.setPricing([]);
    const cost = costService.compute("unknown", "unknown", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });

    expect(cost).toBe(0);
  });

  it("returns 0 for unknown model under known provider (no blind first-row fallback)", () => {
    const cost = costService.compute("anthropic", "totally-unknown-model", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });

    expect(cost).toBe(0);
  });

  it("matches codebuddy deepseek model id suffix", () => {
    const cost = costService.compute("codebuddy", "deepseek-v4-flash-ioa", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(0.429 + 1.286, 6);
  });

  it("resolveTurnCost falls back when OpenCode reports 0", () => {
    const cost = costService.resolveTurnCost("codebuddy", "deepseek-v4-flash-ioa", {
      input_tokens: 10_000,
      output_tokens: 5_000,
    }, 0);

    expect(cost).toBeGreaterThan(0);
  });

  it("resolveTurnCost forces server pricing for grok-build (open-grok-build under-reports cache)", () => {
    costService.setPricing(DEFAULT_PRICING);
    const cost = costService.resolveTurnCost(
      "grok-build",
      "grok-4.5",
      {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 1_000_000,
      },
      0.01, // 客户端只报了 input 部分
    );

    // API: in $2 + cache $0.30
    expect(cost).toBeCloseTo(2.3, 6);
  });

  it("resolveTurnCost still prefers client cost for non-grok providers", () => {
    costService.setPricing(DEFAULT_PRICING);
    const cost = costService.resolveTurnCost(
      "codebuddy",
      "deepseek-v4-flash",
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      0.99,
    );
    expect(cost).toBe(0.99);
  });

  it("resolveTurnCost falls back to client cost when pricing missing", () => {
    costService.setPricing([]);
    const cost = costService.resolveTurnCost("unknown", "unknown", {
      input_tokens: 10_000,
      output_tokens: 5_000,
    }, 0.99);

    expect(cost).toBe(0.99);
  });

  it("prices grok-build and composer-2.5 at official API rates", () => {
    const g45 = computeCost(
      "grok-build",
      "grok-4.5",
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, reasoning_tokens: 1_000_000 },
      DEFAULT_PRICING,
    );
    // $2 + $6 + $0.30 + $6 reasoning
    expect(g45).toBeCloseTo(14.3, 6);

    const compFast = computeCost(
      "grok-build",
      "grok-composer-2.5-fast",
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      DEFAULT_PRICING,
    );
    expect(compFast).toBeCloseTo(3 + 15 + 0.5, 6);

    const cursorStd = computeCost(
      "cursor",
      "composer-2.5",
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      DEFAULT_PRICING,
    );
    expect(cursorStd).toBeCloseTo(0.5 + 2.5 + 0.2, 6);
  });

  it("prices Grok 4.7 standard and Fast tiers across cursor / xai / grok", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 };
    // Cursor docs 2026-09-21：standard $2/$6 cache $0.50；Fast 2x
    expect(computeCost("cursor", "grok-4.7", usage, DEFAULT_PRICING)).toBeCloseTo(2 + 6 + 0.5, 6);
    expect(computeCost("cursor", "cursor-grok-4.7-500k", usage, DEFAULT_PRICING)).toBeCloseTo(2 + 6 + 0.5, 6);
    expect(computeCost("cursor", "grok-4.7-256k-fast", usage, DEFAULT_PRICING)).toBeCloseTo(4 + 12 + 1, 6);
    expect(computeCost("xai", "grok-4.7", usage, DEFAULT_PRICING)).toBeCloseTo(2 + 6 + 0.3, 6);
    expect(computeCost("grok-build", "grok-4.7", usage, DEFAULT_PRICING)).toBeCloseTo(2 + 6 + 0.3, 6);
    expect(computeCost("grok", "grok-4.7-build-fast", usage, DEFAULT_PRICING)).toBeCloseTo(4 + 12 + 0.5, 6);
  });

  it("has explicit OpenAI GPT-5.5 pricing with cache read discount", () => {
    const cost = computeCost("openai", "gpt-5.5", {
      input_tokens: 1_000_000,
      cache_read_tokens: 2_000_000,
      output_tokens: 500_000,
    }, DEFAULT_PRICING);

    expect(cost).toBeCloseTo(5 + 1 + 15, 6);
  });

  it("prices Codex priority models through normalized fast model ids", () => {
    const cost = computeCost("openai", "gpt-5.6-terra-fast", {
      input_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }, DEFAULT_PRICING);

    expect(cost).toBeCloseTo(5 + 0.5 + 30, 6);
  });

  it("does not price CodeBuddy Claude-Opus-4.8 as deepseek", () => {
    const cost = computeCost("CodeBuddy", "Claude-Opus-4.8", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }, DEFAULT_PRICING);

    // 现代 Opus 4.5+ / 5：$5/$25 per 1M（非 deepseek $0.14/$0.28，也非旧 Opus 4.1 $15/$75）
    expect(cost).toBeCloseTo(5 + 25, 6);
  });

  it("normalizes Claude-Opus-4.8-1m under codebuddy/imate", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(computeCost("codebuddy", "Claude-Opus-4.8-1m", usage, DEFAULT_PRICING)).toBeCloseTo(5, 6);
    expect(computeCost("IMate", "Claude-Opus-4.8-1m", usage, DEFAULT_PRICING)).toBeCloseTo(5, 6);
  });

  it("prefers longer model match so gpt-5 does not steal gpt-5.4", () => {
    const cost = computeCost("openai", "gpt-5.4", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    }, DEFAULT_PRICING);

    expect(cost).toBeCloseTo(2.5, 6);
  });

  it("falls back unknown Opus version to modern opus family pricing, not deepseek", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    // 现代 Opus（4.5+ / 5）官方 $5/$25；未知 4.9 应落到该价，而非旧 Opus 4.1 的 $15/$75
    expect(computeCost("CodeBuddy", "Claude-Opus-4.9", usage, DEFAULT_PRICING)).toBeCloseTo(30, 6);
    expect(computeCost("codebuddy", "claude-opus-5", usage, DEFAULT_PRICING)).toBeCloseTo(30, 6);
    expect(computeCost("cursor", "claude-opus-5-300k", usage, DEFAULT_PRICING)).toBeCloseTo(30, 6);
    expect(computeCost("IMate", "Claude-Opus-4.9-1m", usage, DEFAULT_PRICING)).toBeCloseTo(30, 6);
  });

  it("falls back unknown Sonnet version to sonnet family pricing", () => {
    const cost = computeCost("CodeBuddy", "Claude-Sonnet-4.9", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }, DEFAULT_PRICING);

    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it("prices GPT-6 Astra explicitly and keeps generic GPT fallback for newer ids", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    // gpt-6 系列显式登记（$10/$50）；未知 gpt-7 仍按 gpt 族旗舰兜底
    expect(computeCost("openai", "gpt-6", usage, DEFAULT_PRICING)).toBeCloseTo(95, 6);
    expect(computeCost("CodeBuddy", "GPT-6", usage, DEFAULT_PRICING)).toBeCloseTo(95, 6);
    expect(computeCost("imate", "gpt-6-astra", usage, DEFAULT_PRICING)).toBeCloseTo(95, 6);
    expect(computeCost("openai", "gpt-7", usage, DEFAULT_PRICING)).toBeCloseTo(95, 6);
  });

  it("falls back unknown GPT mini to mini-tier pricing", () => {
    const cost = computeCost("openai", "gpt-7-mini", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }, DEFAULT_PRICING);

    // 同档 mini 中取最高单价：gpt-5.4-mini $0.75/$4.5
    expect(cost).toBeCloseTo(5.25, 6);
  });

  it("prices the whole Astra request above 272K, including cache and separate reasoning", () => {
    const usage = { input_tokens: 200_000, cache_read_tokens: 72_000, output_tokens: 100, reasoning_tokens: 50 };
    expect(computeCost("openai", "gpt-6-astra", usage)).toBeCloseTo(2.0795, 9);
    expect(computeCost("openai", "gpt-6-astra", { ...usage, output_tokens: 150, output_includes_reasoning: true })).toBeCloseTo(2.0795, 9);
    expect(computeCost("openai", "gpt-6-astra", { ...usage, cache_write_tokens: 1 })).toBeCloseTo(4.155275, 9);
    expect(computeCost("openai", "gpt-6-astra-fast", { ...usage, cache_write_tokens: 1 })).toBeCloseTo(8.31055, 9);
    costService.setPricing(DEFAULT_PRICING);
    expect(costService.resolveTurnCost("openai", "gpt-6-astra", { input_tokens: 1118, cache_read_tokens: 279680, output_tokens: 302, reasoning_tokens: 510 }, 0)).toBeCloseTo(0.64262, 9);
  });

  it("selects the highest matching context tier regardless of order and honors zero prices", () => {
    const table: ModelPricing[] = [{ provider: "test", model: "tiered", input_price: 10, output_price: 50, cache_read_price: 1,
      context_tiers: [
        { above: 200, input_price: 30, output_price: 70, cache_read_price: 0 },
        { above: 100, input_price: 20, output_price: 60 },
      ] }];
    expect(computeCost("test", "tiered", { input_tokens: 1, cache_read_tokens: 200, output_tokens: 1 }, table)).toBe(0.0001);
    expect(computeCost("test", "tiered", { input_tokens: 100, output_tokens: 1 }, table)).toBe(0.00105);
  });

  it("prices every GPT-6 SKU independently across providers and context bands", () => {
    for (const [model, input, output, read, write] of [
      ["gpt-6-astra", 10, 50, 1, 12.5], ["gpt-6-sol", 2, 10, 0.2, 2.5],
      ["gpt-6-luna", 0.1, 0.5, 0.01, 0.125], ["gpt-6.1-sol", 2, 10, 0.1, 2.5],
    ] as const) {
      for (const provider of ["openai", "codex", "codebuddy", "magpie-openai"]) {
        for (const fast of [false, true]) {
          const id = model + (fast ? "-fast" : "");
          const factor = fast ? 2 : 1;
          expect(computeCost(provider, id, { input_tokens: 200000, cache_read_tokens: 72000, output_tokens: 100, reasoning_tokens: 50 }))
            .toBeCloseTo((200000 * input + 72000 * read + 150 * output) * factor / 1e6, 9);
          expect(computeCost(provider, id, { input_tokens: 200000, cache_read_tokens: 72000, cache_write_tokens: 1, output_tokens: 100, reasoning_tokens: 50 }))
            .toBeCloseTo((400000 * input + 144000 * read + 2 * write + 225 * output) * factor / 1e6, 9);
        }
      }
    }
  });

  it("falls back unknown deepseek flash/pro by tier", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCost("codebuddy", "deepseek-v5-flash", usage, DEFAULT_PRICING)).toBeCloseTo(0.429 + 1.286, 6);
    expect(computeCost("codebuddy", "deepseek-v5-pro", usage, DEFAULT_PRICING)).toBeCloseTo(1.286 + 3.857, 6);
    // 无档位 → 旗舰 pro，而非 flash
    expect(computeCost("codebuddy", "deepseek-v5", usage, DEFAULT_PRICING)).toBeCloseTo(1.286 + 3.857, 6);
  });

  it("prices Astra deepseek_v4_pro_code explicitly", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 };
    expect(computeCost("astra", "deepseek_v4_pro_code", usage, DEFAULT_PRICING)).toBeCloseTo(1.286 + 3.857 + 0.043, 6);
  });

  it("prices glm-5.2-ioa via zhipu / codebuddy glm family", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 };
    expect(computeCost("zhipu", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
    expect(computeCost("unknown", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
    expect(computeCost("codebuddy", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
  });

  it("falls back gemini flash/pro by hyphen tier, not mini substring in gemini", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    // gemini-3-flash 无条目 → 同档 flash 取最高单价 gemini-3.6-flash，而非旧的 2.5-flash
    expect(computeCost("google", "gemini-3-flash", usage, DEFAULT_PRICING)).toBeCloseTo(1.5 + 7.5, 6);
    expect(computeCost("google", "gemini-3-pro", usage, DEFAULT_PRICING)).toBeCloseTo(1.25 + 10, 6);
    expect(computeCost("google", "gemini-2.5-flash", usage, DEFAULT_PRICING)).toBeCloseTo(0.15 + 0.6, 6);
  });

  it("prices gemini 3.x flash at 3.x rates across proxy providers", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    for (const provider of ["google", "boxai", "cursor"]) {
      expect(computeCost(provider, "gemini-3.6-flash", usage, DEFAULT_PRICING)).toBeCloseTo(1.5 + 7.5, 6);
      expect(computeCost(provider, "gemini-3.5-flash", usage, DEFAULT_PRICING)).toBeCloseTo(1.5 + 9.0, 6);
    }
  });

  it("prices claude-sonnet-5 effort/thinking variants at sonnet-5 rates", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCost("anthropic", "claude-sonnet-5", usage, DEFAULT_PRICING)).toBeCloseTo(3 + 15, 6);
    expect(computeCost("cursor", "claude-sonnet-5-max", usage, DEFAULT_PRICING)).toBeCloseTo(3 + 15, 6);
    expect(computeCost("cursor", "claude-sonnet-5-thinking-high", usage, DEFAULT_PRICING)).toBeCloseTo(3 + 15, 6);
  });

  it("prices kimi-k3 above kimi-k2 instead of falling back to k2", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    for (const provider of ["moonshot", "boxai", "astra"]) {
      expect(computeCost(provider, "kimi-k3", usage, DEFAULT_PRICING)).toBeCloseTo(3 + 15, 6);
    }
    // k2 系列不受影响
    expect(computeCost("cursor", "kimi-k2.7-code", usage, DEFAULT_PRICING)).toBeCloseTo(2 + 8, 6);
  });

  it("falls back unknown OpenAI o-series to o-family pricing", () => {
    const cost = computeCost("openai", "o5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }, DEFAULT_PRICING);

    // o3 / o4 中取更高单价 o3：$10/$40
    expect(cost).toBeCloseTo(50, 6);
  });
});
