import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { ingestService } from "../services/ingest";
import type { FileLogger, IngestEvent, IngestBatchResponse } from "@agent-tracker/shared";

export function createIngestRoute(
  db: Database,
  logger?: FileLogger,
  onIngested?: (events: IngestEvent[]) => void,
) {
  const app = new Hono();

  app.post("/v1/ingest", async (c) => {
    const body = await c.req.json<{ events?: IngestEvent[] }>();
    if (!Array.isArray(body.events)) {
      logger?.warn("ingest rejected: events array required");
      return c.json<IngestBatchResponse>({ ingested: 0, errors: [{ index: -1, error: "events array required" }] }, 400);
    }

    logger?.debug("ingest request", {
      count: body.events.length,
      types: body.events.map((e) => e.type),
      sessions: [...new Set(body.events.map((e) => e.session_id))],
    });

    const { appliedEvents, ...result } = ingestService.ingestBatch(db, body.events);

    if (result.errors.length > 0) {
      logger?.error("ingest partial failure", result);
    } else {
      logger?.info("ingest ok", { ingested: result.ingested });
    }

    if (appliedEvents.length > 0) {
      try {
        onIngested?.(appliedEvents);
      } catch (err) {
        logger?.error(`ingest callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return c.json(result, result.errors.length && result.ingested === 0 ? 422 : 200);
  });

  return app;
}
