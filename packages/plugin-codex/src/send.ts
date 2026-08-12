/**
 * HTTP 发送模块 — POST 事件到 Runmark 服务器
 */
import type { IngestEvent, FileLogger } from "@agent-tracker/shared";

export interface SendOptions {
  endpoint: string;
  apiKey: string;
  logger: FileLogger;
}

/**
 * 发送单个事件到 /v1/ingest（包装为单事件批次）
 * 失败仅记录日志，不抛异常（Codex hook 不能 crash）
 */
export async function sendEvent(
  event: IngestEvent,
  opts: SendOptions,
): Promise<void> {
  try {
    const res = await fetch(`${opts.endpoint}/v1/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": opts.apiKey,
      },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const body = await res.text();
      opts.logger.error("ingest failed", {
        status: res.status,
        body,
        eventType: event.type,
        sessionId: event.session_id,
      });
    } else {
      opts.logger.debug("ingest ok", {
        eventType: event.type,
        sessionId: event.session_id,
      });
    }
  } catch (err) {
    opts.logger.error("ingest error", {
      error: String(err),
      eventType: event.type,
      sessionId: event.session_id,
    });
  }
}

/**
 * 批量发送事件（Stop 时可能产生多个事件）
 */
export async function sendEvents(
  events: IngestEvent[],
  opts: SendOptions,
): Promise<void> {
  for (const event of events) {
    await sendEvent(event, opts);
  }
}
