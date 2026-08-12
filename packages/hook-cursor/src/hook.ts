import { writeSync } from "node:fs";
import { FileLogger, TrackerClient } from "@agent-tracker/shared";
import { loadHookConfig } from "./config";
import { mapHookPayload } from "./map";
import type { CursorHookPayload } from "./types";

/** 观测型 Hook：任何未捕获异常都不得阻断 Cursor */
function installFailOpenHandlers(): void {
  const bail = () => {
    try {
      process.exit(0);
    } catch {
      // ignore
    }
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
}

/** beforeSubmitPrompt 门禁事件：遥测失败也必须放行 */
function emitContinueIfNeeded(eventName: string | undefined): void {
  if (eventName === "beforeSubmitPrompt") {
    try {
      writeSync(1, `${JSON.stringify({ continue: true })}\n`);
    } catch {
      // ignore
    }
  }
}

/** 从 stdin 读取 Hook JSON（Cursor 以子进程方式调用） */
export async function readHookStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Hook 主流程：观测型 Hook 必须 fail-open（始终 exit 0） */
export async function runHook(): Promise<void> {
  installFailOpenHandlers();

  let eventName: string | undefined;
  const config = loadHookConfig();
  const logger = new FileLogger({
    filePath: config.logFile ?? "",
    enabled: config.debug === true,
    component: "cursor-hook",
  });

  try {
    const raw = await readHookStdin();
    if (!raw.trim()) return;

    const payload = JSON.parse(raw) as CursorHookPayload;
    eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;

    const events = mapHookPayload(payload, {
      includeMessages: config.includeMessages,
      includeToolOutput: config.includeToolOutput,
    });

    if (events.length) {
      const client = new TrackerClient(config.endpoint, config.apiKey, logger, undefined, {
        flushThreshold: 50,
        flushDelayMs: 0,
        requestTimeoutMs: 1_500,
      });
      for (const event of events) {
        client.push(event);
      }
      await client.flush();
    }
  } catch (err) {
    try {
      logger.error("hook failed", { error: err instanceof Error ? err.message : String(err) });
    } catch {
      // ignore
    }
  } finally {
    emitContinueIfNeeded(eventName);
    process.exit(0);
  }
}

await runHook();
