import { describe, it, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import type { ServerConfig } from "../src/config";

const testConfig: ServerConfig = {
  port: 3456,
  apiKey: "test-secret-key",
  dbPath: ":memory:",
  publicDir: "./public",
  publicDashboard: false,
  extraApiKeys: [],
  debug: false,
  logFile: "/tmp/agent-tracker-test.log",
  cursorSyncEnabled: false,
  cursorApiKey: "test-secret-key",
  llmBaseUrl: "https://api.deepseek.com",
  llmApiKey: "ac:test",
  llmModel: "deepseek-chat",
  agentThrottleMs: 10 * 60 * 1000,
  agentAutoRunEnabled: false,
  updateEnabled: false,
  updateManifestUrl: "",
  updateScript: "/opt/runmark-updater/update.sh",
  updateStatePath: "/opt/runmark-updater/update-state.json",
};

describe("dashboard auth", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    ({ app } = createApp(testConfig));
  });

  it("GET /v1/stats/summary returns 401 without auth", async () => {
    const res = await app.request("/v1/stats/summary");
    expect(res.status).toBe(401);
  });

  it("POST /auth/login sets cookie and unlocks read API", async () => {
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-secret-key" }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).toContain("at_session=");

    const statsRes = await app.request("/v1/stats/summary", {
      headers: { Cookie: setCookie!.split(";")[0] },
    });
    expect(statsRes.status).toBe(200);
  });

  it("rejects wrong password", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("X-API-Key still works for read API", async () => {
    const res = await app.request("/v1/stats/summary", {
      headers: { "X-API-Key": "test-secret-key" },
    });
    expect(res.status).toBe(200);
  });

  it("publicDashboard skips auth", async () => {
    const { app: publicApp } = createApp({ ...testConfig, publicDashboard: true });
    const res = await publicApp.request("/v1/stats/summary");
    expect(res.status).toBe(200);
  });

  it("help context returns the current service api key", async () => {
    const anonymousRes = await app.request("/v1/help/context");
    const anonymous = await anonymousRes.json();
    expect(anonymousRes.status).toBe(200);
    expect(anonymous.apiKey).toBe("test-secret-key");
    expect(anonymous.apiKeyVisible).toBe(true);

    const authedRes = await app.request("/v1/help/context", {
      headers: { "X-API-Key": "test-secret-key" },
    });
    const authed = await authedRes.json();
    expect(authed.apiKey).toBe("test-secret-key");
    expect(authed.apiKeyVisible).toBe(true);

    const { app: publicApp } = createApp({ ...testConfig, publicDashboard: true });
    const publicRes = await publicApp.request("/v1/help/context");
    const publicBody = await publicRes.json();
    expect(publicBody.apiKey).toBe("test-secret-key");
    expect(publicBody.apiKeyVisible).toBe(true);
  });
});
