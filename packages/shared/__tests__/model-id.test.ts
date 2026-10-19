import { describe, expect, it } from "bun:test";
import { canonicalizeModelId, normalizeModelId } from "../src/model-id";
import { computeCost, DEFAULT_PRICING } from "../src/index";

describe("canonicalizeModelId", () => {
  it("strips CodeBuddy / BoxAI channel suffixes like display-name aliases", () => {
    expect(canonicalizeModelId("glm-5.2-ioa")).toBe("glm-5-2");
    expect(canonicalizeModelId("glm-5.1-ioa")).toBe("glm-5-1");
    expect(canonicalizeModelId("deepseek-v4-flash-ioa")).toBe("deepseek-v4-flash");
    expect(canonicalizeModelId("deepseek-v4-pro-official")).toBe("deepseek-v4-pro");
    expect(canonicalizeModelId("deepseek-v4-flash-external")).toBe("deepseek-v4-flash");
    expect(canonicalizeModelId("glm-5-2-internal")).toBe("glm-5-2");
  });

  it("maps hy3-ioa to hy-3", () => {
    expect(canonicalizeModelId("hy3-ioa")).toBe("hy-3");
    expect(canonicalizeModelId("hy-3")).toBe("hy-3");
  });

  it("normalizes Claude / GPT variants used by OpenCode / Codex / Cursor", () => {
    expect(canonicalizeModelId("Claude-Opus-4.8")).toBe("claude-opus-4-8");
    expect(canonicalizeModelId("Claude-Opus-4.8-1m")).toBe("claude-opus-4-8");
    expect(canonicalizeModelId("gpt-5.5")).toBe("gpt-5-5");
    expect(normalizeModelId("composer_2.5")).toBe("composer-2-5");
  });

  it("strips context tier when a capability suffix follows it", () => {
    // 数字位于中间：不先摘 -fast 会剥不掉 256k，Fast 变体会错拿 standard 价
    expect(canonicalizeModelId("grok-4.7-256k-fast")).toBe("grok-4-7-fast");
    expect(canonicalizeModelId("grok-4.7-500k-fast")).toBe("grok-4-7-fast");
    expect(canonicalizeModelId("grok-4.7-256k")).toBe("grok-4-7");
    expect(canonicalizeModelId("claude-opus-4.8-1m")).toBe("claude-opus-4-8");
  });
});

describe("computeCost via shared aliases", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 };

  it("prices glm-5.2-ioa for any provider via canonical glm-5.2", () => {
    expect(computeCost("codebuddy", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
    expect(computeCost("unknown", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
    expect(computeCost("opencode", "glm-5.2-ioa", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
    expect(computeCost("cursor", "glm-5.2", usage, DEFAULT_PRICING)).toBeCloseTo(1.4 + 4.4 + 0.26, 6);
  });

  it("prices hy3-ioa via hy-3", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(computeCost("codebuddy", "hy3-ioa", u, DEFAULT_PRICING)).toBeCloseTo(0.5 + 2.0, 6);
    expect(computeCost("unknown", "hy3-ioa", u, DEFAULT_PRICING)).toBeCloseTo(0.5 + 2.0, 6);
  });
});
