import { afterEach, describe, expect, it } from "bun:test";
import { buildLlmAuthHeaders, shouldSendXApiKey } from "../src/services/llmHeaders";

const ENV_KEY = "AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("buildLlmAuthHeaders", () => {
  it("sends Bearer only when no host markers match", () => {
    expect(buildLlmAuthHeaders("ttsw-test", "http://127.0.0.1:15721/tencent/v1/chat/completions")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ttsw-test",
    });
    expect(shouldSendXApiKey("http://127.0.0.1:15721/tencent/v1/chat/completions")).toBe(false);
  });

  it("adds X-API-Key when base URL matches AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS", () => {
    process.env[ENV_KEY] = "llm-proxy.example.com";
    expect(buildLlmAuthHeaders("ac:test", "https://llm-proxy.example.com/v1/chat/completions")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ac:test",
      "X-API-Key": "ac:test",
    });
    expect(shouldSendXApiKey("https://LLM-PROXY.EXAMPLE.COM/v1/chat/completions")).toBe(true);
  });
});
