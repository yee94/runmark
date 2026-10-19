/**
 * Runmark — OpenCode Plugin
 *
 * Captures full conversation details, token usage, and cost from every OpenCode session
 * and reports them to a centralized Runmark server.
 *
 * This plugin follows the same hook API as opencode-otel-plugin but sends data
 * as JSON to our own server instead of via OTLP/protobuf.
 */

import type { Plugin } from "@opencode-ai/plugin";
import type { AssistantMessage, Part } from "@opencode-ai/sdk";
import {
  FileLogger,
  TrackerClient,
  buildIngestErrorToastMessage,
  defaultPluginLogPath,
  loadEnvFile,
  resolveEnvValue,
  shouldSkipTool,
  type IngestErrorDetail,
  type IngestSessionEvent,
  type IngestTurnEvent,
  type IngestMessageEvent,
  type IngestToolResultEvent,
  type PluginConfig,
  forkSourceTitle,
  isForkReplayTurn,
  isForkSessionTitle,
  isHiddenSessionTitle,
} from "@agent-tracker/shared";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** 加载插件配置；fileEnvPath 仅用于测试，默认 ~/.config/agent-tracker/env */
export function loadPluginConfig(fileEnvPath?: string): PluginConfig {
  const fileEnv = loadEnvFile(fileEnvPath);
  const env = (key: string, ...aliases: string[]) => resolveEnvValue(fileEnv, key, ...aliases);

  return {
    endpoint: env("AGENT_TRACKER_ENDPOINT", "endpoint") ?? "http://localhost:3456",
    apiKey: env("AGENT_TRACKER_API_KEY", "apiKey", "api_key") ?? "dev-key-change-me",
    includeMessageContent: (env("AGENT_TRACKER_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
    includeToolOutput: (env("AGENT_TRACKER_INCLUDE_TOOL_OUTPUT", "includeToolOutput") ?? "true") === "true",
    debug: (env("AGENT_TRACKER_DEBUG", "debug") ?? "false") === "true",
    logFile: env("AGENT_TRACKER_LOG_FILE", "logFile", "log_file") ?? defaultPluginLogPath(),
  };
}

function loadConfig(): PluginConfig {
  return loadPluginConfig();
}

function createPluginLogger(config: PluginConfig): FileLogger {
  return new FileLogger({
    filePath: config.logFile ?? defaultPluginLogPath(),
    enabled: config.debug === true,
    component: "plugin",
  });
}

/** 从 OpenCode Part 列表提取可读文本，避免 JSON 垃圾入库 */
function extractTextFromParts(parts: Part[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && "text" in part && part.text) {
      lines.push(normalizeMessageText(part.text));
    } else if (part.type === "subtask" && "prompt" in part && part.prompt) {
      lines.push(normalizeMessageText(part.prompt));
    }
  }
  return lines.join("\n").trim();
}

/** 去掉 OpenCode 文本 part 上多余的首尾引号 */
function normalizeMessageText(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function sumTokens(tokens: AssistantMessage["tokens"]): number {
  return (tokens.input ?? 0) + (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}

/** OpenCode subagent 等场景 turn.cost 常为 0，留空让 server 按 token 估算 */
function turnCostUsd(cost: number | undefined | null): number | undefined {
  return cost != null && cost > 0 ? cost : undefined;
}

type OpenCodeSessionInfo = {
  id?: string;
  agent?: string;
  parentID?: string;
  title?: string;
  time?: {
    created: number;
    updated: number;
    compacting?: number;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  model?: { id: string; providerID: string };
};

/** 从 OpenCode session.updated 提取累计 cost / token，用于校准 */
function sessionSyncFields(info: OpenCodeSessionInfo): Pick<
  IngestSessionEvent,
  "session_cost_usd" | "session_input_tokens" | "session_output_tokens" | "session_total_tokens" | "provider" | "model"
> {
  const fields: Pick<
    IngestSessionEvent,
    "session_cost_usd" | "session_input_tokens" | "session_output_tokens" | "session_total_tokens" | "provider" | "model"
  > = {};
  if (info.cost != null && info.cost > 0) fields.session_cost_usd = info.cost;
  if (info.tokens) {
    fields.session_input_tokens = info.tokens.input;
    fields.session_output_tokens = info.tokens.output;
    const total = sumTokens(info.tokens);
    if (total > 0) fields.session_total_tokens = total;
  }
  if (info.model?.id) fields.model = info.model.id;
  if (info.model?.providerID) fields.provider = info.model.providerID;
  return fields;
}

/** fork 会话登记 cutoff，用于跳过重放的历史 turn */
function registerForkCutoff(
  forkCutoffMs: Map<string, number>,
  sessionID: string,
  title: string | undefined,
  createdMs: number | undefined,
) {
  if (!isForkSessionTitle(title)) return;
  if (forkCutoffMs.has(sessionID)) return;
  forkCutoffMs.set(sessionID, createdMs ?? Date.now());
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

interface PendingTurn {
  sessionID: string;
  model: string;
  provider: string;
  startTime: number;
  /** Set by message.updated when we first see the user message content. */
  userMessageId?: string;
}

interface PluginState {
  client: TrackerClient;
  config: PluginConfig;
  pendingTurns: Map<string, PendingTurn>;
  /** messageID → 累积的文本 part，用于 assistant 回复展示 */
  messageTexts: Map<string, { sessionID: string; role: "user" | "assistant"; texts: string[] }>;
  /** 已入库的 turn（assistant message id） */
  completedTurns: Set<string>;
  /** fork 会话 cutoff（ms）：title 含 (fork #N) 时记录 session.time.created */
  forkCutoffMs: Map<string, number>;
  /** smartfetch-secondary 等临时会话：跳过全部上报 */
  hiddenSessions: Set<string>;
  /** Track sessionID → git metadata for enrichment. */
  sessionMeta: Map<string, {
    branch?: string;
    repoUrl?: string;
    author?: string;
    hostname?: string;
    directory?: string;
    worktree?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Git helpers (reused from opencode-otel-plugin approach)
// ---------------------------------------------------------------------------

async function getGitAuthor($: any): Promise<string> {
  try {
    const result = await $`git config user.email`.text();
    return result.trim();
  } catch {
    return "";
  }
}

async function getRepoUrl($: any): Promise<string> {
  try {
    const result = await $`git remote get-url origin`.text();
    return result.trim();
  } catch {
    return "";
  }
}

async function getCurrentBranch($: any): Promise<string> {
  try {
    const result = await $`git branch --show-current`.text();
    return result.trim();
  } catch {
    return "";
  }
}

function getHostname(): string {
  try {
    return require("os").hostname();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const INGEST_ERROR_TOAST_COOLDOWN_MS = 5 * 60 * 1000;

export const AgentTrackerPlugin: Plugin = async ({ project, $, directory, worktree, client }) => {
  const config = loadConfig();
  const logger = createPluginLogger(config);
  let lastIngestErrorToastAt = 0;

  const notifyIngestError = (detail: IngestErrorDetail) => {
    const now = Date.now();
    if (now - lastIngestErrorToastAt < INGEST_ERROR_TOAST_COOLDOWN_MS) return;
    lastIngestErrorToastAt = now;

    void client.tui.showToast({
      body: {
        title: "Runmark 遥测未连接",
        message: buildIngestErrorToastMessage(config.endpoint, detail),
        variant: "warning",
        duration: 12_000,
      },
      query: { directory },
    }).catch((err) => {
      logger.debug("ingest error toast failed", { error: String(err) });
    });
  };

  const trackerClient = new TrackerClient(config.endpoint, config.apiKey, logger, notifyIngestError);

  void (async () => {
    try {
      const res = await fetch(`${config.endpoint}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) notifyIngestError({ kind: "http", status: res.status });
    } catch {
      notifyIngestError({ kind: "network" });
    }
  })();

  logger.info("plugin initialized", {
    endpoint: config.endpoint,
    logFile: config.logFile,
    includeMessageContent: config.includeMessageContent,
    includeToolOutput: config.includeToolOutput,
    directory,
    worktree,
  });

  const GIT_TIMEOUT = 1_000;
  const [author, repoUrl, branch] = await Promise.race([
    Promise.all([getGitAuthor($), getRepoUrl($), getCurrentBranch($)]),
    new Promise<["", "", ""]>((_, reject) =>
      setTimeout(() => reject(new Error("git-init-timeout")), GIT_TIMEOUT),
    ),
  ]).catch(() => ["", "", ""] as [string, string, string]);

  const hostname = getHostname();

  const state: PluginState = {
    client: trackerClient,
    config,
    pendingTurns: new Map(),
    messageTexts: new Map(),
    completedTurns: new Set(),
    forkCutoffMs: new Map(),
    hiddenSessions: new Set(),
    sessionMeta: new Map(),
  };

  // Helper: get session metadata with fallback
  const getMeta = (sessionID: string) => {
    if (!state.sessionMeta.has(sessionID)) {
      state.sessionMeta.set(sessionID, {
        branch: branch || undefined,
        repoUrl: repoUrl || undefined,
        author: author || undefined,
        hostname,
        directory,
        worktree,
      });
    }
    return state.sessionMeta.get(sessionID)!;
  };

  /** 登记并判断是否为 SmartFetch 等临时会话（与 OpenChamber HIDDEN_SESSION_TITLES 对齐） */
  const markHiddenIfNeeded = (sessionID: string | undefined, title: string | undefined): boolean => {
    if (!sessionID) return false;
    if (isHiddenSessionTitle(title)) {
      state.hiddenSessions.add(sessionID);
      return true;
    }
    return state.hiddenSessions.has(sessionID);
  };

  const isHiddenSession = (sessionID: string | undefined): boolean =>
    !!sessionID && state.hiddenSessions.has(sessionID);

  // Graceful shutdown on server disposed
  const handleShutdown = () => {
    void trackerClient.flush();
  };

  return {
    event: async ({ event }) => {
      try {
        logger.debug("hook event", { type: event.type });
        const props = event.properties as { sessionID?: string; info?: { id?: string; agent?: string; parentID?: string; title?: string } } | undefined;
        const sessionId = props?.sessionID ?? props?.info?.id;
        const meta = sessionId ? getMeta(sessionId) : null;

        switch (event.type) {
          case "session.created": {
            const sessionID = event.properties.info?.id;
            if (!sessionID) return;

            const info = event.properties.info as OpenCodeSessionInfo | undefined;
            if (markHiddenIfNeeded(sessionID, info?.title)) {
              logger.debug("skip hidden session", { sessionID, title: info?.title, type: "session.created" });
              return;
            }
            const m = getMeta(sessionID);
            registerForkCutoff(state.forkCutoffMs, sessionID, info?.title, info?.time?.created);
            const sessionMetadata: Record<string, unknown> = {};
            if (info?.agent) sessionMetadata.opencode_agent = info.agent;
            if (info?.parentID) sessionMetadata.is_subagent = true;
            if (isForkSessionTitle(info?.title)) {
              sessionMetadata.is_fork = true;
              const sourceTitle = forkSourceTitle(info?.title);
              if (sourceTitle) sessionMetadata.fork_source_title = sourceTitle;
            }
            const ev: IngestSessionEvent = {
              type: "session.created",
              session_id: sessionID,
              agent: "opencode",
              title: info?.title,
              parent_session_id: info?.parentID,
              repo_url: m.repoUrl,
              branch: m.branch,
              user_email: m.author,
              hostname: m.hostname,
              worktree,
              directory,
              metadata: Object.keys(sessionMetadata).length ? sessionMetadata : undefined,
              ...sessionSyncFields(info ?? {}),
            };
            trackerClient.push(ev);
            break;
          }

          case "session.updated": {
            const info = event.properties.info as OpenCodeSessionInfo | undefined;
            if (!info?.id) return;

            if (markHiddenIfNeeded(info.id, info.title)) {
              logger.debug("skip hidden session", { sessionID: info.id, title: info.title, type: "session.updated" });
              return;
            }
            registerForkCutoff(state.forkCutoffMs, info.id, info.title, info.time?.created);
            const sessionMetadata: Record<string, unknown> = {};
            if (info.agent) sessionMetadata.opencode_agent = info.agent;
            if (info.parentID) sessionMetadata.is_subagent = true;
            if (isForkSessionTitle(info.title)) {
              sessionMetadata.is_fork = true;
              const sourceTitle = forkSourceTitle(info.title);
              if (sourceTitle) sessionMetadata.fork_source_title = sourceTitle;
            }
            const ev: IngestSessionEvent = {
              type: "session.updated",
              session_id: info.id,
              agent: "opencode",
              title: info.title,
              parent_session_id: info.parentID,
              metadata: Object.keys(sessionMetadata).length ? sessionMetadata : undefined,
              ...sessionSyncFields(info),
            };
            trackerClient.push(ev);
            break;
          }

          case "session.idle": {
            const sessionID = event.properties.sessionID;
            if (!sessionID) return;
            if (isHiddenSession(sessionID)) return;

            const ev: IngestSessionEvent = {
              type: "session.idle",
              session_id: sessionID,
              agent: "opencode",
              ended_at: new Date().toISOString(),
            };
            trackerClient.push(ev);
            void trackerClient.flush();
            break;
          }

          case "message.part.updated": {
            const part = event.properties.part;
            if (!part) break;
            if (isHiddenSession(part.sessionID)) break;

            if (part.type === "text" && "text" in part && part.text?.trim()) {
              const text = normalizeMessageText(part.text);
              const existing = state.messageTexts.get(part.messageID) ?? {
                sessionID: part.sessionID,
                role: "assistant" as const,
                texts: [],
              };
              if (!existing.texts.includes(text)) {
                existing.texts.push(text);
              }
              state.messageTexts.set(part.messageID, existing);
            }

            // step-finish 带 token/cost，作为 message.updated completed 的兜底
            if (part.type === "step-finish" && "tokens" in part && !state.completedTurns.has(part.messageID)) {
              const sessionID = part.sessionID;
              const pending = state.pendingTurns.get(sessionID);
              // fork 重放无 chat.params，无 pending；仅入库 fork 后的真实 turn
              if (state.forkCutoffMs.has(sessionID) && !pending) break;

              const tokens = part.tokens;
              const model = pending?.model ?? "unknown";
              const provider = pending?.provider ?? "unknown";
              const startTime = pending?.startTime ?? Date.now();

              state.completedTurns.add(part.messageID);
              trackerClient.push({
                type: "turn.completed",
                session_id: sessionID,
                turn_id: part.messageID,
                message_id: part.messageID,
                model,
                provider,
                input_tokens: tokens.input ?? 0,
                output_tokens: tokens.output ?? 0,
                cache_read_tokens: tokens.cache?.read,
                cache_write_tokens: tokens.cache?.write,
                reasoning_tokens: tokens.reasoning,
                total_tokens: sumTokens(tokens),
                duration_ms: pending ? Date.now() - startTime : 0,
                cost_usd: turnCostUsd(part.cost),
                finish_reason: part.reason,
                created_at: new Date().toISOString(),
              });
              state.pendingTurns.delete(sessionID);

              if (config.includeMessageContent) {
                const accumulated = state.messageTexts.get(part.messageID);
                const content = accumulated?.texts.join("\n").trim();
                if (content) {
                  trackerClient.push({
                    type: "message",
                    session_id: sessionID,
                    message_id: part.messageID,
                    role: "assistant",
                    content,
                    model,
                    provider,
                    created_at: new Date().toISOString(),
                  });
                  state.messageTexts.delete(part.messageID);
                }
              }
              void trackerClient.flush();
            }
            break;
          }

          case "message.updated": {
            const msg = event.properties.info;
            if (!msg || msg.role !== "assistant") return;

            // 必须等 assistant 消息完成，否则 token 为 0
            if (!msg.time?.completed) return;
            if (state.completedTurns.has(msg.id)) return;

            const sessionID = msg.sessionID;
            if (isHiddenSession(sessionID)) return;
            const tokens = msg.tokens;
            if (!tokens) return;

            const forkCutoff = state.forkCutoffMs.get(sessionID);
            if (isForkReplayTurn(msg.time.completed, forkCutoff)) {
              logger.debug("skip fork replay turn", {
                sessionID,
                messageId: msg.id,
                completed: msg.time.completed,
                forkCutoff,
              });
              return;
            }

            const pending = state.pendingTurns.get(sessionID);
            const model = pending?.model ?? msg.modelID ?? "unknown";
            const provider = pending?.provider ?? msg.providerID ?? "unknown";
            const startTime = pending?.startTime ?? msg.time.created;

            state.completedTurns.add(msg.id);
            const ev: IngestTurnEvent = {
              type: "turn.completed",
              session_id: sessionID,
              turn_id: msg.id,
              message_id: msg.id,
              model,
              provider,
              input_tokens: tokens.input ?? 0,
              output_tokens: tokens.output ?? 0,
              cache_read_tokens: tokens.cache?.read,
              cache_write_tokens: tokens.cache?.write,
              reasoning_tokens: tokens.reasoning,
              total_tokens: sumTokens(tokens),
              duration_ms: msg.time.completed - startTime,
              cost_usd: turnCostUsd(msg.cost),
              finish_reason: msg.finish,
              created_at: new Date(msg.time.completed).toISOString(),
            };
            trackerClient.push(ev);
            state.pendingTurns.delete(sessionID);

            // assistant 回复文本
            if (config.includeMessageContent) {
              const accumulated = state.messageTexts.get(msg.id);
              const content = accumulated?.texts.join("\n").trim();
              if (content) {
                trackerClient.push({
                  type: "message",
                  session_id: sessionID,
                  message_id: msg.id,
                  role: "assistant",
                  content,
                  model,
                  provider,
                  created_at: new Date(msg.time.completed).toISOString(),
                });
                state.messageTexts.delete(msg.id);
              }
            }
            void trackerClient.flush();
            break;
          }

          case "session.error": {
            const sessionID = event.properties.sessionID;
            if (!sessionID) return;
            if (isHiddenSession(sessionID)) return;

            const pending = state.pendingTurns.get(sessionID);
            if (!pending) return;

            const errorName = event.properties.error?.name ?? "UnknownError";
            // MessageAbortedError = 用户中断；其余为 API/运行失败。Dashboard 用 finish_reason 区分 Abort / Error
            const isAbort =
              errorName === "MessageAbortedError" ||
              /abort|interrupt/i.test(errorName);
            const ev: IngestTurnEvent = {
              type: "turn.error",
              session_id: sessionID,
              turn_id: `turn-${sessionID}-${pending.startTime}`,
              model: pending.model,
              provider: pending.provider,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              duration_ms: Date.now() - pending.startTime,
              error: errorName,
              finish_reason: isAbort ? "aborted" : errorName,
              created_at: new Date().toISOString(),
            };
            trackerClient.push(ev);
            state.pendingTurns.delete(sessionID);
            break;
          }

          case "server.instance.disposed": {
            handleShutdown();
            break;
          }
        }
      } catch (err) {
        // Never let telemetry errors crash the plugin
        logger.error("hook event failed", { type: event.type, error: String(err) });
      }
    },

    "chat.message": async (input, output) => {
      try {
        if (!config.includeMessageContent) return;
        if (isHiddenSession(input.sessionID)) return;
        const text = extractTextFromParts(output.parts);
        if (!text) return;

        const modelID = input.model?.modelID ?? output.message.model?.modelID;
        const providerID = input.model?.providerID ?? output.message.model?.providerID;

        trackerClient.push({
          type: "message",
          session_id: input.sessionID,
          message_id: output.message.id,
          role: "user",
          content: text,
          model: modelID,
          provider: providerID,
          created_at: new Date().toISOString(),
        });
        void trackerClient.flush();
      } catch (err) {
        logger.error("hook chat.message failed", { error: String(err) });
      }
    },

    "chat.params": async (input, _output) => {
      try {
        logger.debug("hook chat.params", { sessionID: input.sessionID });
        if (isHiddenSession(input.sessionID)) return;
        const sessionID = input.sessionID;
        const modelID = input.model?.id ?? "unknown";
        const providerID = input.provider?.info?.id ?? input.model?.providerID ?? "unknown";

        state.pendingTurns.set(sessionID, {
          sessionID,
          model: modelID,
          provider: providerID,
          startTime: Date.now(),
        });
      } catch (err) {
        logger.error("hook chat.params failed", { error: String(err) });
      }
    },

    "tool.execute.before": async (input, _output) => {
      logger.debug("hook tool.execute.before", { tool: input.tool, sessionID: input.sessionID });
      // We track tool start time implicitly via callID mapping
    },

    "tool.execute.after": async (input, output) => {
      try {
        logger.debug("hook tool.execute.after", { tool: input.tool, sessionID: input.sessionID });
        if (!config.includeToolOutput) return;
        if (isHiddenSession(input.sessionID)) return;
        // 与 Cursor / Claude-compat 一致：跳过 Read/Write/Shell/Grep/Glob 等高频噪声工具
        if (shouldSkipTool(input.tool)) {
          logger.debug("skip tool.result", { tool: input.tool, sessionID: input.sessionID });
          return;
        }

        const sessionID = input.sessionID;
        const meta = output.metadata as Record<string, unknown> | undefined;

        let filePath: string | undefined;
        let language: string | undefined;

        if (meta) {
          filePath = (meta.path ?? meta.file ?? meta.filepath) as string | undefined;
          if (meta.filediff && typeof meta.filediff === "object") {
            filePath = (meta.filediff as any).file ?? filePath;
          }
        }

        const ev: IngestToolResultEvent = {
          type: "tool.result",
          session_id: sessionID,
          agent: "opencode",
          tool_name: input.tool,
          call_id: input.callID,
          args: input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : undefined,
          output_title: output.title,
          output_metadata: meta ?? undefined,
          output_text: output.output,
          file_path: filePath,
          additions: (meta?.additions ?? (meta?.filediff ? (meta.filediff as any).additions : undefined)) as number | undefined,
          deletions: (meta?.removals ?? (meta?.filediff ? (meta.filediff as any).deletions : undefined)) as number | undefined,
          duration_ms: 0,
          created_at: new Date().toISOString(),
        };
        trackerClient.push(ev);
      } catch (err) {
        logger.error("hook tool.execute.after failed", { error: String(err) });
      }
    },
  };
};

/**
 * OpenCode 1 走 server（函数）。
 * OpenCode 2.0.12 只接受 { id, setup }，事件从 ctx.event.subscribe 读。
 */
const plugin = {
  id: "agent-tracker",
  server: AgentTrackerPlugin,
  setup: async (ctx: unknown) => {
    const { setupAgentTrackerV2 } = await import("./plugin-v2");
    return setupAgentTrackerV2(ctx as Parameters<typeof setupAgentTrackerV2>[0]);
  },
};

export default plugin;
