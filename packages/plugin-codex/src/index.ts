#!/usr/bin/env bun
/**
 * Runmark — Codex CLI Hook Dispatcher
 *
 * 由 Codex hooks.json 调用的命令行入口：
 *   codex-tracker-hook <event-type>
 *
 * 从 stdin 读取 Codex hook JSON → 变换为 IngestEvent → POST 到 Runmark 服务器。
 *
 * Stop 阶段会解析 Codex rollout JSONL，补齐 assistant、tool、token、cost 数据。
 *
 * 用法：
 *   echo '{"session_id":"s1","hook_event_name":"SessionStart",...}' | codex-tracker-hook session-start
 *   echo '{"session_id":"s1","hook_event_name":"Stop",...}'          | codex-tracker-hook stop
 */
import { loadCodexConfig, createCodexLogger } from "./config";
import {
  getGitAuthor,
  getRepoUrl,
  getCurrentBranch,
  getHostname,
} from "./git";
import { shouldSkipTool } from "@agent-tracker/shared";
import {
  transformSessionStart,
  transformSessionResume,
  transformUserPrompt,
  transformPostToolUse,
  transformStop,
  isCodexAmbientSuggestionPrompt,
  isCodexAmbientSuggestionReply,
  isCodexAmbientSuggestionContent,
  type CodexHookInput,
  type SessionMeta,
} from "./transform";
import { sendEvent, sendEvents } from "./send";
import { parseTranscriptEvents, threadMetaFromStateDb } from "./transcript";
import type { IngestSessionEvent } from "@agent-tracker/shared";

// ---------------------------------------------------------------------------
// 主逻辑
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. 解析事件类型
  const eventType = process.argv[2];
  if (!eventType) {
    process.stderr.write(
      "Usage: codex-tracker-hook <session-start|user-prompt|post-tool-use|stop>\n",
    );
    process.stdout.write("{}\n");
    process.exit(1);
  }

  // 2. 读取 stdin JSON
  let input: CodexHookInput;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) {
      // 空 stdin — 静默退出
      process.stdout.write("{}\n");
      process.exit(0);
    }
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[agent-tracker-codex] Failed to parse stdin JSON: ${String(err)}\n`);
    process.stdout.write("{}\n");
    process.exit(0);
  }

  // 3. 加载配置
  const config = loadCodexConfig();
  const logger = createCodexLogger(config);

  logger.debug("hook received", {
    eventType,
    sessionId: input.session_id,
    hookEventName: input.hook_event_name,
  });

  const threadMeta = threadMetaFromStateDb(input.session_id);
  const threadSummaryEvent = (): IngestSessionEvent | undefined => {
    if (!threadMeta.title && !threadMeta.model && !threadMeta.provider) return undefined;
    return {
      type: "session.updated",
      session_id: input.session_id,
      agent: "codex",
      title: threadMeta.title,
      model: threadMeta.model ?? input.model,
      provider: threadMeta.provider,
      metadata: {
        first_user_message: threadMeta.firstUserMessage,
        preview: threadMeta.preview,
      },
    };
  };

  // 4. 采集 git 元信息（首条真实 user prompt 建会话时需要；SessionStart 本身不再建库）
  let meta: SessionMeta = {};
  if (eventType === "user-prompt" || eventType === "session-start") {
    const cwd = input.cwd ?? process.cwd();
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
  }

  // 5. 变换并发送
  try {
    switch (eventType) {
      case "session-start": {
        // startup：等首条真实 UserPromptSubmit 再建库（过滤 ambient 建议空壳）
        // resume/clear/compact：仍上报 compacted
        const source = (input as any).source as string | undefined;
        if (source === "startup") {
          logger.debug("skip session-start startup (defer create to first real prompt)", {
            sessionId: input.session_id,
          });
          break;
        }
        const enrichedInput = { ...input, model: input.model ?? threadMeta.model };
        const ev = transformSessionResume(enrichedInput as any);
        ev.title = threadMeta.title;
        ev.model = threadMeta.model ?? ev.model;
        ev.provider = threadMeta.provider ?? ev.provider;
        await sendEvent(ev, { endpoint: config.endpoint, apiKey: config.apiKey, logger });
        break;
      }

      case "user-prompt": {
        if (!config.includeMessageContent) break;
        const prompt = (input as any).prompt as string | undefined;
        // Codex 打开项目时的 ambient 超个性化建议：非用户触发，整段丢弃
        if (isCodexAmbientSuggestionPrompt(prompt)) {
          logger.debug("skip ambient suggestion prompt", { sessionId: input.session_id });
          break;
        }
        const enrichedInput = { ...input, model: input.model ?? threadMeta.model };
        const created = transformSessionStart(
          {
            ...(enrichedInput as any),
            hook_event_name: "SessionStart",
            source: "startup",
          },
          meta,
        );
        created.title = threadMeta.title ?? created.title;
        created.model = threadMeta.model ?? created.model;
        created.provider = threadMeta.provider ?? created.provider;
        const msg = transformUserPrompt(enrichedInput as any);
        const summary = threadSummaryEvent();
        await sendEvents(
          summary ? [created, msg, summary] : [created, msg],
          { endpoint: config.endpoint, apiKey: config.apiKey, logger },
        );
        break;
      }

      case "post-tool-use": {
        if (!config.includeToolOutput) break;
        // 与 Cursor / Claude-compat 一致：跳过 Read/Write/Shell/Grep/Glob 等高频噪声工具
        if (shouldSkipTool((input as { tool_name?: string }).tool_name ?? "")) {
          logger.debug("skip tool.result", {
            toolName: (input as { tool_name?: string }).tool_name,
            sessionId: input.session_id,
          });
          break;
        }
        const ev = transformPostToolUse(input as any);
        const summary = threadSummaryEvent();
        await sendEvents(summary ? [ev, summary] : [ev], { endpoint: config.endpoint, apiKey: config.apiKey, logger });
        break;
      }

      case "stop": {
        const transcriptEvents = parseTranscriptEvents(input);
        // Stop 阶段 ambient 建议：UserPrompt 常已跳过，transcript 又不含 user，
        // 需同时看 stateDb first_user_message、last_assistant_message、assistant suggestions JSON
        const lastAssistant = (input as { last_assistant_message?: string }).last_assistant_message;
        const ambient =
          isCodexAmbientSuggestionPrompt(threadMeta.firstUserMessage)
          || isCodexAmbientSuggestionReply(lastAssistant)
          || transcriptEvents.some(
            (event) =>
              event.type === "message"
              && isCodexAmbientSuggestionContent(event.content),
          );
        if (ambient) {
          logger.debug("skip ambient suggestion stop", { sessionId: input.session_id });
          break;
        }
        const fallbackEvents = transformStop(input as any);
        const hasAssistant = transcriptEvents.some((event) => event.type === "message" && event.role === "assistant");
        const summary = threadSummaryEvent();
        const events = [
          ...(summary ? [summary] : []),
          ...transcriptEvents,
          ...fallbackEvents.filter((event) => event.type !== "message" || !hasAssistant),
        ];
        await sendEvents(events, { endpoint: config.endpoint, apiKey: config.apiKey, logger });
        break;
      }

      default:
        logger.warn("unknown event type", { eventType });
    }
  } catch (err) {
    logger.error("transform/send failed", { error: String(err), eventType });
  }

  // 6. 始终输出 {} 让 Codex 继续（不阻塞）
  process.stdout.write("{}\n");
}

main().catch((err) => {
  // 兜底：任何未捕获异常都不能让 Codex hook 报错
  process.stderr.write(`[agent-tracker-codex] Fatal: ${String(err)}\n`);
  process.stdout.write("{}\n");
  process.exit(0);
});
