import { Hono } from "hono";
import type { ServerConfig } from "../config";
import {
  clearSessionCookie,
  findMatchingApiKey,
  isRequestAuthenticated,
  setSessionCookie,
} from "../auth";

export function createAuthRoute(cfg: ServerConfig, validKeys: Set<string>) {
  const app = new Hono();

  app.get("/auth/session", (c) => {
    const authenticated = isRequestAuthenticated(c, validKeys, cfg.publicDashboard);
    return c.json({
      authenticated,
      public: cfg.publicDashboard,
    });
  });

  app.post("/auth/login", async (c) => {
    if (cfg.publicDashboard) {
      return c.json({ ok: true, public: true });
    }

    let body: { password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const password = body.password?.trim();
    if (!password) {
      return c.json({ error: "password required" }, 400);
    }

    const matched = findMatchingApiKey(password, validKeys);
    if (!matched) {
      return c.json({ error: "Invalid password" }, 401);
    }

    setSessionCookie(c, matched);
    return c.json({ ok: true });
  });

  app.post("/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}
