/**
 * Grok 本地 session 目录解析与 transcript 补齐
 *
 * Stop 时读取 ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/：
 * - summary.json：title / model / git
 * - chat_history.jsonl：user / assistant / tool_calls
 * - updates.jsonl：usage（inputTokens / outputTokens / cachedReadTokens / reasoningTokens / costUsdTicks）
 * - events.jsonl：turn_started / tool_completed 等兜底
 *
 * 使用 offset 状态避免同一 session 多次 Stop 重复上报。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  shouldSkipTool,
  type IngestEvent,
  type IngestMessageEvent,
  type IngestSessionEvent,
  type IngestToolCallPayload,
  type IngestToolResultEvent,
  type IngestTurnEvent,
} from "@agent-tracker/shared";
import {
  GROK_AGENT,
  inferProvider,
  resolveCwd,
  resolveModel,
  resolveSessionId,
  type GrokHookInput,
} from "./transform";

type JsonObject = Record<string, unknown>;

interface SessionState {
  chatOffset: number;
  updatesOffset: number;
  eventsOffset: number;
  emittedTurnKeys: string[];
  emittedMessageIds: string[];
  emittedToolIds: string[];
}

interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  costUsdTicks?: number;
  modelId?: string;
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

function defaultGrokHome(): string {
  return process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

function defaultStateDir(): string {
  return join(homedir(), ".config", "agent-tracker", "grok-state");
}

function stateKey(sessionId: string, sessionDir: string): string {
  return createHash("sha1").update(`${sessionId}::${sessionDir}`).digest("hex");
}

function loadState(statePath: string): SessionState {
  if (!existsSync(statePath)) {
    return {
      chatOffset: 0,
      updatesOffset: 0,
      eventsOffset: 0,
      emittedTurnKeys: [],
      emittedMessageIds: [],
      emittedToolIds: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<SessionState>;
    return {
      chatOffset: typeof raw.chatOffset === "number" ? raw.chatOffset : 0,
      updatesOffset: typeof raw.updatesOffset === "number" ? raw.updatesOffset : 0,
      eventsOffset: typeof raw.eventsOffset === "number" ? raw.eventsOffset : 0,
      emittedTurnKeys: Array.isArray(raw.emittedTurnKeys)
        ? raw.emittedTurnKeys.filter((x): x is string => typeof x === "string")
        : [],
      emittedMessageIds: Array.isArray(raw.emittedMessageIds)
        ? raw.emittedMessageIds.filter((x): x is string => typeof x === "string")
        : [],
      emittedToolIds: Array.isArray(raw.emittedToolIds)
        ? raw.emittedToolIds.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return {
      chatOffset: 0,
      updatesOffset: 0,
      eventsOffset: 0,
      emittedTurnKeys: [],
      emittedMessageIds: [],
      emittedToolIds: [],
    };
  }
}

function saveState(statePath: string, state: SessionState): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

function encodeSessionPathSegment(cwd: string): string {
  // Grok 将 cwd 编码为 %2F 形式目录名（保留 / 编码）
  return encodeURIComponent(cwd).replace(/%2F/gi, "%2F");
}

/**
 * 解析 Grok session 目录：~/.grok/sessions/<encoded-cwd>/<sessionId>
 */
export function resolveGrokSessionDir(
  input: GrokHookInput,
  opts?: { grokHome?: string },
): string | undefined {
  const sessionId = resolveSessionId(input);
  if (!sessionId) return undefined;

  const grokHome = opts?.grokHome ?? defaultGrokHome();
  const sessionsRoot = join(grokHome, "sessions");
  if (!existsSync(sessionsRoot)) return undefined;

  const cwd = resolveCwd(input);
  if (cwd) {
    const candidates = [
      join(sessionsRoot, encodeSessionPathSegment(cwd), sessionId),
      join(sessionsRoot, encodeURIComponent(cwd), sessionId),
    ];
    for (const dir of candidates) {
      if (existsSync(dir)) return dir;
    }
  }

  // 兜底：扫描 sessions 下所有项目目录
  try {
    for (const project of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, project, sessionId);
      if (existsSync(dir)) return dir;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export interface GrokSessionSummary {
  title?: string;
  model?: string;
  repoUrl?: string;
  branch?: string;
  directory?: string;
  agentName?: string;
  reasoningEffort?: string;
}

export function readGrokSummary(sessionDir: string): GrokSessionSummary {
  const path = join(sessionDir, "summary.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
    const info = objectValue(raw.info);
    const remotes = Array.isArray(raw.git_remotes) ? raw.git_remotes : [];
    const repoUrl = remotes.find((x): x is string => typeof x === "string");
    return {
      title:
        stringValue(raw.generated_title)
        ?? stringValue(raw.session_summary)
        ?? undefined,
      model: stringValue(raw.current_model_id) ?? undefined,
      repoUrl,
      branch: stringValue(raw.head_branch) ?? undefined,
      directory: stringValue(info?.cwd) ?? stringValue(raw.git_root_dir) ?? undefined,
      agentName: stringValue(raw.agent_name) ?? undefined,
      reasoningEffort: stringValue(raw.reasoning_effort) ?? undefined,
    };
  } catch {
    return {};
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const obj = objectValue(item);
    if (!obj) continue;
    const type = stringValue(obj.type);
    if (type === "text" || type === "output_text" || type === "input_text") {
      const text = stringValue(obj.text);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (match?.[1]) return match[1].trim();
  return text.trim();
}

function isSyntheticUser(record: JsonObject): boolean {
  if (record.synthetic_reason) return true;
  const text = contentText(record.content);
  if (!text) return true;
  if (text.includes("<system-reminder>") && !text.includes("<user_query>")) return true;
  if (text.includes("<user_info>") && !text.includes("<user_query>")) return true;
  if (text.includes("<git_status>") && !text.includes("<user_query>")) return true;
  return false;
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw };
  } catch {
    return { raw };
  }
}

function usageFromObject(obj: JsonObject | undefined): UsageSnapshot | undefined {
  if (!obj) return undefined;
  const inputTokens =
    numberValue(obj.inputTokens)
    ?? numberValue(obj.input_tokens)
    ?? 0;
  const outputTokens =
    numberValue(obj.outputTokens)
    ?? numberValue(obj.output_tokens)
    ?? 0;
  const totalTokens =
    numberValue(obj.totalTokens)
    ?? numberValue(obj.total_tokens)
    ?? inputTokens + outputTokens;
  const cachedReadTokens =
    numberValue(obj.cachedReadTokens)
    ?? numberValue(obj.cached_read_tokens)
    ?? numberValue(obj.cache_read_tokens)
    ?? 0;
  const reasoningTokens =
    numberValue(obj.reasoningTokens)
    ?? numberValue(obj.reasoning_tokens)
    ?? 0;
  const costUsdTicks = numberValue(obj.costUsdTicks) ?? numberValue(obj.cost_usd_ticks);
  // 拒绝仅含 totalTokens 的上下文快照（_meta.totalTokens 会污染 turn cost）
  const hasBillable =
    inputTokens > 0
    || outputTokens > 0
    || cachedReadTokens > 0
    || reasoningTokens > 0
    || (typeof costUsdTicks === "number" && costUsdTicks > 0);
  if (!hasBillable) return undefined;
  const modelUsage = objectValue(obj.modelUsage);
  let modelId: string | undefined;
  if (modelUsage) {
    modelId = Object.keys(modelUsage)[0];
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens,
    reasoningTokens,
    costUsdTicks,
    modelId,
  };
}

/**
 * costUsdTicks 是 1e9 刻度（观测：1801068000 ticks ≈ $1.80）
 */
export function ticksToUsd(ticks?: number): number | undefined {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks <= 0) return undefined;
  return ticks / 1_000_000_000;
}

interface TurnUsageRecord {
  usage: UsageSnapshot;
  /** Grok turn_completed 的 prompt_id，用作稳定 turn_id */
  promptId?: string;
  eventId?: string;
}

/**
 * 只认权威 turn usage：
 * - sessionUpdate === "turn_completed" 且带 update.usage（Grok 每轮独立用量，非会话累计）
 * - 或显式 usage 且含 costUsdTicks / input+output（兼容旧格式）
 * 禁止扫 _meta.totalTokens：那是上下文体积，不是计费 token。
 */
function extractTurnUsageFromUpdateLine(line: string): TurnUsageRecord | undefined {
  try {
    const record = JSON.parse(line) as JsonObject;
    const params = objectValue(record.params);
    const update = objectValue(params?.update);
    if (!update) return undefined;

    const sessionUpdate = stringValue(update.sessionUpdate) ?? stringValue(update.session_update);
    const usageObj =
      objectValue(update.usage)
      ?? objectValue(record.usage);
    const usage = usageFromObject(usageObj);
    if (!usage) return undefined;

    // turn_completed 是主路径；其它 update 仅当带原生 cost 时才采信
    const isTurnCompleted =
      sessionUpdate === "turn_completed"
      || sessionUpdate === "turnCompleted"
      || sessionUpdate === "agent_turn_complete";
    const hasNativeCost = typeof usage.costUsdTicks === "number" && usage.costUsdTicks > 0;
    if (!isTurnCompleted && !hasNativeCost) return undefined;

    const promptId =
      stringValue(update.prompt_id)
      ?? stringValue(update.promptId)
      ?? stringValue(params?.prompt_id);
    const eventId =
      stringValue(objectValue(record._meta)?.eventId)
      ?? stringValue(objectValue(params?._meta)?.eventId)
      ?? stringValue(objectValue(update._meta)?.eventId);

    return { usage, promptId, eventId };
  } catch {
    // ignore
  }
  return undefined;
}

function turnKeyOf(rec: TurnUsageRecord): string {
  if (rec.promptId) return `prompt:${rec.promptId}`;
  if (rec.eventId) return `event:${rec.eventId}`;
  const u = rec.usage;
  return `usage:${u.totalTokens}:${u.inputTokens}:${u.outputTokens}:${u.cachedReadTokens}:${u.costUsdTicks ?? 0}`;
}

function stableTurnId(sessionId: string, rec: TurnUsageRecord, index: number): string {
  if (rec.promptId) return `grok-turn-${sessionId}-${rec.promptId}`;
  if (rec.eventId) return `grok-turn-${sessionId}-${rec.eventId.slice(-24)}`;
  return `grok-turn-${sessionId}-${index}-${turnKeyOf(rec).slice(0, 48)}`;
}

export interface ParseGrokSessionOptions {
  input: GrokHookInput;
  includeMessages?: boolean;
  includeToolOutput?: boolean;
  /** 测试可注入 */
  grokHome?: string;
  stateDir?: string;
  sessionDir?: string;
}

/**
 * 从本地 Grok session 文件解析增量 IngestEvent
 */
export function parseGrokSessionEvents(opts: ParseGrokSessionOptions): IngestEvent[] {
  const sessionId = resolveSessionId(opts.input);
  if (!sessionId) return [];

  const sessionDir = opts.sessionDir ?? resolveGrokSessionDir(opts.input, { grokHome: opts.grokHome });
  if (!sessionDir || !existsSync(sessionDir)) return [];

  const stateDir = opts.stateDir ?? defaultStateDir();
  const statePath = join(stateDir, `${stateKey(sessionId, sessionDir)}.json`);
  const state = loadState(statePath);
  const includeMessages = opts.includeMessages !== false;
  const includeToolOutput = opts.includeToolOutput !== false;

  const summary = readGrokSummary(sessionDir);
  const fallbackModel = resolveModel(opts.input) ?? summary.model ?? "grok-4.5";
  const events: IngestEvent[] = [];

  // session.updated 元信息（title / model / git）
  if (summary.title || summary.model || summary.repoUrl) {
    const updated: IngestSessionEvent = {
      type: "session.updated",
      session_id: sessionId,
      agent: GROK_AGENT,
      title: summary.title,
      model: summary.model ?? fallbackModel,
      provider: inferProvider(summary.model ?? fallbackModel),
      repo_url: summary.repoUrl,
      branch: summary.branch,
      directory: summary.directory,
      metadata: {
        agent_name: summary.agentName,
        reasoning_effort: summary.reasoningEffort,
      },
    };
    events.push(updated);
  }

  // ---- chat_history.jsonl ----
  const chatPath = join(sessionDir, "chat_history.jsonl");
  if (existsSync(chatPath) && includeMessages) {
    const raw = readFileSync(chatPath, "utf-8");
    if (raw.length < state.chatOffset) state.chatOffset = 0;
    const chunk = raw.slice(state.chatOffset);
    let assistantIdx = 0;
    let userIdx = 0;

    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let record: JsonObject;
      try {
        record = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      const type = stringValue(record.type);
      if (type === "user") {
        if (isSyntheticUser(record)) continue;
        const text = extractUserQuery(contentText(record.content));
        if (!text) continue;
        const messageId = `grok-user-${sessionId}-${userIdx++}-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
        if (state.emittedMessageIds.includes(messageId)) continue;
        state.emittedMessageIds.push(messageId);
        const msg: IngestMessageEvent = {
          type: "message",
          session_id: sessionId,
          message_id: messageId,
          role: "user",
          content: text.slice(0, 20_000),
          model: fallbackModel,
          provider: inferProvider(fallbackModel),
          created_at: new Date().toISOString(),
        };
        events.push(msg);
      } else if (type === "assistant") {
        const model = stringValue(record.model_id) ?? fallbackModel;
        const text = contentText(record.content);
        const toolCallsRaw = Array.isArray(record.tool_calls) ? record.tool_calls : [];
        const toolCalls: IngestToolCallPayload[] = [];
        for (const tc of toolCallsRaw) {
          const obj = objectValue(tc);
          if (!obj) continue;
          const id = stringValue(obj.id) ?? `call-${assistantIdx}-${toolCalls.length}`;
          const name = stringValue(obj.name) ?? "unknown";
          toolCalls.push({
            id,
            name,
            arguments: parseArgs(obj.arguments ?? obj.input),
          });
        }
        if (!text.trim() && toolCalls.length === 0) continue;
        const messageId =
          stringValue(record.id)
          ?? `grok-assistant-${sessionId}-${assistantIdx}`;
        assistantIdx += 1;
        if (state.emittedMessageIds.includes(messageId)) continue;
        state.emittedMessageIds.push(messageId);
        const msg: IngestMessageEvent = {
          type: "message",
          session_id: sessionId,
          message_id: messageId,
          role: "assistant",
          content: text ? text.slice(0, 20_000) : undefined,
          model,
          provider: inferProvider(model),
          tool_calls: toolCalls.length ? toolCalls : undefined,
          created_at: new Date().toISOString(),
        };
        events.push(msg);

        // tool.result 从 tool_calls 派生（输出可能在 updates 中，此处至少记调用）
        if (includeToolOutput) {
          for (const call of toolCalls) {
            if (shouldSkipTool(call.name)) continue;
            if (state.emittedToolIds.includes(call.id)) continue;
            state.emittedToolIds.push(call.id);
            const toolEv: IngestToolResultEvent = {
              type: "tool.result",
              session_id: sessionId,
              agent: GROK_AGENT,
              turn_id: messageId,
              tool_name: call.name,
              call_id: call.id,
              args: call.arguments,
              duration_ms: 0,
              created_at: new Date().toISOString(),
            };
            events.push(toolEv);
          }
        }
      }
    }
    state.chatOffset = raw.length;
  }

  // ---- updates.jsonl：turn_completed.usage → 每轮独立 turn.completed（含原生 cost）----
  const updatesPath = join(sessionDir, "updates.jsonl");
  if (existsSync(updatesPath)) {
    const raw = readFileSync(updatesPath, "utf-8");
    if (raw.length < state.updatesOffset) state.updatesOffset = 0;
    // 增量：只解析 offset 之后的新行；每条 turn_completed 即一轮（非累计）
    const chunk = raw.slice(state.updatesOffset);
    let turnIndex = state.emittedTurnKeys.length;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      const rec = extractTurnUsageFromUpdateLine(line);
      if (!rec) continue;
      const key = turnKeyOf(rec);
      if (state.emittedTurnKeys.includes(key)) continue;
      state.emittedTurnKeys.push(key);
      turnIndex += 1;

      const u = rec.usage;
      const model = u.modelId ?? fallbackModel;
      const nonCacheInput = Math.max(u.inputTokens - u.cachedReadTokens, 0);
      const costUsd = ticksToUsd(u.costUsdTicks);
      const turn: IngestTurnEvent = {
        type: "turn.completed",
        session_id: sessionId,
        turn_id: stableTurnId(sessionId, rec, turnIndex),
        model,
        provider: inferProvider(model),
        input_tokens: nonCacheInput,
        output_tokens: u.outputTokens,
        cache_read_tokens: u.cachedReadTokens,
        cache_write_tokens: 0,
        reasoning_tokens: u.reasoningTokens,
        total_tokens:
          u.totalTokens
          || nonCacheInput + u.outputTokens + u.cachedReadTokens + u.reasoningTokens,
        cost_usd: costUsd,
        duration_ms: 0,
        finish_reason: "stop",
        created_at: new Date().toISOString(),
      };
      events.push(turn);
    }
    state.updatesOffset = raw.length;
  }

  // ---- events.jsonl：tool_completed 时长补齐（可选）----
  const eventsPath = join(sessionDir, "events.jsonl");
  if (existsSync(eventsPath) && includeToolOutput) {
    const raw = readFileSync(eventsPath, "utf-8");
    if (raw.length < state.eventsOffset) state.eventsOffset = 0;
    const chunk = raw.slice(state.eventsOffset);
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let record: JsonObject;
      try {
        record = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      if (stringValue(record.type) !== "tool_completed") continue;
      const toolName = stringValue(record.tool_name) ?? "unknown";
      if (shouldSkipTool(toolName)) continue;
      const callId =
        stringValue(record.tool_call_id)
        ?? stringValue(record.call_id)
        ?? `evt-tool-${createHash("sha1").update(line).digest("hex").slice(0, 10)}`;
      if (state.emittedToolIds.includes(callId)) continue;
      state.emittedToolIds.push(callId);
      const duration = numberValue(record.duration_ms) ?? 0;
      const outcome = stringValue(record.outcome);
      events.push({
        type: "tool.result",
        session_id: sessionId,
        agent: GROK_AGENT,
        tool_name: toolName,
        call_id: callId,
        duration_ms: duration,
        error: outcome && outcome !== "success" ? outcome : undefined,
        created_at: stringValue(record.ts) ?? new Date().toISOString(),
      });
    }
    state.eventsOffset = raw.length;
  }

  // 限制 state 数组膨胀
  if (state.emittedMessageIds.length > 500) {
    state.emittedMessageIds = state.emittedMessageIds.slice(-300);
  }
  if (state.emittedToolIds.length > 500) {
    state.emittedToolIds = state.emittedToolIds.slice(-300);
  }
  if (state.emittedTurnKeys.length > 100) {
    state.emittedTurnKeys = state.emittedTurnKeys.slice(-50);
  }

  saveState(statePath, state);
  return events;
}
