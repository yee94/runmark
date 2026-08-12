/**
 * Codex rollout JSONL 解析
 *
 * Codex Hook stdin 不直接提供 assistant/tool/token 完整数据，但 transcript_path
 * 指向的 rollout JSONL 中包含 response_item、token_count、task_complete 等事件。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { shouldSkipTool, type IngestEvent, type IngestToolCallPayload } from "@agent-tracker/shared";
import { inferProvider, type CodexHookInput } from "./transform";

type JsonObject = Record<string, unknown>;

interface TranscriptTurn {
  turnId: string;
  model: string;
  provider: string;
  assistantMessages: IngestEvent[];
  toolResults: IngestEvent[];
  toolCalls: Map<string, IngestToolCallPayload>;
  tokenUsage: {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  finalMessageId?: string;
}

interface TokenUsageSnapshot {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const obj = objectValue(item);
    if (!obj) continue;
    const type = stringValue(obj.type);
    const text = stringValue(obj.text);
    if ((type === "output_text" || type === "input_text") && text) parts.push(text);
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const obj = objectValue(item);
      const text = obj ? stringValue(obj.text) : undefined;
      if (text) parts.push(text);
    }
    const joined = parts.join("\n").trim();
    return joined || undefined;
  }
  const obj = objectValue(output);
  if (!obj) return undefined;
  const text = stringValue(obj.text) ?? stringValue(obj.content) ?? stringValue(obj.output);
  if (text) return text;
  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return { raw };
  }
}

function metadataTurnId(payload: JsonObject): string | undefined {
  const meta = objectValue(payload.internal_chat_message_metadata_passthrough);
  return meta ? stringValue(meta.turn_id) : undefined;
}

function transcriptPathFromStateDb(sessionId: string): string | undefined {
  const dbPath = `${homedir()}/.codex/state_5.sqlite`;
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT rollout_path FROM threads WHERE id = $id").get({ $id: sessionId }) as { rollout_path?: string } | null;
    db.close();
    return row?.rollout_path;
  } catch {
    return undefined;
  }
}

export interface CodexThreadMeta {
  title?: string;
  firstUserMessage?: string;
  preview?: string;
  model?: string;
  provider?: string;
}

export function threadMetaFromStateDb(sessionId: string): CodexThreadMeta {
  const dbPath = `${homedir()}/.codex/state_5.sqlite`;
  if (!existsSync(dbPath)) return {};
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query(
      "SELECT title, first_user_message, preview, model, model_provider FROM threads WHERE id = $id",
    ).get({ $id: sessionId }) as {
      title?: string;
      first_user_message?: string;
      preview?: string;
      model?: string;
      model_provider?: string;
    } | null;
    db.close();
    return {
      title: row?.title || row?.first_user_message || row?.preview || undefined,
      firstUserMessage: row?.first_user_message || undefined,
      preview: row?.preview || undefined,
      model: row?.model || undefined,
      provider: row?.model_provider || undefined,
    };
  } catch {
    return {};
  }
}

function sessionStartFromStateDb(sessionId: string, parentSessionId?: string): IngestEvent | undefined {
  const meta = threadMetaFromStateDb(sessionId);
  if (!meta.title && !meta.model && !meta.provider && !parentSessionId) return undefined;
  return {
    type: "session.created",
    session_id: sessionId,
    agent: "codex",
    title: meta.title,
    model: meta.model,
    provider: meta.provider ?? inferProvider(meta.model),
    parent_session_id: parentSessionId,
    metadata: {
      first_user_message: meta.firstUserMessage,
      preview: meta.preview,
    },
  };
}

function childSessionIdsFromOutput(output: unknown): string[] {
  const text = outputText(output);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const obj = objectValue(parsed);
    const id = obj ? stringValue(obj.agent_id) : undefined;
    return id ? [id] : [];
  } catch {
    const ids = new Set<string>();
    for (const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      ids.add(match[0]);
    }
    return Array.from(ids);
  }
}

export function resolveTranscriptPath(input: CodexHookInput): string | undefined {
  if (input.transcript_path) return input.transcript_path;
  return transcriptPathFromStateDb(input.session_id);
}

function createTurn(turnId: string, model?: string): TranscriptTurn {
  const resolvedModel = model || "unknown";
  return {
    turnId,
    model: resolvedModel,
    provider: inferProvider(resolvedModel),
    assistantMessages: [],
    toolResults: [],
    toolCalls: new Map(),
    tokenUsage: {
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
    },
  };
}

const FAST_PRICED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

/** Codex 的 fast / priority 档位使用独立定价 model id。 */
export function normalizeCodexModelForServiceTier(model: string | undefined, serviceTier: string | undefined): string | undefined {
  const normalizedModel = model?.trim().toLowerCase();
  if (!normalizedModel) return model;
  const normalizedTier = serviceTier?.trim().toLowerCase();
  if ((normalizedTier === "fast" || normalizedTier === "priority") && FAST_PRICED_MODELS.has(normalizedModel)) {
    return `${normalizedModel}-fast`;
  }
  return normalizedModel;
}

export function parseTranscriptEvents(input: CodexHookInput): IngestEvent[] {
  return parseTranscriptEventsInternal(input, undefined, new Set());
}

function zeroUsage(): TokenUsageSnapshot {
  return {
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  };
}

function usageSnapshot(raw: unknown): TokenUsageSnapshot | undefined {
  const usage = objectValue(raw);
  if (!usage) return undefined;
  return {
    input_tokens: numberValue(usage.input_tokens) ?? 0,
    cache_read_tokens: numberValue(usage.cached_input_tokens) ?? 0,
    cache_write_tokens: numberValue(usage.cache_creation_input_tokens) ?? 0,
    output_tokens: numberValue(usage.output_tokens) ?? 0,
    reasoning_tokens: numberValue(usage.reasoning_output_tokens) ?? 0,
    total_tokens: numberValue(usage.total_tokens) ?? 0,
  };
}

function usageDelta(prev: TokenUsageSnapshot, next: TokenUsageSnapshot): TokenUsageSnapshot {
  return {
    input_tokens: Math.max(next.input_tokens - prev.input_tokens, 0),
    cache_read_tokens: Math.max(next.cache_read_tokens - prev.cache_read_tokens, 0),
    cache_write_tokens: Math.max(next.cache_write_tokens - prev.cache_write_tokens, 0),
    output_tokens: Math.max(next.output_tokens - prev.output_tokens, 0),
    reasoning_tokens: Math.max(next.reasoning_tokens - prev.reasoning_tokens, 0),
    total_tokens: Math.max(next.total_tokens - prev.total_tokens, 0),
  };
}

function addUsage(turn: TranscriptTurn, delta: TokenUsageSnapshot): void {
  turn.tokenUsage.input_tokens += Math.max(delta.input_tokens - delta.cache_read_tokens - delta.cache_write_tokens, 0);
  turn.tokenUsage.cache_read_tokens += delta.cache_read_tokens;
  turn.tokenUsage.cache_write_tokens += delta.cache_write_tokens;
  turn.tokenUsage.output_tokens += delta.output_tokens;
  turn.tokenUsage.reasoning_tokens += delta.reasoning_tokens;
  turn.tokenUsage.total_tokens += delta.total_tokens;
}

function parseTranscriptEventsInternal(
  input: CodexHookInput,
  parentSessionId: string | undefined,
  visited: Set<string>,
): IngestEvent[] {
  if (visited.has(input.session_id)) return [];
  visited.add(input.session_id);
  const path = resolveTranscriptPath(input);
  if (!path || !existsSync(path)) return [];

  const turns = new Map<string, TranscriptTurn>();
  const childSessionIds = new Set<string>();
  let activeTurnId = input.turn_id;
  let activeModel = input.model;
  let activeServiceTier: string | undefined;
  let lastSessionUsage: TokenUsageSnapshot | undefined;

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let record: JsonObject;
    try {
      record = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }
    const timestamp = stringValue(record.timestamp) ?? new Date().toISOString();
    const payload = objectValue(record.payload);
    if (!payload) continue;

    const recordType = stringValue(record.type);
    const payloadType = stringValue(payload.type);

    if (payloadType === "thread_settings_applied") {
      const settings = objectValue(payload.thread_settings);
      activeModel = stringValue(settings?.model) ?? activeModel;
      activeServiceTier = stringValue(settings?.service_tier) ?? activeServiceTier;
      continue;
    }

    if (recordType === "turn_context") {
      const turnId = stringValue(payload.turn_id);
      if (!turnId) continue;
      activeTurnId = turnId;
      activeModel = stringValue(payload.model) ?? activeModel;
      const normalizedModel = normalizeCodexModelForServiceTier(activeModel, activeServiceTier);
      const turn = turns.get(turnId) ?? createTurn(turnId, normalizedModel);
      turn.model = normalizedModel || turn.model;
      turn.provider = inferProvider(turn.model);
      turns.set(turnId, turn);
      continue;
    }

    if (payloadType === "task_started") {
      const turnId = stringValue(payload.turn_id);
      if (!turnId) continue;
      activeTurnId = turnId;
      const turn = turns.get(turnId) ?? createTurn(turnId, activeModel);
      const startedAt = numberValue(payload.started_at);
      if (startedAt) turn.startedAt = new Date(startedAt * 1000).toISOString();
      turns.set(turnId, turn);
      continue;
    }

    if (recordType === "response_item") {
      const itemType = stringValue(payload.type);
      if (itemType === "message" && stringValue(payload.role) === "assistant") {
        const turnId = metadataTurnId(payload) ?? activeTurnId;
        if (!turnId) continue;
        const text = contentText(payload.content);
        if (!text) continue;
        const turn = turns.get(turnId) ?? createTurn(turnId, activeModel);
        const messageId = stringValue(payload.id) ?? `${turnId}-assistant-${turn.assistantMessages.length + 1}`;
        turn.finalMessageId = messageId;
        turn.assistantMessages.push({
          type: "message",
          session_id: input.session_id,
          message_id: messageId,
          role: "assistant",
          content: text,
          model: turn.model,
          provider: turn.provider,
          tool_calls: turn.toolCalls.size ? Array.from(turn.toolCalls.values()) : undefined,
          created_at: timestamp,
        });
        turns.set(turnId, turn);
      } else if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "tool_search_call") {
        const turnId = metadataTurnId(payload) ?? activeTurnId;
        const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
        const name = stringValue(payload.name) ?? stringValue(payload.execution) ?? itemType;
        if (!turnId || !callId || !name) continue;
        const turn = turns.get(turnId) ?? createTurn(turnId, activeModel);
        turn.toolCalls.set(callId, {
          id: callId,
          name,
          arguments: parseArguments(payload.arguments ?? payload.input),
        });
        turns.set(turnId, turn);
      } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output" || itemType === "tool_search_output") {
        const callId = stringValue(payload.call_id);
        if (!callId) continue;
        const turn = Array.from(turns.values()).find((candidate) => candidate.toolCalls.has(callId));
        if (!turn) continue;
        const call = turn.toolCalls.get(callId);
        if (call?.name === "spawn_agent") {
          for (const childId of childSessionIdsFromOutput(payload.output)) childSessionIds.add(childId);
        }
        const toolName = call?.name ?? "unknown";
        // 与 Cursor / Claude-compat 一致：跳过 Read/Write/Shell/Grep/Glob
        if (shouldSkipTool(toolName)) continue;
        turn.toolResults.push({
          type: "tool.result",
          session_id: input.session_id,
          agent: "codex",
          turn_id: turn.turnId,
          tool_name: toolName,
          call_id: callId,
          args: call?.arguments,
          output_text: outputText(payload.output)?.slice(0, 20_000),
          duration_ms: 0,
          created_at: timestamp,
        });
      }
      continue;
    }

    if (payloadType === "token_count") {
      const turnId = activeTurnId;
      if (!turnId) continue;
      const info = objectValue(payload.info);
      const totalUsage = usageSnapshot(info?.total_token_usage) ?? usageSnapshot(info?.last_token_usage);
      if (!totalUsage) continue;
      if (!lastSessionUsage) {
        const lastUsage = usageSnapshot(info?.last_token_usage);
        lastSessionUsage = lastUsage ? usageDelta(lastUsage, totalUsage) : zeroUsage();
      }
      const turn = turns.get(turnId) ?? createTurn(turnId, activeModel);
      addUsage(turn, usageDelta(lastSessionUsage, totalUsage));
      lastSessionUsage = totalUsage;
      turns.set(turnId, turn);
      continue;
    }

    if (payloadType === "task_complete") {
      const turnId = stringValue(payload.turn_id) ?? activeTurnId;
      if (!turnId) continue;
      const turn = turns.get(turnId) ?? createTurn(turnId, activeModel);
      const completedAt = numberValue(payload.completed_at);
      turn.completedAt = completedAt ? new Date(completedAt * 1000).toISOString() : timestamp;
      turn.durationMs = numberValue(payload.duration_ms) ?? 0;
      turns.set(turnId, turn);
    }
  }

  const events: IngestEvent[] = [];
  const sessionEvent = parentSessionId ? sessionStartFromStateDb(input.session_id, parentSessionId) : undefined;
  if (sessionEvent) events.push(sessionEvent);

  const selectedTurns = input.turn_id ? [turns.get(input.turn_id)].filter(Boolean) as TranscriptTurn[] : Array.from(turns.values());
  for (const turn of selectedTurns) {
    if (!turn.completedAt && turn.tokenUsage.total_tokens === 0 && turn.assistantMessages.length === 0 && turn.toolResults.length === 0) continue;
    events.push(...turn.assistantMessages);
    events.push(...turn.toolResults);
    if (turn.tokenUsage.total_tokens > 0) {
      events.push({
        type: "turn.completed",
        session_id: input.session_id,
        turn_id: turn.turnId,
        message_id: turn.finalMessageId,
        model: turn.model,
        provider: turn.provider,
        input_tokens: turn.tokenUsage.input_tokens,
        output_tokens: turn.tokenUsage.output_tokens,
        cache_read_tokens: turn.tokenUsage.cache_read_tokens,
        cache_write_tokens: turn.tokenUsage.cache_write_tokens,
        reasoning_tokens: turn.tokenUsage.reasoning_tokens,
        total_tokens: turn.tokenUsage.total_tokens,
        duration_ms: turn.durationMs ?? 0,
        finish_reason: "stop",
        created_at: turn.startedAt ?? turn.completedAt ?? new Date().toISOString(),
      });
    }
  }
  for (const childSessionId of childSessionIds) {
    events.push(...parseTranscriptEventsInternal({ ...input, session_id: childSessionId, transcript_path: undefined, turn_id: undefined }, input.session_id, visited));
  }
  return events;
}
