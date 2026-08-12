/**
 * Grok Build Hook stdin JSON → IngestEvent 转换
 *
 * Grok 每个 hook 通过 stdin 传入一个 JSON 对象，字段因事件而异。
 * Stop 阶段通过 ~/.grok/sessions 本地文件补齐 assistant、tool、token、cost。
 */
import type {
  IngestEvent,
  IngestSessionEvent,
  IngestMessageEvent,
  IngestToolResultEvent,
} from "@agent-tracker/shared";

// ---------------------------------------------------------------------------
// Grok Hook 输入类型（宽松定义，兼容 camelCase / snake_case）
// ---------------------------------------------------------------------------

/** 所有 Grok hook stdin 共有的字段 */
export interface GrokHookBase {
  session_id?: string;
  sessionId?: string;
  hook_event_name?: string;
  hookEventName?: string;
  cwd?: string;
  workspace_root?: string;
  workspaceRoot?: string;
  model?: string;
  model_id?: string;
  modelId?: string;
  transcript_path?: string | null;
  transcriptPath?: string | null;
  turn_id?: string;
  turnId?: string;
  permission_mode?: string;
  permissionMode?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  toolName?: string;
  tool_use_id?: string;
  toolUseId?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: unknown;
  toolResponse?: unknown;
  tool_output?: unknown;
  toolOutput?: unknown;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  error?: string;
  reason?: string;
  duration_ms?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export type GrokHookInput = GrokHookBase;

// ---------------------------------------------------------------------------
// Session meta 上下文
// ---------------------------------------------------------------------------

export interface SessionMeta {
  repoUrl?: string;
  branch?: string;
  author?: string;
  hostname?: string;
  directory?: string;
}

export const GROK_AGENT = "grok" as const;

// ---------------------------------------------------------------------------
// 字段归一化
// ---------------------------------------------------------------------------

export function resolveSessionId(input: GrokHookInput): string {
  return String(input.session_id ?? input.sessionId ?? "").trim();
}

export function resolveHookEventName(input: GrokHookInput): string {
  return String(input.hook_event_name ?? input.hookEventName ?? "").trim();
}

export function resolveModel(input: GrokHookInput): string | undefined {
  const model = input.model ?? input.model_id ?? input.modelId;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export function resolveCwd(input: GrokHookInput): string | undefined {
  const cwd = input.cwd ?? input.workspace_root ?? input.workspaceRoot;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
}

export function resolveTurnId(input: GrokHookInput): string | undefined {
  const turnId = input.turn_id ?? input.turnId;
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : undefined;
}

export function resolveToolName(input: GrokHookInput): string {
  return String(input.tool_name ?? input.toolName ?? "unknown").trim() || "unknown";
}

export function resolveToolUseId(input: GrokHookInput): string {
  const id = input.tool_use_id ?? input.toolUseId;
  if (typeof id === "string" && id.trim()) return id.trim();
  return `tool-${resolveSessionId(input)}-${Date.now()}`;
}

export function resolveToolInput(input: GrokHookInput): Record<string, unknown> | undefined {
  const raw = input.tool_input ?? input.toolInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

export function resolveToolOutput(input: GrokHookInput): string | undefined {
  const raw = input.tool_response ?? input.toolResponse ?? input.tool_output ?? input.toolOutput;
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export function resolvePrompt(input: GrokHookInput): string {
  return typeof input.prompt === "string" ? input.prompt : "";
}

export function resolveSource(input: GrokHookInput): string {
  return typeof input.source === "string" && input.source.trim()
    ? input.source.trim()
    : "startup";
}

/** 从 Grok 模型名推导 provider（默认 xai） */
export function inferProvider(model?: string): string {
  if (!model) return "xai";
  const m = model.toLowerCase();
  if (m.includes("grok") || m.includes("xai")) return "xai";
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("gemini")) return "google";
  return "xai";
}

// ---------------------------------------------------------------------------
// 变换函数
// ---------------------------------------------------------------------------

/**
 * SessionStart (startup) → session.created
 */
export function transformSessionStart(
  input: GrokHookInput,
  meta: SessionMeta,
): IngestSessionEvent {
  const sessionId = resolveSessionId(input);
  const model = resolveModel(input);
  const provider = inferProvider(model);
  return {
    type: "session.created",
    session_id: sessionId,
    agent: GROK_AGENT,
    repo_url: meta.repoUrl,
    branch: meta.branch,
    user_email: meta.author,
    hostname: meta.hostname,
    directory: meta.directory ?? resolveCwd(input),
    provider,
    model,
    metadata: {
      source: resolveSource(input),
      permission_mode: input.permission_mode ?? input.permissionMode,
      workspace_root: input.workspace_root ?? input.workspaceRoot,
    },
  };
}

/**
 * SessionStart (resume/clear/compact) → session.compacted
 */
export function transformSessionResume(input: GrokHookInput): IngestSessionEvent {
  return {
    type: "session.compacted",
    session_id: resolveSessionId(input),
    agent: GROK_AGENT,
    metadata: { source: resolveSource(input) },
  };
}

/**
 * UserPromptSubmit → message (user)
 */
export function transformUserPrompt(input: GrokHookInput): IngestMessageEvent {
  const model = resolveModel(input);
  const provider = inferProvider(model);
  const turnId = resolveTurnId(input);
  return {
    type: "message",
    session_id: resolveSessionId(input),
    message_id: turnId ?? `msg-${resolveSessionId(input)}-${Date.now()}`,
    role: "user",
    content: resolvePrompt(input),
    model,
    provider,
    created_at: new Date().toISOString(),
  };
}

/**
 * PostToolUse / PostToolUseFailure → tool.result
 */
export function transformPostToolUse(
  input: GrokHookInput,
  opts?: { failed?: boolean },
): IngestToolResultEvent {
  const output = resolveToolOutput(input);
  const duration =
    typeof input.duration_ms === "number"
      ? input.duration_ms
      : typeof input.durationMs === "number"
        ? input.durationMs
        : 0;
  return {
    type: "tool.result",
    session_id: resolveSessionId(input),
    agent: GROK_AGENT,
    turn_id: resolveTurnId(input),
    tool_name: resolveToolName(input),
    call_id: resolveToolUseId(input),
    args: resolveToolInput(input),
    output_text: output ? String(output).slice(0, 10_000) : undefined,
    duration_ms: duration,
    error: opts?.failed
      ? String(input.error ?? input.reason ?? "tool failed")
      : undefined,
    created_at: new Date().toISOString(),
  };
}

/**
 * Stop / SessionEnd → session.idle（+ 可选 last assistant fallback）
 */
export function transformStop(input: GrokHookInput): IngestEvent[] {
  const events: IngestEvent[] = [];
  const sessionId = resolveSessionId(input);

  events.push({
    type: "session.idle",
    session_id: sessionId,
    agent: GROK_AGENT,
    ended_at: new Date().toISOString(),
  });

  const lastAssistant =
    input.last_assistant_message ?? input.lastAssistantMessage;
  if (typeof lastAssistant === "string" && lastAssistant.trim()) {
    const model = resolveModel(input);
    events.push({
      type: "message",
      session_id: sessionId,
      message_id: resolveTurnId(input) ?? `msg-${sessionId}-${Date.now()}`,
      role: "assistant",
      content: lastAssistant.slice(0, 10_000),
      model,
      provider: inferProvider(model),
      created_at: new Date().toISOString(),
    });
  }

  return events;
}

/**
 * StopFailure → turn.error + session.idle
 */
export function transformStopFailure(input: GrokHookInput): IngestEvent[] {
  const sessionId = resolveSessionId(input);
  const model = resolveModel(input) ?? "grok-4.5";
  const events: IngestEvent[] = [
    {
      type: "turn.error",
      session_id: sessionId,
      turn_id: resolveTurnId(input) ?? `turn-err-${sessionId}-${Date.now()}`,
      model,
      provider: inferProvider(model),
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
      error: String(input.error ?? input.reason ?? "StopFailure"),
      created_at: new Date().toISOString(),
    },
    {
      type: "session.idle",
      session_id: sessionId,
      agent: GROK_AGENT,
      ended_at: new Date().toISOString(),
    },
  ];
  return events;
}
