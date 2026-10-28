import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { resetDatabase } from "../src/db";
import type { ServerConfig } from "../src/config";

const testConfig: ServerConfig = {
  port: 3456,
  apiKey: "test-secret-key",
  dbPath: ":memory:",
  publicDir: "./public",
  publicDashboard: false,
  extraApiKeys: [],
  debug: false,
  logFile: "/tmp/agent-tracker-otlp-e2e.log",
  cursorSyncEnabled: false,
  cursorApiKey: "test-secret-key",
  llmBaseUrl: "https://api.example.com/v1/chat/completions",
  llmApiKey: "ac:test",
  llmModel: "deepseek_v4_flash_code",
  agentThrottleMs: 10 * 60 * 1000,
  agentAutoRunEnabled: false,
  updateEnabled: false,
  updateManifestUrl: "",
  updateScript: "/opt/runmark-updater/update.sh",
  updateStatePath: "/opt/runmark-updater/update-state.json",
};

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
const ns = (iso: string) => String(BigInt(new Date(iso).getTime()) * 1_000_000n);

const payload = {
  resourceSpans: [
    {
      resource: { attributes: [str("service.name", "magpie")] },
      scopeSpans: [
        {
          scope: { name: "github.com/yetone/magpie" },
          spans: [
            {
              traceId: "7".repeat(32),
              spanId: "8".repeat(16),
              name: "chat gpt-5",
              kind: 3,
              startTimeUnixNano: ns("2026-10-20T09:00:00.000Z"),
              endTimeUnixNano: ns("2026-10-20T09:00:01.000Z"),
              attributes: [
                str("gen_ai.provider.name", "openai"),
                str("gen_ai.request.model", "gpt-5"),
                str("magpie.agent", "opencode"),
                str("langfuse.session.id", "ses-e2e"),
                str("langfuse.observation.type", "generation"),
                int("gen_ai.usage.input_tokens", 100),
                int("gen_ai.usage.output_tokens", 20),
              ],
              status: { code: 0 },
            },
          ],
        },
      ],
    },
  ],
};

describe("OTLP 接入（真实 app）", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    resetDatabase(":memory:");
    ({ app } = createApp(testConfig));
  });

  afterEach(() => {
    resetDatabase(":memory:");
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });

  it("配置 headers 里的 API Key 后，一把上报地址即可落库", async () => {
    const res = await post("/v1/traces", { "X-API-Key": "test-secret-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    const sessionsRes = await app.request("/v1/sessions", { headers: { "X-API-Key": "test-secret-key" } });
    const rows = (await sessionsRes.json()) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ses-e2e", agent: "opencode", models: ["gpt-5"] });

    const turnsRes = await app.request("/v1/sessions/ses-e2e/turns", {
      headers: { "X-API-Key": "test-secret-key" },
    });
    expect((await turnsRes.json()) as any[]).toHaveLength(1);
  });

  it("Authorization: Bearer 同样可用（OTLP collector 常用写法）", async () => {
    const res = await post("/v1/traces", { Authorization: "Bearer test-secret-key" });
    expect(res.status).toBe(200);
  });

  it("没有有效 API Key 时拒绝", async () => {
    expect((await post("/v1/traces")).status).toBe(401);
    expect((await post("/v1/traces", { "X-API-Key": "wrong" })).status).toBe(401);
  });

  it("metrics 端点返回 200，避免 exporter 反复重投", async () => {
    const res = await post("/v1/metrics", { "X-API-Key": "test-secret-key" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
  });
});
