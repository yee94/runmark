import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { loadConfig, getServerVersion, type ServerConfig } from "./config";
import { getDatabase } from "./db";
import { getLogger, initLogger } from "./logger";
import { isRequestAuthenticated } from "./auth";
import { createIngestRoute } from "./routes/ingest";
import { createOtlpRoute } from "./routes/otlp";
import { createAuthRoute } from "./routes/auth";
import { createSessionsRoute, createTurnsRoute, createPricingRoute, createStatsRoute } from "./routes/sessions";
import { createSessionSharesRoute, createPublicSessionSharesRoute } from "./routes/session-shares";
import { createCursorRoute } from "./routes/cursor";
import { createAgentsRoute } from "./routes/agents";
import { createHelpRoute } from "./routes/help";
import { createUpdateRoute } from "./routes/update";
import { startCursorScheduler } from "./services/cursorScheduler";
import { AgentThrottleScheduler } from "./services/agentScheduler";
import { getAgentRuntime } from "./services/agents";
import type { IngestEvent } from "@agent-tracker/shared";

function requireAuth(cfg: ServerConfig, validKeys: Set<string>) {
  return async (c: Context, next: Next) => {
    if (!isRequestAuthenticated(c, validKeys, cfg.publicDashboard)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}

/** OTLP exporter 的凭据来自配置的 headers，按 X-API-Key / Bearer 两种写法校验 */
function otlpAuth(validKeys: Set<string>) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!key || !validKeys.has(key)) {
      return c.json({ error: "Unauthorized: valid API key required" }, 401);
    }
    await next();
  };
}

export function createApp(config?: ServerConfig) {
  const cfg = config ?? loadConfig();
  initLogger(cfg);
  const db = getDatabase(cfg.dbPath);

  // costService 默认用 DEFAULT_PRICING（代码为源）；seedPricing 同步展示表；PUT /v1/pricing 会同步内存
  const app = new Hono();

  app.use("*", cors({ origin: "*", credentials: true }));

  const validKeys = new Set([cfg.apiKey, ...cfg.extraApiKeys]);
  const authGuard = requireAuth(cfg, validKeys);

  // API key auth middleware for ingest and admin routes
  app.use("/v1/ingest/*", async (c, next) => {
    const key = c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!key || !validKeys.has(key)) {
      return c.json({ error: "Unauthorized: valid API key required" }, 401);
    }
    await next();
  });

  // OTLP 接入：exporter 通常只能配 headers，兼容 X-API-Key 与 Bearer
  app.use("/v1/traces", otlpAuth(validKeys));
  app.use("/v1/metrics", otlpAuth(validKeys));

  app.use("/v1/pricing", async (c, next) => {
    if (c.req.method === "PUT" || c.req.method === "POST") {
      const key = c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!key || !validKeys.has(key)) {
        return c.json({ error: "Unauthorized: valid API key required" }, 401);
      }
    }
    await next();
  });
  app.use("/v1/pricing/*", async (c, next) => {
    if (c.req.method === "PUT" || c.req.method === "POST") {
      const key = c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!key || !validKeys.has(key)) {
        return c.json({ error: "Unauthorized: valid API key required" }, 401);
      }
    }
    await next();
  });

  // Dashboard 读 API：默认需 Cookie 或 X-API-Key（与 AGENT_TRACKER_API_KEY 一致）
  app.use("/v1/sessions", authGuard);
  app.use("/v1/sessions/*", authGuard);
  app.use("/v1/turns", authGuard);
  app.use("/v1/turns/*", authGuard);
  app.use("/v1/stats", authGuard);
  app.use("/v1/stats/*", authGuard);
  app.use("/v1/pricing", authGuard);
  app.use("/v1/cursor/status", authGuard);
  app.use("/v1/cursor/cookies", authGuard);
  app.use("/v1/cursor/sync", authGuard);
  app.use("/v1/agents", authGuard);
  app.use("/v1/agents/*", authGuard);
  app.use("/v1/agent-runs", authGuard);
  app.use("/v1/matters", authGuard);
  app.use("/v1/matters/*", authGuard);
  app.use("/v1/system-config", authGuard);
  app.use("/v1/system-config/*", authGuard);
  app.use("/v1/system-update", authGuard);
  app.use("/v1/system-update/*", authGuard);

  const { app: cursorRoute, service: cursorService } = createCursorRoute(db, cfg, getLogger(), validKeys);
  const agentRuntime = getAgentRuntime(db, cfg, getLogger());
  const agentScheduler = new AgentThrottleScheduler(agentRuntime, cfg, getLogger());

  const onIngested = (events: IngestEvent[]) => {
    const sessionIds = [...new Set(
      events
        .filter((e) => {
          if (e.type === "session.created" || e.type === "session.updated" || e.type === "session.idle" || e.type === "session.compacted") {
            return e.agent === "cursor";
          }
          if (e.type === "message" || e.type === "turn.completed" || e.type === "turn.error") {
            return e.provider === "cursor";
          }
          return false;
        })
        .map((e) => e.session_id)
        .filter(Boolean),
    )];
    if (sessionIds.length) cursorService.scheduleSyncAfterIngest(sessionIds);
    agentScheduler.scheduleAfterIngest(events);
  };

  const ingestRoute = createIngestRoute(db, getLogger(), onIngested);
  const otlpRoute = createOtlpRoute(db, getLogger(), onIngested);
  const authRoute = createAuthRoute(cfg, validKeys);
  const sessionsRoute = createSessionsRoute(db);
  // 创建分享走 /v1/sessions/*，受上方 sessions authGuard 保护
  // apiKey 用于生成/校验 share 链接 HMAC alias（token_hash.signature）
  const sessionSharesRoute = createSessionSharesRoute(db, cfg.apiKey);
  // 公开分享读取：路径不在 /v1/sessions 下，避免 sessions authGuard
  const publicSessionSharesRoute = createPublicSessionSharesRoute(db, cfg.apiKey);
  const turnsRoute = createTurnsRoute(db);
  const pricingRoute = createPricingRoute(db);
  const statsRoute = createStatsRoute(db);
  const agentsRoute = createAgentsRoute(db, cfg, getLogger());
  const helpRoute = createHelpRoute(cfg, validKeys);
  const updateRoute = createUpdateRoute(cfg, getLogger());

  app.route("/", ingestRoute);
  app.route("/", otlpRoute);
  app.route("/", authRoute);
  app.route("/", publicSessionSharesRoute);
  app.route("/", sessionsRoute);
  app.route("/", sessionSharesRoute);
  app.route("/", turnsRoute);
  app.route("/", pricingRoute);
  app.route("/", statsRoute);
  app.route("/", cursorRoute);
  app.route("/", agentsRoute);
  app.route("/", helpRoute);
  app.route("/", updateRoute);

  if (cfg.cursorSyncEnabled && cfg.cursorCryptoKey) {
    startCursorScheduler(cursorService, getLogger());
  } else if (cfg.cursorSyncEnabled) {
    getLogger().error("Cursor sync enabled but AGENT_TRACKER_CURSOR_CRYPTO_KEY is not configured or invalid");
  }

  app.get("/health", (c) => c.json({ status: "ok", version: getServerVersion() }));

  function staticContentType(relativePath: string): string | undefined {
    if (relativePath.endsWith(".svg")) return "image/svg+xml";
    if (relativePath.endsWith(".png")) return "image/png";
    if (relativePath.endsWith(".html")) return "text/html; charset=utf-8";
    if (relativePath.endsWith(".js")) return "application/javascript; charset=utf-8";
    if (relativePath.endsWith(".css")) return "text/css; charset=utf-8";
    if (relativePath.endsWith(".md")) return "text/markdown; charset=utf-8";
    return undefined;
  }

  // 静态资源服务：public 目录下的文件（包括 model-icons/*）可直接访问
  app.use("/*", async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/v1/") || pathname === "/health") {
      return next();
    }
    let relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (relativePath.endsWith("/")) {
      relativePath += "index.html";
    }
    const file = Bun.file(`${cfg.publicDir}/${relativePath}`);
    if (await file.exists()) {
      const contentType = staticContentType(relativePath);
      return contentType
        ? new Response(file, { headers: { "Content-Type": contentType } })
        : new Response(file);
    }
    await next();
  });

  // 兜底：/ 返回 Dashboard HTML
  app.get("/", async (c) => {
    try {
      const file = Bun.file(`${cfg.publicDir}/index.html`);
      if (await file.exists()) {
        return new Response(file);
      }
    } catch {}
    return c.json({ message: "Runmark API running. Dashboard not found at /public/index.html" });
  });

  return { app, db, config: cfg };
}
