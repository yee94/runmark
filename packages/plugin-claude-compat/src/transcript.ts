/**
 * Claude Code / CodeBuddy / WorkBuddy transcript 解析
 *
 * Hook stdin 不直接提供 token；Stop 时读取 transcript_path：
 * - CLI：JSONL（Claude type=user|assistant；CodeBuddy type=message）
 * - CodeBuddy IDE：history/index.json + 同目录 messages/*.json
 * 从 usage / extra 提取用量，并增量去重避免 Stop 重复触发重复上报。
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type {
  IngestEvent,
  IngestMessageEvent,
  IngestToolCallPayload,
  IngestToolResultEvent,
  IngestTurnEvent,
} from "@agent-tracker/shared";
import { shouldSkipTool } from "./constants";
import {
  inferProvider,
  isInterruptAssistantText,
  type ClaudeCompatAgent,
} from "./transform";

type JsonObject = Record<string, unknown>;

export interface ParseClaudeTranscriptOptions {
  session_id: string;
  agent: ClaudeCompatAgent;
  transcript_path: string;
  /** 测试可注入；默认 ~/.config/agent-tracker/claude-compat-state */
  stateDir?: string;
  /**
   * CodeBuddy IDE：Debounce 耗尽后的最后一次解析。
   * 仍无 usage/abort 时也放出已有 assistant 正文（可无 turn），避免永久丢回复。
   */
  flushHeldAssistants?: boolean;
}

interface TranscriptState {
  offset: number;
  pendingTools: Record<string, IngestToolCallPayload & { model?: string; created_at?: string }>;
  /** CodeBuddy IDE history：已处理的 message id */
  processedIds?: string[];
  /** 已上报 turn.completed 的 message / turn id（避免 Stop 早于 lastStep* 时永久丢 turn） */
  emittedTurnIds?: string[];
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultStateDir(): string {
  return join(homedir(), ".config", "agent-tracker", "claude-compat-state");
}

function stateKey(sessionId: string, transcriptPath: string): string {
  return createHash("sha1").update(`${sessionId}::${transcriptPath}`).digest("hex");
}

function loadState(statePath: string): TranscriptState {
  if (!existsSync(statePath)) return { offset: 0, pendingTools: {} };
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as TranscriptState;
    return {
      offset: typeof raw.offset === "number" ? raw.offset : 0,
      pendingTools: raw.pendingTools && typeof raw.pendingTools === "object" ? raw.pendingTools : {},
      processedIds: Array.isArray(raw.processedIds)
        ? raw.processedIds.filter((id): id is string => typeof id === "string")
        : [],
      emittedTurnIds: Array.isArray(raw.emittedTurnIds)
        ? raw.emittedTurnIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { offset: 0, pendingTools: {} };
  }
}

/** CodeBuddy IDE：用户 Abort 时 message.extra.isCancelled === true */
function isCancelledRecord(record: JsonObject): boolean {
  const extra = objectValue(parseMaybeJson(record.extra));
  return extra?.isCancelled === true;
}

/**
 * 是否为用户 Abort / 中断终态。
 * - CodeBuddy IDE：extra.isCancelled
 * - WorkBuddy / CLI：providerData.isPartialAborted、error.message、Interrupted 正文
 */
function isAbortedRecord(record: JsonObject): boolean {
  if (isCancelledRecord(record)) return true;
  const providerData = objectValue(record.providerData);
  if (providerData?.isPartialAborted === true) return true;
  const errObj = objectValue(providerData?.error);
  const errMsg =
    stringValue(errObj?.message) ??
    (typeof providerData?.error === "string" ? providerData.error : undefined);
  if (errMsg && /interrupted by user|aborted by user|user aborted/i.test(errMsg)) {
    return true;
  }
  const nestedMessage = objectValue(parseMaybeJson(record.message));
  const text = contentText(record.content ?? nestedMessage?.content);
  return isInterruptAssistantText(text);
}

/** 从 IDE / JSONL 记录构造 turn（成功 completed / Abort error 共用字段） */
function turnFromRecord(
  record: JsonObject,
  opts: ParseClaudeTranscriptOptions,
  messageId: string,
  usage: UsageSnapshot | null | undefined,
  options?: { aborted?: boolean; fallbackModel?: string },
): IngestTurnEvent {
  let model = recordModel(record);
  if (model === "unknown" && options?.fallbackModel && options.fallbackModel !== "unknown") {
    model = options.fallbackModel;
  }
  const provider = inferProvider(model);
  const extra = objectValue(parseMaybeJson(record.extra));
  const elapsed = numberValue(objectValue(extra?.statsSnapshot)?.elapsedMs) ?? 0;
  const aborted = options?.aborted === true;
  return {
    type: aborted ? "turn.error" : "turn.completed",
    session_id: opts.session_id,
    turn_id: messageId,
    message_id: messageId,
    model,
    provider: provider !== "unknown" ? provider : "unknown",
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_tokens,
    cache_write_tokens: usage?.cache_write_tokens,
    reasoning_tokens: usage?.reasoning_tokens,
    total_tokens: usage?.total_tokens ?? 0,
    duration_ms: elapsed,
    finish_reason: aborted ? "aborted" : "stop",
    error: aborted ? "aborted" : undefined,
    created_at: recordTimestamp(record),
  };
}

/** 用户 Abort → 与成功 Turn 同结构（message_id / usage），仅 type/finish_reason 不同 */
function turnErrorFromAbort(
  record: JsonObject,
  opts: ParseClaudeTranscriptOptions,
  messageId: string,
  fallbackModel?: string,
  usage?: UsageSnapshot | null,
): IngestTurnEvent {
  return turnFromRecord(
    record,
    opts,
    messageId,
    usage ?? usageFromRecord(record),
    { aborted: true, fallbackModel },
  );
}

/** 解析可能被二次 JSON.stringify 的字段（CodeBuddy IDE message/extra） */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function saveState(statePath: string, state: TranscriptState): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const text = content.trim();
    return text || undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const obj = objectValue(item);
    if (!obj) continue;
    const type = stringValue(obj.type);
    const text = stringValue(obj.text);
    if ((type === "text" || type === "input_text" || type === "output_text") && text) {
      parts.push(text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 20_000);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const obj = objectValue(item);
      const text = obj ? stringValue(obj.text) ?? stringValue(obj.content) : undefined;
      if (text) parts.push(text);
    }
    const joined = parts.join("\n").trim();
    return joined ? joined.slice(0, 20_000) : undefined;
  }
  const obj = objectValue(content);
  if (!obj) return undefined;
  try {
    return JSON.stringify(obj).slice(0, 20_000);
  } catch {
    return undefined;
  }
}

function extractToolUses(content: unknown): IngestToolCallPayload[] {
  if (!Array.isArray(content)) return [];
  const calls: IngestToolCallPayload[] = [];
  for (const item of content) {
    const obj = objectValue(item);
    if (!obj) continue;
    const type = stringValue(obj.type);
    // Claude: tool_use；CodeBuddy IDE: tool-call
    if (type !== "tool_use" && type !== "tool-call") continue;
    const id = stringValue(obj.id) ?? stringValue(obj.toolCallId);
    const name = stringValue(obj.name) ?? stringValue(obj.toolName);
    if (!id || !name) continue;
    const args = objectValue(obj.input) ?? objectValue(obj.args) ?? undefined;
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

function extractToolResults(
  content: unknown,
): Array<{ call_id: string; tool_name?: string; output_text?: string }> {
  if (!Array.isArray(content)) return [];
  const results: Array<{ call_id: string; tool_name?: string; output_text?: string }> = [];
  for (const item of content) {
    const obj = objectValue(item);
    if (!obj) continue;
    const type = stringValue(obj.type);
    // Claude: tool_result；CodeBuddy IDE: tool-result
    if (type !== "tool_result" && type !== "tool-result") continue;
    const callId =
      stringValue(obj.tool_use_id) ?? stringValue(obj.toolCallId) ?? stringValue(obj.id);
    if (!callId) continue;
    const toolName = stringValue(obj.toolName) ?? stringValue(obj.name);
    const output =
      toolResultText(obj.content) ??
      toolResultText(obj.result) ??
      toolResultText(objectValue(obj.result)?.result);
    results.push({ call_id: callId, tool_name: toolName, output_text: output });
  }
  return results;
}

interface UsageSnapshot {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

function normalizeUsage(usage: JsonObject | undefined): UsageSnapshot | undefined {
  if (!usage) return undefined;
  const input =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.prompt_tokens) ??
    0;
  const cacheRead =
    numberValue(usage.cache_read_input_tokens) ??
    numberValue(usage.cache_read_tokens) ??
    numberValue(usage.cached_tokens) ??
    0;
  const cacheWrite =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cache_write_tokens) ??
    numberValue(usage.prompt_cache_write_tokens) ??
    0;
  const output =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.completion_tokens) ??
    0;
  const reasoning =
    numberValue(usage.reasoning_tokens) ??
    numberValue(usage.reasoning_output_tokens) ??
    numberValue(usage.completion_thinking_tokens) ??
    0;
  // Anthropic：input_tokens 通常已是非缓存；若 input 明显大于 cache 合计则按含缓存口径拆分
  const nonCachedInput =
    input >= cacheRead + cacheWrite && cacheRead + cacheWrite > 0
      ? input - cacheRead - cacheWrite
      : input;
  const total =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    nonCachedInput + cacheRead + cacheWrite + output + reasoning;
  if (total <= 0 && nonCachedInput + cacheRead + cacheWrite + output + reasoning <= 0) {
    return undefined;
  }
  return {
    input_tokens: nonCachedInput,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: total,
  };
}

/** 从 Claude / CodeBuddy 记录中提取 usage（字段位置因产品而异） */
function usageFromRecord(record: JsonObject): UsageSnapshot | undefined {
  const nestedMessage = objectValue(parseMaybeJson(record.message));
  const providerData = objectValue(record.providerData);
  const extra = objectValue(parseMaybeJson(record.extra));
  // CodeBuddy IDE：token 在 extra.lastStep* / statsSnapshot
  const ideUsage =
    extra &&
    (numberValue(extra.lastStepInputTokens) != null ||
      numberValue(extra.lastStepOutputTokens) != null)
      ? {
          inputTokens: numberValue(extra.lastStepInputTokens) ?? 0,
          outputTokens: numberValue(extra.lastStepOutputTokens) ?? 0,
          cached_tokens: numberValue(extra.lastStepCachedInputTokens) ?? 0,
          cache_write_tokens: numberValue(objectValue(extra.statsSnapshot)?.cacheWriteTokens) ?? 0,
          reasoning_tokens: numberValue(objectValue(extra.statsSnapshot)?.thinkingTokens) ?? 0,
        }
      : undefined;
  return (
    normalizeUsage(objectValue(nestedMessage?.usage)) ??
    normalizeUsage(objectValue(record.usage)) ??
    normalizeUsage(objectValue(providerData?.usage)) ??
    normalizeUsage(objectValue(providerData?.rawUsage)) ??
    normalizeUsage(ideUsage)
  );
}

function recordTimestamp(record: JsonObject): string {
  const ts = record.timestamp ?? record.created_at ?? record.createdAt;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // CodeBuddy 使用毫秒时间戳
    return new Date(ts).toISOString();
  }
  if (typeof ts === "string" && ts.trim()) return ts;
  return new Date().toISOString();
}

function recordModel(record: JsonObject): string {
  const providerData = objectValue(record.providerData);
  const nestedMessage = objectValue(parseMaybeJson(record.message));
  const extra = objectValue(parseMaybeJson(record.extra));
  return (
    stringValue(record.model) ??
    stringValue(providerData?.model) ??
    stringValue(providerData?.requestModelId) ??
    stringValue(providerData?.requestModelName) ??
    stringValue(nestedMessage?.model) ??
    stringValue(extra?.modelId) ??
    stringValue(extra?.modelName) ??
    "unknown"
  );
}

/** 是否为 CodeBuddy IDE history/index.json（非 JSONL） */
function isCodeBuddyIdeIndex(path: string, raw: string): boolean {
  if (!path.endsWith("index.json")) return false;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const obj = JSON.parse(trimmed) as JsonObject;
    return Array.isArray(obj.messages) && Array.isArray(obj.requests);
  } catch {
    return false;
  }
}

/**
 * 把一条对话记录转成 IngestEvent（JSONL 行 / IDE message 文件共用）
 * @param ctx JSONL 增量解析上下文：沿用本轮 model，合并同轮 Abort 只报一次 turn.error
 */
function eventsFromDialogRecord(
  record: JsonObject,
  opts: ParseClaudeTranscriptOptions,
  pending: Record<string, IngestToolCallPayload & { model?: string; created_at?: string }>,
  ctx?: { lastModel?: string; lastUsage?: UsageSnapshot; abortEmitted?: boolean },
): IngestEvent[] {
  const events: IngestEvent[] = [];
  const timestamp = recordTimestamp(record);
  const recordType = stringValue(record.type);
  // Claude Code: type=user|assistant + message{role,content,usage}
  // CodeBuddy/WorkBuddy CLI: type=message + 顶层 role/content
  // CodeBuddy IDE: role + message 为 JSON 字符串；tool 角色承载 tool-result
  const nestedMessage = objectValue(parseMaybeJson(record.message));
  const content = record.content ?? nestedMessage?.content;
  const role =
    stringValue(record.role) ??
    stringValue(nestedMessage?.role) ??
    (recordType === "assistant" ? "assistant" : recordType === "user" ? "user" : undefined);
  if (!role) return events;
  // 跳过非对话记录（如 file-history-snapshot）
  if (
    recordType &&
    recordType !== "message" &&
    recordType !== "user" &&
    recordType !== "assistant" &&
    recordType !== "text"
  ) {
    return events;
  }

  if (role === "user") {
    // 新用户轮次：允许下一轮 Abort 再报 turn.error
    if (ctx) ctx.abortEmitted = false;
    for (const result of extractToolResults(content)) {
      const call = pending[result.call_id];
      const toolName = result.tool_name ?? call?.name ?? "unknown";
      // 与 Cursor 一致：跳过 Read/Write/Shell|Bash/Grep
      if (shouldSkipTool(toolName)) {
        delete pending[result.call_id];
        continue;
      }
      const tool: IngestToolResultEvent = {
        type: "tool.result",
        session_id: opts.session_id,
        agent: opts.agent,
        tool_name: toolName,
        call_id: result.call_id,
        args: call?.arguments,
        output_text: result.output_text,
        duration_ms: 0,
        created_at: timestamp,
      };
      events.push(tool);
      delete pending[result.call_id];
    }
    return events;
  }

  if (role === "assistant") {
    const model = recordModel(record);
    if (model !== "unknown" && ctx) ctx.lastModel = model;
    const provider = inferProvider(model);
    const text = contentText(content);
    const toolCalls = extractToolUses(content);
    const messageId =
      stringValue(record.id) ??
      stringValue(record.uuid) ??
      stringValue(nestedMessage?.id) ??
      `msg-${opts.session_id}-${timestamp}`;
    const aborted = isAbortedRecord(record);
    const interruptOnly = isInterruptAssistantText(text);

    // 真实正文才上报 message；「Interrupted by user」是中断标记，不当 assistant（会带出 model=unknown）
    if ((text && !interruptOnly) || toolCalls.length) {
      const msg: IngestMessageEvent = {
        type: "message",
        session_id: opts.session_id,
        message_id: messageId,
        role: "assistant",
        content: interruptOnly ? undefined : text,
        model: model !== "unknown" ? model : ctx?.lastModel,
        provider: provider !== "unknown" ? provider : undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        created_at: timestamp,
      };
      if (msg.model) {
        const p = inferProvider(msg.model);
        msg.provider = p !== "unknown" ? p : undefined;
      }
      events.push(msg);
    }

    for (const call of toolCalls) {
      pending[call.id] = { ...call, model, created_at: timestamp };
    }

    // Abort：与成功 Turn 同结构（message_id + usage），仅 finish_reason=aborted
    // 同轮 interrupt 标记行若已报过则跳过，避免双点 + unknown
    if (aborted) {
      if (!(interruptOnly && ctx?.abortEmitted)) {
        const usage = usageFromRecord(record) ?? ctx?.lastUsage ?? null;
        events.push(turnErrorFromAbort(record, opts, messageId, ctx?.lastModel, usage));
        if (ctx) ctx.abortEmitted = true;
      }
      return events;
    }

    const usage = usageFromRecord(record);
    if (usage && usage.total_tokens > 0) {
      if (ctx) ctx.lastUsage = usage;
      events.push(turnFromRecord(record, opts, messageId, usage));
    }
    return events;
  }

  if (role === "tool") {
    for (const result of extractToolResults(content)) {
      const call = pending[result.call_id];
      const toolName = result.tool_name ?? call?.name ?? "unknown";
      // 与 Cursor 一致：跳过 Read/Write/Shell|Bash/Grep 及 IDE 别名
      if (shouldSkipTool(toolName)) {
        delete pending[result.call_id];
        continue;
      }
      const tool: IngestToolResultEvent = {
        type: "tool.result",
        session_id: opts.session_id,
        agent: opts.agent,
        tool_name: toolName,
        call_id: result.call_id,
        args: call?.arguments,
        output_text: result.output_text,
        duration_ms: 0,
        created_at: timestamp,
      };
      events.push(tool);
      delete pending[result.call_id];
    }
    return events;
  }

  return events;
}

/** assistant 是否已具备可上报的终态（usage / Abort） */
function assistantHasTerminal(record: JsonObject): boolean {
  if (isAbortedRecord(record)) return true;
  const usage = usageFromRecord(record);
  return Boolean(usage && usage.total_tokens > 0);
}

/**
 * CodeBuddy IDE 专用：transcript_path = .../history/<project>/<session>/index.json
 * 同目录 messages/<id>.json 存完整对话；token 在 assistant.extra.lastStep*
 *
 * Debounce（仅本函数 / 仅 CodeBuddy IDE）：assistant 在 usage / isCancelled 落盘前
 * 不产出、不标记 processed；Claude / WorkBuddy JSONL 走下方 offset 路径，无此逻辑。
 */
function parseCodeBuddyIdeHistory(
  opts: ParseClaudeTranscriptOptions,
  indexRaw: string,
  statePath: string,
  state: TranscriptState,
): IngestEvent[] {
  let index: JsonObject;
  try {
    index = JSON.parse(indexRaw) as JsonObject;
  } catch {
    return [];
  }

  const metaList = Array.isArray(index.messages) ? index.messages : [];
  const processed = new Set(state.processedIds ?? []);
  const emittedTurns = new Set(state.emittedTurnIds ?? []);
  const pending = { ...state.pendingTools };
  const events: IngestEvent[] = [];
  const messagesDir = join(dirname(opts.transcript_path), "messages");

  // 仅「request 最后一条 assistant」可用聚合 usage 解封（避免中间 step 吃整段 usage）
  const requestUsageForLastAssistant = new Map<string, UsageSnapshot>();
  const requests = Array.isArray(index.requests) ? index.requests : [];
  for (const req of requests) {
    const reqObj = objectValue(req);
    if (!reqObj) continue;
    const usage = normalizeUsage(objectValue(reqObj.usage));
    if (!usage || usage.total_tokens <= 0) continue;
    const msgIds = Array.isArray(reqObj.messages)
      ? reqObj.messages.filter((x): x is string => typeof x === "string")
      : [];
    for (let i = msgIds.length - 1; i >= 0; i--) {
      const mid = msgIds[i];
      if (!mid) continue;
      const fp = join(messagesDir, `${mid}.json`);
      if (!existsSync(fp)) continue;
      try {
        const rec = JSON.parse(readFileSync(fp, "utf-8")) as JsonObject;
        if (stringValue(rec.role) === "assistant") {
          requestUsageForLastAssistant.set(mid, usage);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  for (const meta of metaList) {
    const metaObj = objectValue(meta);
    const id = metaObj ? stringValue(metaObj.id) : typeof meta === "string" ? meta : undefined;
    if (!id) continue;

    const filePath = join(messagesDir, `${id}.json`);
    if (!existsSync(filePath)) {
      // 文件尚未落盘：按住后续，等下次 Stop / late-usage 重试
      break;
    }

    let record: JsonObject;
    try {
      record = JSON.parse(readFileSync(filePath, "utf-8")) as JsonObject;
    } catch {
      continue;
    }
    if (!stringValue(record.id)) record.id = id;

    const role = stringValue(record.role);
    const requestUsage = requestUsageForLastAssistant.get(id);

    if (!processed.has(id)) {
      // Debounce：无终态的「回复 / Abort 候选」按住；中间 tool-call step 可先放行（无 turn）
      // flushHeldAssistants：耗尽等待后仍放出正文，避免短会话永久丢 assistant
      if (
        role === "assistant" &&
        !assistantHasTerminal(record) &&
        !requestUsage &&
        !opts.flushHeldAssistants
      ) {
        const nested = objectValue(parseMaybeJson(record.message));
        const content = record.content ?? nested?.content;
        const toolCalls = extractToolUses(content);
        if (toolCalls.length === 0) {
          break;
        }
      }

      const produced = eventsFromDialogRecord(record, opts, pending);
      // 无 lastStep 但作为 request 末条且聚合 usage 已到：与 message 同批补 turn
      if (
        role === "assistant" &&
        requestUsage &&
        !produced.some((ev) => ev.type === "turn.completed" || ev.type === "turn.error")
      ) {
        const model = recordModel(record);
        const provider = inferProvider(model);
        produced.push({
          type: "turn.completed",
          session_id: opts.session_id,
          turn_id: id,
          message_id: id,
          model,
          provider: provider !== "unknown" ? provider : "unknown",
          input_tokens: requestUsage.input_tokens,
          output_tokens: requestUsage.output_tokens,
          cache_read_tokens: requestUsage.cache_read_tokens,
          cache_write_tokens: requestUsage.cache_write_tokens,
          reasoning_tokens: requestUsage.reasoning_tokens,
          total_tokens: requestUsage.total_tokens,
          duration_ms: 0,
          finish_reason: "stop",
          created_at: recordTimestamp(record),
        });
      }

      events.push(...produced);
      for (const ev of produced) {
        if (ev.type === "turn.completed" || ev.type === "turn.error") {
          emittedTurns.add(ev.turn_id);
        }
      }
      processed.add(id);
      continue;
    }

    // 旧 state：message 已 processed 但 turn 未出 → 迟到补 turn（兼容）
    if (role === "assistant" && !emittedTurns.has(id)) {
      if (isAbortedRecord(record)) {
        events.push(turnErrorFromAbort(record, opts, id));
        emittedTurns.add(id);
        continue;
      }
      const usage = usageFromRecord(record) ?? requestUsage;
      if (usage && usage.total_tokens > 0) {
        events.push(turnFromRecord(record, opts, id, usage));
        emittedTurns.add(id);
      }
    }
  }

  // requests[].usage 兜底：仅补「已 processed 但仍无 turn」的最后一条 assistant
  for (const req of requests) {
    const reqObj = objectValue(req);
    if (!reqObj) continue;
    const usage = normalizeUsage(objectValue(reqObj.usage));
    if (!usage || usage.total_tokens <= 0) continue;
    const msgIds = Array.isArray(reqObj.messages)
      ? reqObj.messages.filter((x): x is string => typeof x === "string")
      : [];
    let lastAssistantId: string | undefined;
    for (let i = msgIds.length - 1; i >= 0; i--) {
      const mid = msgIds[i];
      if (!mid) continue;
      const fp = join(messagesDir, `${mid}.json`);
      if (!existsSync(fp)) continue;
      try {
        const rec = JSON.parse(readFileSync(fp, "utf-8")) as JsonObject;
        if (stringValue(rec.role) === "assistant") {
          lastAssistantId = mid;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!lastAssistantId || !processed.has(lastAssistantId) || emittedTurns.has(lastAssistantId)) {
      continue;
    }
    const filePath = join(messagesDir, `${lastAssistantId}.json`);
    let record: JsonObject = {};
    try {
      record = JSON.parse(readFileSync(filePath, "utf-8")) as JsonObject;
    } catch {
      /* ignore */
    }
    if (usageFromRecord(record)) continue;
    if (!stringValue(record.id)) record.id = lastAssistantId;
    const model = recordModel(record);
    const provider = inferProvider(model);
    events.push({
      type: "turn.completed",
      session_id: opts.session_id,
      turn_id: lastAssistantId,
      message_id: lastAssistantId,
      model,
      provider: provider !== "unknown" ? provider : "unknown",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      total_tokens: usage.total_tokens,
      duration_ms: 0,
      finish_reason: "stop",
      created_at: recordTimestamp(record),
    });
    emittedTurns.add(lastAssistantId);
  }

  state.offset = indexRaw.length;
  state.pendingTools = pending;
  state.processedIds = [...processed];
  state.emittedTurnIds = [...emittedTurns];
  saveState(statePath, state);
  return events;
}

/**
 * 解析 Claude 兼容 transcript，仅返回自上次 offset / processedIds 之后的新事件
 */
export function parseClaudeTranscriptEvents(
  opts: ParseClaudeTranscriptOptions,
): IngestEvent[] {
  const path = opts.transcript_path;
  if (!path || !existsSync(path)) return [];

  const dir = opts.stateDir ?? defaultStateDir();
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, `${stateKey(opts.session_id, path)}.json`);
  const state = loadState(statePath);

  const raw = readFileSync(path, "utf-8");
  // CodeBuddy IDE：index.json + messages/*.json
  if (isCodeBuddyIdeIndex(path, raw)) {
    return parseCodeBuddyIdeHistory(opts, raw, statePath, state);
  }

  if (raw.length < state.offset) {
    state.offset = 0;
    state.pendingTools = {};
  }

  const chunk = raw.slice(state.offset);
  const events: IngestEvent[] = [];
  const pending = { ...state.pendingTools };
  // JSONL 同轮 Abort：沿用真实 model / usage，interrupt 标记行不重复 turn.error
  const ctx: { lastModel?: string; lastUsage?: UsageSnapshot; abortEmitted?: boolean } = {};

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let record: JsonObject;
    try {
      record = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }
    events.push(...eventsFromDialogRecord(record, opts, pending, ctx));
  }

  state.offset = raw.length;
  state.pendingTools = pending;
  saveState(statePath, state);
  return events;
}
