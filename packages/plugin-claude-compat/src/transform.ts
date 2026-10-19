/**
 * Claude Code / CodeBuddy / WorkBuddy Hook stdin JSON → IngestEvent 转换
 *
 * 三者共享 Claude Code 兼容 Hook 协议；agent 由 runtime / transcript 路径推断。
 * Stop 阶段通过 transcript JSONL 补齐 assistant、tool、token 数据。
 */
import type {
  IngestEvent,
  IngestMessageEvent,
  IngestSessionEvent,
  IngestToolResultEvent,
  IngestTurnEvent,
} from "@agent-tracker/shared";
import { parentSessionIdFromSubagentPath } from "./subagent-paths";

// ---------------------------------------------------------------------------
// Hook 输入类型（宽松定义，仅提取已知字段）
// ---------------------------------------------------------------------------

/** 所有 Claude 兼容 hook stdin 共有的字段 */
export interface ClaudeHookBase {
  session_id: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name: string;
  model?: string;
  permission_mode?: string;
  /** 安装脚本可注入：claude | codebuddy | workbuddy */
  agent_tracker_runtime?: string;
}

export interface ClaudeSessionStart extends ClaudeHookBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
}

export interface ClaudeUserPromptSubmit extends ClaudeHookBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface ClaudePostToolUse extends ClaudeHookBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

export interface ClaudeStop extends ClaudeHookBase {
  hook_event_name: "Stop" | "SessionEnd";
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  reason?: string;
}

/** StopFailure：API 错误结束本轮（Claude Code 文档字段） */
export interface ClaudeStopFailure extends ClaudeHookBase {
  hook_event_name: "StopFailure";
  error?: string;
  error_details?: string;
  last_assistant_message?: string;
}

export type ClaudeHookInput =
  | ClaudeSessionStart
  | ClaudeUserPromptSubmit
  | ClaudePostToolUse
  | ClaudeStop
  | ClaudeStopFailure
  | ClaudeHookBase;

export type ClaudeCompatAgent = "claude" | "codebuddy" | "workbuddy";

export interface SessionMeta {
  agent: ClaudeCompatAgent;
  repoUrl?: string;
  branch?: string;
  author?: string;
  hostname?: string;
  directory?: string;
}

// ---------------------------------------------------------------------------
// Agent / Provider 推断
// ---------------------------------------------------------------------------

/** 路径是否落在某产品数据目录下（优先于易混淆的宿主 env hint） */
function pathLooksLike(agent: ClaudeCompatAgent, pathBlob: string): boolean {
  const p = pathBlob.toLowerCase();
  if (agent === "workbuddy") {
    return p.includes("/.workbuddy/") || p.includes("\\.workbuddy\\") || p.endsWith("/.workbuddy");
  }
  if (agent === "codebuddy") {
    return p.includes("/.codebuddy/") || p.includes("\\.codebuddy\\") || p.endsWith("/.codebuddy");
  }
  return (
    p.includes("/.tclaude/") ||
    p.includes("\\.tclaude\\") ||
    p.endsWith("/.tclaude") ||
    p.includes("/.claude/") ||
    p.includes("\\.claude\\") ||
    p.endsWith("/.claude")
  );
}

/**
 * 从宿主注入的环境变量推断 runtime。
 * WorkBuddy Desktop 内嵌 CLI 仍会设置 CODEBUDDY_PLUGIN_ROOT（兼容变量名），
 * 必须先看 WORKBUDDY_* / CONFIG_DIR / product.json 路径，避免误判为 codebuddy。
 */
export function detectHostRuntime(env: NodeJS.ProcessEnv = process.env): ClaudeCompatAgent | undefined {
  const configDir = `${env.CODEBUDDY_CONFIG_DIR ?? ""} ${env.CLAUDE_CONFIG_DIR ?? ""}`.toLowerCase();
  const productPath = `${env.ACC_PRODUCT_CONFIG_PATH ?? ""}`.toLowerCase();

  if (
    env.WORKBUDDY_PLUGIN_ROOT ||
    env.WORKBUDDY_PLUGIN_DATA ||
    configDir.includes(".workbuddy") ||
    productPath.includes("workbuddy")
  ) {
    return "workbuddy";
  }
  if (env.CODEBUDDY_PLUGIN_ROOT || env.CODEBUDDY_PLUGIN_DATA || configDir.includes(".codebuddy")) {
    return "codebuddy";
  }
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PLUGIN_DATA || configDir.includes(".tclaude") || configDir.includes(".claude")) {
    return "claude";
  }
  return undefined;
}

/** 从 runtime 提示或 transcript 路径推断 agent 名 */
export function resolveAgent(input: {
  runtime?: string | null;
  agent_tracker_runtime?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
}): ClaudeCompatAgent {
  const hint = (input.runtime ?? input.agent_tracker_runtime ?? "").toLowerCase();
  const pathBlob = `${input.transcript_path ?? ""} ${input.cwd ?? ""}`;

  // 路径证据优先：WorkBuddy 常带着 CODEBUDDY_* env，不能让 hint=codebuddy 盖过 ~/.workbuddy transcript
  if (pathLooksLike("workbuddy", pathBlob)) return "workbuddy";
  if (hint.includes("workbuddy")) return "workbuddy";

  if (pathLooksLike("codebuddy", pathBlob)) return "codebuddy";
  if (hint.includes("codebuddy")) return "codebuddy";

  if (pathLooksLike("claude", pathBlob)) return "claude";
  if (hint.includes("tclaude") || hint.includes("claude")) return "claude";

  return "claude";
}

/** 从模型名推导 provider（与 shared canonicalize 语义对齐，便于定价跨 provider 回退） */
export function inferProvider(model?: string): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("deepseek")) return "codebuddy";
  // 智谱 GLM（含 CodeBuddy 内网 glm-*-ioa）
  if (m.includes("glm")) return "zhipu";
  // 混元 hy3-ioa / hy-3
  if (m.includes("hy3") || m.includes("hy-3") || m.includes("hunyuan")) return "hunyuan";
  if (m.includes("kimi") || m.includes("moonshot")) return "moonshot";
  if (m.includes("qwen")) return "aliyun";
  return "unknown";
}

function toolOutputText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.slice(0, 10_000);
  try {
    return JSON.stringify(value).slice(0, 10_000);
  } catch {
    return String(value).slice(0, 10_000);
  }
}

// ---------------------------------------------------------------------------
// 变换函数
// ---------------------------------------------------------------------------

/**
 * SessionStart → IngestSessionEvent (type: "session.created")
 */
export function transformSessionStart(
  input: ClaudeSessionStart,
  meta: SessionMeta,
): IngestSessionEvent {
  const provider = inferProvider(input.model);
  const parentSessionId = input.transcript_path
    ? parentSessionIdFromSubagentPath(input.transcript_path)
    : undefined;
  return {
    type: "session.created",
    session_id: input.session_id,
    agent: meta.agent,
    repo_url: meta.repoUrl,
    branch: meta.branch,
    user_email: meta.author,
    hostname: meta.hostname,
    directory: meta.directory ?? input.cwd,
    provider: provider !== "unknown" ? provider : undefined,
    model: input.model,
    parent_session_id: parentSessionId,
    metadata: {
      source: input.source,
      permission_mode: input.permission_mode,
      runtime: meta.agent,
      ...(parentSessionId ? { is_subagent: true } : {}),
    },
  };
}

/**
 * SessionStart (resume/clear/compact) → IngestSessionEvent (type: "session.compacted")
 */
export function transformSessionResume(
  input: ClaudeSessionStart,
  agent: ClaudeCompatAgent,
): IngestSessionEvent {
  return {
    type: "session.compacted",
    session_id: input.session_id,
    agent,
    metadata: { source: input.source, runtime: agent },
  };
}

/**
 * UserPromptSubmit → IngestMessageEvent (type: "message", role: "user")
 */
export function transformUserPrompt(
  input: ClaudeUserPromptSubmit,
  _agent: ClaudeCompatAgent,
): IngestMessageEvent {
  const provider = inferProvider(input.model);
  return {
    type: "message",
    session_id: input.session_id,
    message_id: `msg-${input.session_id}-${Date.now()}`,
    role: "user",
    content: input.prompt,
    model: input.model,
    provider: provider !== "unknown" ? provider : undefined,
    created_at: new Date().toISOString(),
  };
}

/**
 * PostToolUse → IngestToolResultEvent (type: "tool.result")
 */
export function transformPostToolUse(
  input: ClaudePostToolUse,
  agent: ClaudeCompatAgent,
): IngestToolResultEvent {
  return {
    type: "tool.result",
    session_id: input.session_id,
    agent,
    tool_name: input.tool_name,
    call_id: input.tool_use_id ?? `tool-${input.session_id}-${Date.now()}`,
    args: input.tool_input,
    output_text: toolOutputText(input.tool_response),
    duration_ms: 0,
    created_at: new Date().toISOString(),
  };
}

/** Stop / transcript 里的用户中断文案（WorkBuddy / Claude 兼容） */
export function isInterruptAssistantText(text?: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  return (
    /^interrupted by user\.?$/i.test(t) ||
    /^aborted by user\.?$/i.test(t) ||
    /^user aborted\.?$/i.test(t)
  );
}

/**
 * Stop / SessionEnd → [session.idle, optional assistant fallback]
 * 「Interrupted by user」不当 assistant（会污染 model=unknown），改由调用方报 turn.error。
 */
export function transformStop(
  input: ClaudeStop,
  agent: ClaudeCompatAgent,
): IngestEvent[] {
  const events: IngestEvent[] = [];

  events.push({
    type: "session.idle",
    session_id: input.session_id,
    agent,
    ended_at: new Date().toISOString(),
    metadata: {
      reason: input.reason,
      stop_hook_active: input.stop_hook_active,
      runtime: agent,
    },
  });

  if (input.last_assistant_message && !isInterruptAssistantText(input.last_assistant_message)) {
    const provider = inferProvider(input.model);
    events.push({
      type: "message",
      session_id: input.session_id,
      message_id: `msg-${input.session_id}-${Date.now()}`,
      role: "assistant",
      content: input.last_assistant_message.slice(0, 10_000),
      model: input.model,
      provider: provider !== "unknown" ? provider : undefined,
      created_at: new Date().toISOString(),
    });
  }

  return events;
}

/**
 * Stop 时 last_assistant_message 为用户中断文案 → turn.error（WorkBuddy / Claude Abort）
 * 字段与成功 Turn 对齐（message_id / model），仅 finish_reason=aborted。
 */
export function transformStopAbortFallback(
  input: ClaudeStop,
  agent: ClaudeCompatAgent,
): IngestTurnEvent | null {
  if (!isInterruptAssistantText(input.last_assistant_message)) return null;
  const model = input.model && input.model !== "unknown" ? input.model : "unknown";
  const provider = inferProvider(model);
  const turnId = `abort-${input.session_id}-${Date.now()}`;
  return {
    type: "turn.error",
    session_id: input.session_id,
    turn_id: turnId,
    message_id: turnId,
    model,
    provider: provider !== "unknown" ? provider : "unknown",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
    error: "aborted",
    finish_reason: "aborted",
    created_at: new Date().toISOString(),
  };
}

/**
 * StopFailure → turn.error（API 失败；用户 Abort 在 IDE transcript 的 isCancelled 侧处理）
 */
export function transformStopFailure(
  input: ClaudeStopFailure,
  agent: ClaudeCompatAgent,
): IngestTurnEvent {
  const model = input.model ?? "unknown";
  const provider = inferProvider(model);
  const error =
    [input.error, input.error_details, input.last_assistant_message]
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .join(": ") || "unknown";
  return {
    type: "turn.error",
    session_id: input.session_id,
    turn_id: `stop-failure-${input.session_id}-${Date.now()}`,
    model,
    provider: provider !== "unknown" ? provider : "unknown",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
    error,
    finish_reason: input.error ?? "error",
    created_at: new Date().toISOString(),
  };
}
