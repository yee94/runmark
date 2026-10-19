/**
 * Hook 事件分发：队列 job → IngestEvent → POST
 *
 * 由 queue worker 调用；Stop 的 CodeBuddy IDE turn Debounce 也在此（不在 hook 前台进程）。
 */
import type { FileLogger } from "@agent-tracker/shared";
import type { PluginConfig } from "@agent-tracker/shared";
import {
  getGitAuthor,
  getRepoUrl,
  getCurrentBranch,
  getHostname,
} from "./git";
import {
  detectHostRuntime,
  resolveAgent,
  transformSessionStart,
  transformSessionResume,
  transformUserPrompt,
  transformPostToolUse,
  transformStop,
  transformStopAbortFallback,
  transformStopFailure,
  type ClaudeHookInput,
  type SessionMeta,
} from "./transform";
import { shouldSkipTool } from "./constants";
import { sendEvents } from "./send";
import { parseClaudeTranscriptEvents } from "./transcript";
import {
  collectSubagentEvents,
  isSubagentTranscriptPath,
  resolvePostToolUseTarget,
} from "./subagents";
import {
  collectTranscriptEventsForStop,
  orderIdeEventsForIngest,
  shouldDebounceCodeBuddyIde,
} from "./strategies/codebuddy-ide";

export interface DispatchOptions {
  eventType: string;
  runtimeArg?: string;
  input: ClaudeHookInput;
  config: PluginConfig;
  logger: FileLogger;
}

/** 处理单个 hook 事件（仅在 queue worker 中调用；前台只入队） */
export async function dispatchHookEvent(opts: DispatchOptions): Promise<void> {
  const { eventType, runtimeArg, input, config, logger } = opts;

  const hostRuntime = detectHostRuntime();
  const agent = resolveAgent({
    runtime: runtimeArg || hostRuntime,
    agent_tracker_runtime: (input as { agent_tracker_runtime?: string }).agent_tracker_runtime,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
  });

  logger.debug("hook dispatch", {
    eventType,
    agent,
    sessionId: input.session_id,
    hookEventName: input.hook_event_name,
  });

  let meta: SessionMeta = { agent };
  if (eventType === "session-start") {
    const cwd = input.cwd ?? process.cwd();
    try {
      const [author, repoUrl, branch] = await Promise.all([
        getGitAuthor(cwd),
        getRepoUrl(cwd),
        getCurrentBranch(cwd),
      ]);
      meta = {
        agent,
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

  switch (eventType) {
    case "session-start": {
      const source = (input as { source?: string }).source ?? "startup";
      const ev = source === "startup"
        ? transformSessionStart(input as any, meta)
        : transformSessionResume(input as any, agent);
      await sendEvents([ev], { endpoint: config.endpoint, apiKey: config.apiKey, logger });
      break;
    }

    case "user-prompt": {
      if (!config.includeMessageContent) break;
      const ev = transformUserPrompt(input as any, agent);
      await sendEvents([ev], { endpoint: config.endpoint, apiKey: config.apiKey, logger });
      break;
    }

    case "post-tool-use": {
      if (!config.includeToolOutput) break;
      // 与 Cursor 一致：跳过 Read/Write/Shell|Bash/Grep 等高频噪声工具
      const toolName = (input as { tool_name?: string }).tool_name ?? "";
      if (shouldSkipTool(toolName)) {
        logger.debug("skip tool.result", {
          toolName,
          sessionId: input.session_id,
        });
        break;
      }
      const callId = (input as { tool_use_id?: string }).tool_use_id ?? "";
      const target = resolvePostToolUseTarget({
        agent,
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        callId,
      });
      if (target.skip) {
        logger.debug("skip parent post-tool-use owned by subagent", {
          toolName,
          callId,
          sessionId: input.session_id,
        });
        break;
      }
      const ev = transformPostToolUse(
        { ...(input as object), session_id: target.sessionId } as any,
        agent,
      );
      await sendEvents([ev], { endpoint: config.endpoint, apiKey: config.apiKey, logger });
      break;
    }

    case "stop-failure": {
      // Claude Code：API 错误走 StopFailure（用户 interrupt 不触发 Stop）
      const ev = transformStopFailure(input as any, agent);
      await sendEvents([ev], { endpoint: config.endpoint, apiKey: config.apiKey, logger });
      break;
    }

    case "stop":
    case "session-end": {
      // CodeBuddy IDE：只 Debounce turn，就绪后同批 message+turn；无 turn 则本轮不报 assistant
      const transcriptEvents = await collectTranscriptEventsForStop({
        sessionId: input.session_id,
        agent,
        transcriptPath: input.transcript_path,
        parseOnce: (path) =>
          parseClaudeTranscriptEvents({
            session_id: input.session_id,
            agent,
            transcript_path: path,
            // SessionEnd：刷出仍无 result 的 CLI function_call 骨架
            flushPendingTools: eventType === "session-end",
          }),
        logger,
      });

      // 父会话 Stop：顺带扫 …/<sessionId>/subagents/*.jsonl（子路径自身的 Stop 不再扫）
      const parentPath = input.transcript_path ?? "";
      const subagentEvents =
        parentPath && !isSubagentTranscriptPath(parentPath)
          ? collectSubagentEvents({
              parentSessionId: input.session_id,
              parentTranscriptPath: parentPath,
              agent,
              flushPendingTools: eventType === "session-end",
            })
          : [];

      // SessionEnd：CodeBuddy IDE 整批补；其它 runtime 只补 turn/tool；子会话保留 session.created
      if (eventType === "session-end") {
        const ide = shouldDebounceCodeBuddyIde(agent, input.transcript_path);
        const catchUp = ide
          ? orderIdeEventsForIngest(transcriptEvents)
          : transcriptEvents.filter(
              (event) =>
                event.type === "turn.completed" ||
                event.type === "turn.error" ||
                event.type === "tool.result" ||
                (event.type === "message" && event.role === "reasoning"),
            );
        const subCatchUp = subagentEvents.filter(
          (event) =>
            event.type === "session.created" ||
            event.type === "turn.completed" ||
            event.type === "turn.error" ||
            event.type === "tool.result" ||
            (event.type === "message" && event.role === "reasoning"),
        );
        const idle = transformStop(input as any, agent).filter((event) => event.type === "session.idle");
        await sendEvents([...catchUp, ...subCatchUp, ...idle], {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          logger,
        });
        break;
      }

      const fallbackEvents = transformStop(input as any, agent);
      const hasAssistant = transcriptEvents.some(
        (event) => event.type === "message" && event.role === "assistant",
      );
      const hasTurn = transcriptEvents.some(
        (event) => event.type === "turn.completed" || event.type === "turn.error",
      );
      // CodeBuddy IDE：无 turn 时禁止 last_assistant_message；有 turn 时也不用 fallback 抢正文
      const codebuddyIde =
        shouldDebounceCodeBuddyIde(agent, input.transcript_path);
      // WorkBuddy Abort：transcript 未出 turn.error 时，Interrupted 文案走 turn.error，禁止 unknown assistant
      const abortFallback =
        !hasTurn && !codebuddyIde
          ? transformStopAbortFallback(input as any, agent)
          : null;
      const events = orderIdeEventsForIngest([
        ...transcriptEvents,
        ...subagentEvents,
        ...(abortFallback ? [abortFallback] : []),
        ...fallbackEvents.filter((event) => {
          if (event.type !== "message") return true;
          if (hasAssistant) return false;
          if (codebuddyIde && !hasTurn) return false;
          // Interrupted 已转 turn.error，不再当 message
          if (abortFallback) return false;
          return true;
        }),
      ]);
      await sendEvents(events, { endpoint: config.endpoint, apiKey: config.apiKey, logger });
      break;
    }

    default:
      logger.warn("unknown event type", { eventType });
  }
}
