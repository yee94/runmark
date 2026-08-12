/**
 * Codex Hook stdin JSON → IngestEvent 转换
 *
 * Codex 每个 hook 通过 stdin 传入一个 JSON 对象，字段因事件而异。
 * Stop 阶段通过 rollout JSONL 解析补齐 assistant、tool、token、cost 数据。
 */
import type {
  IngestEvent,
  IngestSessionEvent,
  IngestMessageEvent,
  IngestToolResultEvent,
} from "@agent-tracker/shared";

// ---------------------------------------------------------------------------
// Codex Hook 输入类型（宽松定义，仅提取已知字段）
// ---------------------------------------------------------------------------

/** 所有 Codex hook stdin 共有的字段 */
interface CodexHookBase {
  session_id: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name: string;
  model?: string;
  turn_id?: string;
  permission_mode?: string;
}

interface CodexSessionStart extends CodexHookBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
}

interface CodexUserPromptSubmit extends CodexHookBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

interface CodexPostToolUse extends CodexHookBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
}

interface CodexStop extends CodexHookBase {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

export type CodexHookInput =
  | CodexSessionStart
  | CodexUserPromptSubmit
  | CodexPostToolUse
  | CodexStop;

// ---------------------------------------------------------------------------
// Session meta 上下文（SessionStart 时采集，后续事件可能不带）
// ---------------------------------------------------------------------------

export interface SessionMeta {
  repoUrl?: string;
  branch?: string;
  author?: string;
  hostname?: string;
  directory?: string;
}

// ---------------------------------------------------------------------------
// 变换函数
// ---------------------------------------------------------------------------

/** 从 Codex 模型名推导 provider */
export function inferProvider(model?: string): string {
  if (!model) return "unknown";
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.includes("gpt") || m.includes("o3") || m.includes("o4")) return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("deepseek")) return "codebuddy";
  if (m.includes("kimi") || m.includes("moonshot")) return "moonshot";
  if (m.includes("qwen")) return "aliyun";
  return "unknown";
}

/**
 * Codex 打开项目时后台生成的「超个性化建议」系统 prompt，非用户主动会话。
 * 这类会话通常无 LLM turn，不应进入 Tracker。
 */
export function isCodexAmbientSuggestionPrompt(content: unknown): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  const text = content.trim();
  return (
    text.includes("Generate 0 to 3 hyperpersonalized suggestions")
    || (
      text.includes("hyperpersonalized suggestions")
      && text.includes("what this user can do with Codex")
    )
  );
}

/**
 * Codex ambient 建议的 assistant 回复：固定为 {"suggestions":[{title,description,prompt,...}]}。
 * UserPrompt 被跳过时，Stop/transcript 仍可能只带这条 JSON，需一并识别。
 */
export function isCodexAmbientSuggestionReply(content: unknown): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  const text = content.trim();
  if (!text.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text) as { suggestions?: unknown };
    if (!parsed || typeof parsed !== "object") return false;
    const suggestions = parsed.suggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) return false;
    return suggestions.every(
      (item) =>
        item != null
        && typeof item === "object"
        && typeof (item as { title?: unknown }).title === "string"
        && typeof (item as { description?: unknown }).description === "string"
        && typeof (item as { prompt?: unknown }).prompt === "string",
    );
  } catch {
    return false;
  }
}

/** user 模板或 assistant suggestions JSON，任一命中即视为 ambient 建议会话 */
export function isCodexAmbientSuggestionContent(content: unknown): boolean {
  return isCodexAmbientSuggestionPrompt(content) || isCodexAmbientSuggestionReply(content);
}

/**
 * SessionStart → IngestSessionEvent (type: "session.created")
 */
export function transformSessionStart(
  input: CodexSessionStart,
  meta: SessionMeta,
): IngestSessionEvent {
  const provider = inferProvider(input.model);
  return {
    type: "session.created",
    session_id: input.session_id,
    agent: "codex",
    repo_url: meta.repoUrl,
    branch: meta.branch,
    user_email: meta.author,
    hostname: meta.hostname,
    directory: meta.directory ?? input.cwd,
    provider: provider !== "unknown" ? provider : undefined,
    model: input.model,
    metadata: {
      source: input.source,
      permission_mode: input.permission_mode,
    },
  };
}

/**
 * SessionStart (resume/clear/compact) → IngestSessionEvent (type: "session.compacted")
 */
export function transformSessionResume(
  input: CodexSessionStart,
): IngestSessionEvent {
  return {
    type: "session.compacted",
    session_id: input.session_id,
    agent: "codex",
    metadata: { source: input.source },
  };
}

/**
 * UserPromptSubmit → IngestMessageEvent (type: "message", role: "user")
 */
export function transformUserPrompt(
  input: CodexUserPromptSubmit,
): IngestMessageEvent {
  const provider = inferProvider(input.model);
  return {
    type: "message",
    session_id: input.session_id,
    message_id: input.turn_id ?? `msg-${input.session_id}-${Date.now()}`,
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
  input: CodexPostToolUse,
): IngestToolResultEvent {
  return {
    type: "tool.result",
    session_id: input.session_id,
    agent: "codex",
    turn_id: input.turn_id,
    tool_name: input.tool_name,
    call_id: input.tool_use_id,
    args: input.tool_input,
    output_text: input.tool_response
      ? String(input.tool_response).slice(0, 10_000)
      : undefined,
    duration_ms: 0, // Codex hook 不提供耗时
    created_at: new Date().toISOString(),
  };
}

/**
 * Stop → [IngestSessionEvent (type: "session.idle"), IngestMessageEvent (assistant)]
 */
export function transformStop(
  input: CodexStop,
): IngestEvent[] {
  const events: IngestEvent[] = [];

  // session.idle
  events.push({
    type: "session.idle",
    session_id: input.session_id,
    agent: "codex",
    ended_at: new Date().toISOString(),
  });

  // assistant 最后一条消息（只有 Stop 时 codex 才提供）
  if (input.last_assistant_message) {
    const provider = inferProvider(input.model);
    events.push({
      type: "message",
      session_id: input.session_id,
      message_id: input.turn_id ?? `msg-${input.session_id}-${Date.now()}`,
      role: "assistant",
      content: input.last_assistant_message.slice(0, 10_000),
      model: input.model,
      provider: provider !== "unknown" ? provider : undefined,
      created_at: new Date().toISOString(),
    });
  }

  return events;
}
