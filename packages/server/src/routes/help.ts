import { Hono } from "hono";
import type { ServerConfig } from "../config";

export function createHelpRoute(cfg: ServerConfig, _validKeys: Set<string>) {
  const app = new Hono();

  app.get("/v1/help/context", (c) => {
    const requestUrl = new URL(c.req.url);
    return c.json({
      endpoint: requestUrl.origin,
      apiKey: cfg.apiKey,
      apiKeyVisible: true,
      publicDashboard: cfg.publicDashboard,
    });
  });

  return app;
}
