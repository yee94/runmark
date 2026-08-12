import os from "node:os";
import type {
  IngestEvent,
  IngestMessageEvent,
  IngestSessionEvent,
  IngestToolResultEvent,
  IngestTurnEvent,
} from "@agent-tracker/shared";
import { AGENT_ID, PROVIDER_ID, shouldSkipTool } from "./constants";
import type { CursorHookPayload } from "./types";

export interface MapHookOptions {
  includeMessages: boolean;
  includeToolOutput: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从 Hook payload 解析 session / conversation id */
export function resolveSessionId(payload: CursorHookPayload): string | null {
  return (
    asString(payload.session_id)
    ?? asString(payload.conversation_id)
    ?? null
  );
}

function resolveModel(payload: CursorHookPayload): string {
  return asString(payload.model) ?? "unknown";
}

function sessionContext(payload: CursorHookPayload): Pick<
  IngestSessionEvent,
  "directory" | "user_email" | "hostname" | "metadata"
> {
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  const directory = asString(roots[0]) ?? process.env.CURSOR_PROJECT_DIR ?? undefined;
  const userEmail = asString(payload.user_email) ?? asString(process.env.CURSOR_USER_EMAIL);
  let hostname = "unknown";
  try {
    hostname = os.hostname();
  } catch {
    // ignore
  }

  const metadata: Record<string, unknown> = {};
  if (asString(payload.cursor_version)) metadata.cursor_version = payload.cursor_version;
  if (asString(process.env.CURSOR_VERSION)) metadata.cursor_version = process.env.CURSOR_VERSION;

  return {
    directory,
    user_email: userEmail,
    hostname,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

function baseSessionEvent(
  sessionId: string,
  payload: CursorHookPayload,
  extra?: Partial<IngestSessionEvent>,
): IngestSessionEvent {
  const ctx = sessionContext(payload);
  return {
    type: "session.created",
    session_id: sessionId,
    agent: AGENT_ID,
    provider: PROVIDER_ID,
    model: resolveModel(payload),
    directory: ctx.directory,
    user_email: ctx.user_email,
    hostname: ctx.hostname,
    metadata: ctx.metadata,
    ...extra,
  };
}

function truncateTitle(text: string, max = 80): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function parseToolOutput(raw: unknown, includeToolOutput: boolean): string | undefined {
  if (!includeToolOutput || raw == null) return undefined;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if ("stdout" in parsed && typeof parsed.stdout === "string") return parsed.stdout;
        if ("output" in parsed && typeof parsed.output === "string") return parsed.output;
      }
    } catch {
      // keep raw string
    }
    return raw.length > 20_000 ? raw.slice(0, 20_000) + "…" : raw;
  }
  try {
    const s = JSON.stringify(raw);
    return s.length > 20_000 ? s.slice(0, 20_000) + "…" : s;
  } catch {
    return String(raw);
  }
}

/** 将 Cursor Hook stdin JSON 映射为 ingest 事件 */
export function mapHookPayload(payload: CursorHookPayload, options: MapHookOptions): IngestEvent[] {
  const eventName = asString(payload.hook_event_name);
  if (!eventName) return [];

  const sessionId = resolveSessionId(payload);
  const createdAt = nowIso();
  const events: IngestEvent[] = [];

  switch (eventName) {
    case "sessionStart": {
      // 仅打开 Composer / Agent 面板就会触发；等 beforeSubmitPrompt 再建库，避免空会话壳
      break;
    }

    case "sessionEnd": {
      const sid = sessionId;
      if (!sid) break;
      events.push({
        type: "session.idle",
        session_id: sid,
        agent: AGENT_ID,
        ended_at: createdAt,
      });
      break;
    }

    case "beforeSubmitPrompt": {
      const sid = sessionId;
      if (!sid) break;
      const prompt = asString(payload.prompt);
      // 首条用户消息时建 session（含 composer_mode 元信息）
      events.push(baseSessionEvent(sid, payload, {
        title: prompt ? truncateTitle(prompt) : (asString(payload.composer_mode) ? `Cursor ${payload.composer_mode}` : undefined),
        metadata: {
          ...sessionContext(payload).metadata,
          composer_mode: payload.composer_mode,
          is_background_agent: payload.is_background_agent,
        },
      }));
      if (options.includeMessages && prompt) {
        const messageId = asString(payload.generation_id)
          ? `user-${payload.generation_id}`
          : `user-${sid}-${Date.now()}`;
        events.push({
          type: "message",
          session_id: sid,
          message_id: messageId,
          role: "user",
          content: prompt,
          model: resolveModel(payload),
          provider: PROVIDER_ID,
          created_at: createdAt,
        });
      }
      break;
    }

    case "afterAgentResponse": {
      const sid = sessionId;
      if (!sid) break;
      const text = asString(payload.text);
      const generationId = asString(payload.generation_id) ?? `gen-${Date.now()}`;
      const messageId = `assistant-${generationId}`;

      if (options.includeMessages && text) {
        events.push({
          type: "message",
          session_id: sid,
          message_id: messageId,
          role: "assistant",
          content: text,
          model: resolveModel(payload),
          provider: PROVIDER_ID,
          created_at: createdAt,
        });
      }

      // placeholder turn：时间以 Hook 为准；token / cost 由 Usage API 对账 UPDATE 补充
      events.push({
        type: "turn.completed",
        session_id: sid,
        turn_id: messageId,
        message_id: messageId,
        model: resolveModel(payload),
        provider: PROVIDER_ID,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        created_at: createdAt,
      });
      break;
    }

    case "postToolUse": {
      const sid = sessionId;
      if (!sid) break;
      const toolName = asString(payload.tool_name) ?? "tool";
      if (shouldSkipTool(toolName)) break;
      const callId = asString(payload.tool_use_id) ?? `${toolName}-${Date.now()}`;
      const toolInput = payload.tool_input && typeof payload.tool_input === "object"
        ? payload.tool_input as Record<string, unknown>
        : undefined;
      events.push({
        type: "tool.result",
        session_id: sid,
        agent: AGENT_ID,
        turn_id: asString(payload.generation_id),
        tool_name: toolName,
        call_id: callId,
        args: toolInput,
        output_text: parseToolOutput(payload.tool_output, options.includeToolOutput),
        duration_ms: asNumber(payload.duration) ?? 0,
        created_at: createdAt,
      });
      break;
    }

    case "postToolUseFailure": {
      const sid = sessionId;
      if (!sid) break;
      const toolName = asString(payload.tool_name) ?? "tool";
      if (shouldSkipTool(toolName)) break;
      const callId = asString(payload.tool_use_id) ?? `${toolName}-${Date.now()}`;
      events.push({
        type: "tool.result",
        session_id: sid,
        agent: AGENT_ID,
        turn_id: asString(payload.generation_id),
        tool_name: toolName,
        call_id: callId,
        args: payload.tool_input && typeof payload.tool_input === "object"
          ? payload.tool_input as Record<string, unknown>
          : undefined,
        error: asString(payload.error_message) ?? asString(payload.failure_type) ?? "tool failed",
        duration_ms: asNumber(payload.duration) ?? 0,
        created_at: createdAt,
      });
      break;
    }

    case "subagentStart": {
      const subId = asString(payload.subagent_id);
      const parentId = asString(payload.parent_conversation_id);
      if (!subId) break;
      events.push({
        type: "session.created",
        session_id: subId,
        agent: AGENT_ID,
        parent_session_id: parentId,
        title: truncateTitle(asString(payload.task) ?? "Subagent"),
        provider: PROVIDER_ID,
        model: asString(payload.subagent_model) ?? resolveModel(payload),
        branch: asString(payload.git_branch),
        metadata: {
          subagent_type: payload.subagent_type,
          is_parallel_worker: payload.is_parallel_worker,
        },
        ...sessionContext(payload),
      });
      break;
    }

    case "stop": {
      const sid = sessionId;
      if (!sid) break;
      const status = asString(payload.status);
      const generationId = asString(payload.generation_id);
      if (status === "error" || status === "aborted") {
        // 与 afterAgentResponse 成功路径同一 turn_id / message_id（assistant-${generationId}）
        // 仅把终态标成 aborted/error；token/cost 仍由 Usage API 对账回写
        const turnId = generationId
          ? `assistant-${generationId}`
          : `stop-${Date.now()}`;
        events.push({
          type: "turn.error",
          session_id: sid,
          turn_id: turnId,
          message_id: turnId,
          model: resolveModel(payload),
          provider: PROVIDER_ID,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          duration_ms: 0,
          error: status,
          // aborted = 用户中断；error = API/运行失败。Dashboard 用 finish_reason 区分展示
          finish_reason: status,
          created_at: createdAt,
        });
      }
      break;
    }

    default:
      break;
  }

  return events;
}
