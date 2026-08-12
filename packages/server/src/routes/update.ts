import { Hono } from "hono";
import type { Context } from "hono";
import type { FileLogger } from "@agent-tracker/shared";
import type { ServerConfig } from "../config";
import { getServerVersion } from "../config";
import { checkForUpdates, getUpdateStatus, triggerUpdate as defaultTriggerUpdate } from "../services/update";
import type { TriggerUpdateParams } from "../services/update";

type TriggerFn = (params: TriggerUpdateParams) => Promise<
  | { ok: true; phase: string; version: string; message: string }
  | { ok: false; error: string; code: number }
>;

export function createUpdateRoute(
  cfg: ServerConfig,
  log: FileLogger,
  /** 依赖注入：默认使用真实 triggerUpdate */
  triggerFn: TriggerFn = defaultTriggerUpdate as TriggerFn,
) {
  const app = new Hono();

  const currentVersion = getServerVersion();

  // GET /v1/system-update/check — 抓远端 manifest 检查更新
  app.get("/v1/system-update/check", async (c: Context) => {
    const result = await checkForUpdates(
      cfg.updateEnabled,
      currentVersion,
      cfg.updateManifestUrl,
      cfg.updateStatePath,
      log,
    );
    return c.json(result);
  });

  // GET /v1/system-update/status — 只读本地持久状态
  app.get("/v1/system-update/status", (c: Context) => {
    const result = getUpdateStatus(
      cfg.updateEnabled,
      currentVersion,
      cfg.updateStatePath,
    );
    return c.json(result);
  });

  // POST /v1/system-update — 触发自动更新
  app.post("/v1/system-update", async (c: Context) => {
    let body: { version?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (!body || typeof body.version !== "string" || !body.version.trim()) {
      return c.json({ error: "Request body must include field 'version' as a non-empty string" }, 400);
    }

    const result = await triggerFn({
      targetVersion: body.version.trim(),
      enabled: cfg.updateEnabled,
      currentVersion,
      manifestUrl: cfg.updateManifestUrl,
      updateScript: cfg.updateScript,
      statePath: cfg.updateStatePath,
      log,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as any);
    }

    return c.json(result, 202);
  });

  return app;
}
