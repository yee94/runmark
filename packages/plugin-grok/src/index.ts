#!/usr/bin/env bun
/**
 * Runmark — Grok Build CLI Hook Dispatcher
 *
 * 由 ~/.grok/hooks/runmark-tracker.json 调用的命令行入口：
 *   grok-tracker-hook <event-type>
 *
 * 从 stdin 读取 Grok hook JSON → 变换为 IngestEvent → POST 到 Runmark 服务器。
 *
 * Stop 阶段会解析 ~/.grok/sessions 本地文件，补齐 assistant、tool、token、cost。
 *
 * 用法：
 *   echo '{"sessionId":"s1","hookEventName":"SessionStart",...}' | grok-tracker-hook session-start
 *   echo '{"sessionId":"s1","hookEventName":"Stop",...}'         | grok-tracker-hook stop
 */
import { shouldSkipTool } from "@agent-tracker/shared";
import { loadGrokConfig, createGrokLogger } from "./config";
import {
  getGitAuthor,
  getRepoUrl,
  getCurrentBranch,
  getHostname,
} from "./git";
import { sendEvent, sendEvents } from "./send";
import { parseGrokSessionEvents, readGrokSummary, resolveGrokSessionDir } from "./session";
import {
  transformSessionStart,
  transformSessionResume,
  transformUserPrompt,
  transformPostToolUse,
  transformStop,
  transformStopFailure,
  resolveSessionId,
  resolveHookEventName,
  resolveModel,
  resolveCwd,
  resolveSource,
  resolveToolName,
  type GrokHookInput,
  type SessionMeta,
} from "./transform";

// ---------------------------------------------------------------------------
// 主逻辑
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. 解析事件类型（兼容 argv 与 hookEventName）
  let eventType = process.argv[2];

  // 2. 读取 stdin JSON
  let input: GrokHookInput;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) {
      process.stdout.write("{}\n");
      process.exit(0);
    }
    input = JSON.parse(raw) as GrokHookInput;
  } catch (err) {
    process.stderr.write(`[agent-tracker-grok] Failed to parse stdin JSON: ${String(err)}\n`);
    process.stdout.write("{}\n");
    process.exit(0);
  }

  if (!eventType) {
    // 允许 hooks.json 不带 argv，从 stdin 推断
    const name = resolveHookEventName(input).toLowerCase();
    if (name === "sessionstart") eventType = "session-start";
    else if (name === "sessionend") eventType = "session-end";
    else if (name === "userpromptsubmit") eventType = "user-prompt";
    else if (name === "posttooluse") eventType = "post-tool-use";
    else if (name === "posttoolusefailure") eventType = "post-tool-use-failure";
    else if (name === "stop") eventType = "stop";
    else if (name === "stopfailure") eventType = "stop-failure";
    else if (name === "precompact" || name === "postcompact") eventType = "session-start";
  }

  if (!eventType) {
    process.stderr.write(
      "Usage: grok-tracker-hook <session-start|user-prompt|post-tool-use|post-tool-use-failure|stop|stop-failure|session-end>\n",
    );
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const sessionId = resolveSessionId(input);
  if (!sessionId) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // 3. 加载配置
  const config = loadGrokConfig();
  const logger = createGrokLogger(config);

  logger.debug("hook received", {
    eventType,
    sessionId,
    hookEventName: resolveHookEventName(input),
  });

  // 4. 采集 git 元信息
  let meta: SessionMeta = {};
  if (eventType === "user-prompt" || eventType === "session-start") {
    const cwd = resolveCwd(input) ?? process.cwd();
    try {
      const [author, repoUrl, branch] = await Promise.all([
        getGitAuthor(cwd),
        getRepoUrl(cwd),
        getCurrentBranch(cwd),
      ]);
      meta = {
        author: author || undefined,
        repoUrl: repoUrl || undefined,
        branch: branch || undefined,
        hostname: getHostname(),
        directory: cwd,
      };
    } catch {
      // git 失败不影响主流程
    }

    // summary.json 可补 title / model / git
    const sessionDir = resolveGrokSessionDir(input);
    if (sessionDir) {
      const summary = readGrokSummary(sessionDir);
      if (!meta.repoUrl && summary.repoUrl) meta.repoUrl = summary.repoUrl;
      if (!meta.branch && summary.branch) meta.branch = summary.branch;
      if (!meta.directory && summary.directory) meta.directory = summary.directory;
      if (!resolveModel(input) && summary.model) {
        input = { ...input, model: summary.model };
      }
    }
  }

  // 5. 变换并发送
  try {
    switch (eventType) {
      case "session-start": {
        const source = resolveSource(input);
        // startup：等首条真实 UserPromptSubmit 再建库
        if (source === "startup" || source === "new") {
          logger.debug("skip session-start startup (defer create to first real prompt)", {
            sessionId,
          });
          break;
        }
        // resume / clear / compact / precompact / postcompact
        const ev = transformSessionResume(input);
        await sendEvent(ev, {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      case "user-prompt": {
        if (!config.includeMessageContent) break;
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (!prompt.trim()) break;

        const created = transformSessionStart(
          {
            ...input,
            source: "startup",
          },
          meta,
        );
        // 补 title
        const sessionDir = resolveGrokSessionDir(input);
        if (sessionDir) {
          const summary = readGrokSummary(sessionDir);
          if (summary.title) created.title = summary.title;
          if (summary.model) {
            created.model = summary.model;
            created.provider = "xai";
          }
        }
        const msg = transformUserPrompt(input);
        await sendEvents([created, msg], {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      case "post-tool-use": {
        if (!config.includeToolOutput) break;
        if (shouldSkipTool(resolveToolName(input))) {
          logger.debug("skip tool.result", {
            toolName: resolveToolName(input),
            sessionId,
          });
          break;
        }
        const ev = transformPostToolUse(input);
        await sendEvent(ev, {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      case "post-tool-use-failure": {
        if (!config.includeToolOutput) break;
        if (shouldSkipTool(resolveToolName(input))) break;
        const ev = transformPostToolUse(input, { failed: true });
        await sendEvent(ev, {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      case "stop":
      case "session-end": {
        const sessionEvents = parseGrokSessionEvents({
          input,
          includeMessages: config.includeMessageContent,
          includeToolOutput: config.includeToolOutput,
        });
        const fallback = transformStop(input);
        const hasAssistant = sessionEvents.some(
          (e) => e.type === "message" && e.role === "assistant",
        );
        const events = [
          ...sessionEvents,
          ...fallback.filter((e) => e.type !== "message" || !hasAssistant),
        ];
        await sendEvents(events, {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      case "stop-failure": {
        const sessionEvents = parseGrokSessionEvents({
          input,
          includeMessages: config.includeMessageContent,
          includeToolOutput: config.includeToolOutput,
        });
        const failure = transformStopFailure(input);
        await sendEvents([...sessionEvents, ...failure], {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      default:
        logger.warn("unknown event type", { eventType });
    }
  } catch (err) {
    logger.error("transform/send failed", { error: String(err), eventType });
  }

  // 6. 始终输出 {} 让 Grok 继续（不阻塞）
  process.stdout.write("{}\n");
}

main().catch((err) => {
  process.stderr.write(`[agent-tracker-grok] Fatal: ${String(err)}\n`);
  process.stdout.write("{}\n");
  process.exit(0);
});
