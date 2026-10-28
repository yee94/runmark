import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { ingestService } from "../services/ingest";
import { spansToIngestEvents } from "../services/otlp";
import type { FileLogger, IngestEvent } from "@agent-tracker/shared";

/**
 * OTLP/HTTP 接入（JSON 编码）。
 *
 * OpenTelemetry exporter（magpie、Langfuse SDK、opentelemetry-collector 等）
 * 把 endpoint 指向本服务即可上报。traces 会解析落库；metrics 只接受并丢弃。
 */
export function createOtlpRoute(
  db: Database,
  logger?: FileLogger,
  onIngested?: (events: IngestEvent[]) => void,
) {
  const app = new Hono();

  app.post("/v1/traces", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid OTLP payload" }, 400);
    }

    const events = spansToIngestEvents(body);
    const result = ingestService.ingestBatch(db, events, "otlp");
    if (result.appliedEvents.length > 0) {
      try {
        onIngested?.(result.appliedEvents);
      } catch (err) {
        logger?.error(`otlp ingest callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger?.info("otlp traces", { ingested: result.ingested });

    // OTLP 规范要求 HTTP 200 且返回 partialSuccess；不返回 4xx，避免 exporter 反复重投
    return c.json({ partialSuccess: {} }, 200);
  });

  // metrics 暂不落库：返回 200 让 exporter 停止重试
  app.post("/v1/metrics", (c) => c.json({ partialSuccess: {} }, 200));

  return app;
}
