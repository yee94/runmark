#!/usr/bin/env bun
/**
 * Runmark — Claude Code / CodeBuddy / WorkBuddy Hook Dispatcher
 *
 * 由 hooks.json 调用的命令行入口：
 *   claude-compat-tracker-hook <event-type> [runtime]
 *   claude-compat-tracker-hook --worker [--queue-dir <dir>]
 *
 * 前台：读 stdin → 追加本地队列文件 → 拉起单飞 worker（若无）→ 立刻回 {} 并 exit。
 * Worker：独立 detached 进程消费队列，做 CodeBuddy IDE turn Debounce / ingest。
 *
 * 用法：
 *   echo '{"session_id":"s1","hook_event_name":"SessionStart",...}' \
 *     | claude-compat-tracker-hook session-start codebuddy
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadClaudeCompatConfig, createClaudeCompatLogger } from "./config";
import { dispatchHookEvent } from "./dispatch";
import {
  enqueueHookJob,
  ensureQueueWorker,
  runQueueWorker,
  resolveQueueDir,
} from "./queue";
import type { ClaudeHookInput } from "./transform";

async function readStdinJson(): Promise<ClaudeHookInput | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return null;
  return JSON.parse(raw) as ClaudeHookInput;
}

/** 当前入口脚本路径（dist/index.mjs），供 spawn worker 使用 */
function resolveSelfScriptPath(): string {
  // bun / node 下 argv[1] 即本文件；fallback 用 import.meta
  const fromArgv = process.argv[1];
  if (fromArgv && (fromArgv.endsWith(".mjs") || fromArgv.endsWith(".ts") || fromArgv.endsWith(".js"))) {
    return fromArgv;
  }
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return join(dirname(fromArgv || "."), "index.mjs");
  }
}

function parseWorkerArgs(args: string[]): { queueDir?: string } {
  let queueDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--queue-dir" && args[i + 1]) {
      queueDir = args[i + 1];
      i++;
    }
  }
  return {
    queueDir: queueDir ?? process.env.AGENT_TRACKER_CLAUDE_COMPAT_QUEUE_DIR,
  };
}

async function runForeground(eventType: string, runtimeArg: string | undefined): Promise<void> {
  let input: ClaudeHookInput | null = null;
  try {
    input = await readStdinJson();
  } catch (err) {
    process.stderr.write(`[agent-tracker-claude-compat] Failed to parse stdin JSON: ${String(err)}\n`);
  }

  // 无论入队是否成功，都先应答宿主；上报在 detached worker 里做
  process.stdout.write("{}\n");

  if (!input) {
    process.exit(0);
  }

  const config = loadClaudeCompatConfig();
  const logger = createClaudeCompatLogger(config);
  const queueDir = resolveQueueDir(process.env.AGENT_TRACKER_CLAUDE_COMPAT_QUEUE_DIR);

  try {
    const job = enqueueHookJob({
      eventType,
      runtimeArg,
      input,
      queueDir,
    });
    logger.debug("hook enqueued", {
      eventType,
      sessionId: input.session_id,
      jobId: job.id,
      queueDir,
    });

    const status = ensureQueueWorker({
      scriptPath: resolveSelfScriptPath(),
      queueDir,
      bunBin: process.execPath,
    });
    logger.debug("queue worker ensure", { status, queueDir });
  } catch (err) {
    logger.error("enqueue/ensure worker failed", { error: String(err), eventType });
  }

  // 前台绝不 await Debounce / ingest；立刻退出让宿主结束 Pending
  process.exit(0);
}

async function runWorkerMode(args: string[]): Promise<void> {
  const { queueDir } = parseWorkerArgs(args);
  const config = loadClaudeCompatConfig();
  const logger = createClaudeCompatLogger(config);

  logger.debug("queue worker process boot", {
    pid: process.pid,
    queueDir: resolveQueueDir(queueDir),
  });

  await runQueueWorker({
    queueDir,
    logger,
    // Debounce 最长约 3.3s；空闲窗口略长，避免 stop 后紧跟的补事件起第二个 worker
    idleExitMs: 4000,
    pollMs: 150,
    handleJob: async (job) => {
      logger.debug("queue worker handle", {
        eventType: job.event_type,
        sessionId: job.input?.session_id,
        jobId: job.id,
      });
      await dispatchHookEvent({
        eventType: job.event_type,
        runtimeArg: job.runtime_arg,
        input: job.input,
        config,
        logger,
      });
    },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--worker") {
    await runWorkerMode(args.slice(1));
    process.exit(0);
  }

  const eventType = args[0];
  const runtimeArg = args[1];

  if (!eventType) {
    process.stderr.write(
      "Usage: claude-compat-tracker-hook <session-start|user-prompt|post-tool-use|stop|session-end|stop-failure> [runtime]\n",
    );
    process.stdout.write("{}\n");
    process.exit(1);
  }

  await runForeground(eventType, runtimeArg);
}

main().catch((err) => {
  process.stderr.write(`[agent-tracker-claude-compat] Fatal: ${String(err)}\n`);
  try {
    process.stdout.write("{}\n");
  } catch {
    /* ignore */
  }
  process.exit(0);
});
