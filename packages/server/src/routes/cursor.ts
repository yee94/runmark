import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import type { FileLogger } from "@agent-tracker/shared";
import type { ServerConfig } from "../config";
import { isRequestAuthenticated } from "../auth";
import { CursorService } from "../services/cursor";
import type { CursorCookie } from "../services/cursorCrypto";

function canManageCursor(c: Context, cfg: ServerConfig, validKeys: Set<string>): boolean {
  const header =
    c.req.header("X-API-Key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (header && (header === cfg.cursorApiKey || header === cfg.apiKey || validKeys.has(header))) {
    return true;
  }
  return isRequestAuthenticated(c, validKeys, cfg.publicDashboard);
}

export function createCursorRoute(
  db: Database,
  cfg: ServerConfig,
  logger: FileLogger,
  validKeys: Set<string>,
) {
  const app = new Hono();
  const service = new CursorService(db, cfg, logger);

  app.get("/v1/cursor/status", (c) => {
    if (!isRequestAuthenticated(c, validKeys, cfg.publicDashboard)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(service.getStatus());
  });

  app.post("/v1/cursor/cookies", async (c) => {
    if (!canManageCursor(c, cfg, validKeys)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const body = await c.req.json<{
      sessionToken?: string;
      cookies?: CursorCookie[];
      source?: string;
    }>();

    try {
      if (body.sessionToken?.trim()) {
        await service.importSessionToken(body.sessionToken.trim(), body.source ?? "dashboard");
      } else if (Array.isArray(body.cookies) && body.cookies.length) {
        await service.importCookies(body.source ?? "dashboard", body.cookies);
      } else {
        return c.json({ error: "sessionToken or cookies required" }, 400);
      }
      service.sync().catch(() => {});
      return c.json({ ok: true, status: service.getStatus() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/v1/cursor/cookies", (c) => {
    if (!canManageCursor(c, cfg, validKeys)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    service.clearCookies();
    return c.json({ ok: true, status: service.getStatus() });
  });

  app.post("/v1/cursor/sync", async (c) => {
    if (!canManageCursor(c, cfg, validKeys)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    try {
      const job = await service.sync();
      return c.json({ ok: true, job, status: service.getStatus() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return { app, service };
}
