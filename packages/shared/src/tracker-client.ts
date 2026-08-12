import type { IngestEvent } from "./index";
import type { FileLogger } from "./logger";

export type IngestErrorDetail = {
  kind: "http" | "network";
  status?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

/** ingest 失败时 toast 文案：引导用户配置 env，不阻断对话 */
export function buildIngestErrorToastMessage(endpoint: string, detail: IngestErrorDetail): string {
  const headline = detail.kind === "network"
    ? `无法连接 Runmark（${endpoint}）`
    : `Runmark 返回 HTTP ${detail.status}（${endpoint}）`;

  return [
    `${headline}。对话不受影响，遥测数据已丢弃。`,
    "",
    "请按以下步骤配置后重启 OpenCode：",
    "1. 编辑 ~/.config/agent-tracker/env，写入上报服务地址与访问密码，例如：",
    "   endpoint=\"<服务地址>\"",
    "   apiKey=\"<访问密码>\"",
    "2. 重启 OpenCode（插件会自动读取该文件，无需修改 shell 配置）",
    "3. 本地调试：在 agent-tracker 仓库执行 cd packages/server && bun dev",
    "",
    `验证: curl ${endpoint}/health`,
  ].join("\n");
}

/** 缓冲批量上报 /v1/ingest；OpenCode 插件与 Cursor Hook 共用 */
export class TrackerClient {
  private endpoint: string;
  private apiKey: string;
  private buffer: IngestEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private logger: FileLogger;
  private onIngestError?: (detail: IngestErrorDetail) => void;
  private flushThreshold: number;
  private flushDelayMs: number;
  private requestTimeoutMs?: number;

  constructor(
    endpoint: string,
    apiKey: string,
    logger: FileLogger,
    onIngestError?: (detail: IngestErrorDetail) => void,
    options?: { flushThreshold?: number; flushDelayMs?: number; requestTimeoutMs?: number },
  ) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.logger = logger;
    this.onIngestError = onIngestError;
    this.flushThreshold = options?.flushThreshold ?? 10;
    this.flushDelayMs = options?.flushDelayMs ?? 5_000;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  push(event: IngestEvent): void {
    this.logger.debug("event buffered", { type: event.type, session_id: event.session_id });
    this.buffer.push(event);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.flushDelayMs);
      if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    this.logger.debug("flush start", { count: batch.length });
    try {
      const res = await fetch(`${this.endpoint}/v1/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ events: batch }),
        signal: this.requestTimeoutMs ? AbortSignal.timeout(this.requestTimeoutMs) : undefined,
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error("ingest failed", { status: res.status, body, count: batch.length });
        this.onIngestError?.({ kind: "http", status: res.status });
      } else {
        const body = await res.json().catch(() => null);
        this.logger.info("ingest ok", { count: batch.length, result: body });
      }
    } catch (err) {
      this.logger.error("ingest error", { error: String(err), count: batch.length });
      this.onIngestError?.({ kind: "network" });
    }
  }
}
