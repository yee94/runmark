import { isForkSessionTitle, isHiddenSessionTitle, shouldSkipTool } from "@agent-tracker/shared";
import type { IngestEvent, IngestMessageEvent } from "@agent-tracker/shared";
import { memoryAgentKey } from "./memory";

export type OpenCode2Event = {
  type: string;
  id?: string;
  created?: number;
  data?: Record<string, unknown>;
};

type ModelRef = { id?: string; providerID?: string };
type TokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

export type OpenCode2TrackerState = {
  userMessages: Map<string, IngestMessageEvent>;
  deliveredUsers: Set<string>;
  hidden: Set<string>;
  forkCutoffMs: Map<string, number>;
  pending: Map<string, { model: string; provider: string; startTime: number; messageID?: string; agentKey?: string }>;
  texts: Map<string, Map<number, string>>;
  tools: Map<string, { name: string; input?: Record<string, unknown> }>;
  completed: Set<string>;
};

export const createOpenCode2TrackerState = (): OpenCode2TrackerState => ({
  userMessages: new Map(),
  deliveredUsers: new Set(),
  hidden: new Set(),
  forkCutoffMs: new Map(),
  pending: new Map(),
  texts: new Map(),
  tools: new Map(),
  completed: new Set(),
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const dataOf = (event: OpenCode2Event): Record<string, unknown> => event.data ?? {};

const sessionIDOf = (event: OpenCode2Event): string | undefined => asString(dataOf(event).sessionID);

const modelOf = (value: unknown): ModelRef | undefined => {
  const model = asRecord(value);
  if (!model) return undefined;
  // OpenCode 2 事件里模型名是 id；旧 session 消息是 modelID。unknown 是采集失败的占位，不当模型
  return {
    id: recordedName(asString(model.id) ?? asString(model.modelID)),
    providerID: recordedName(asString(model.providerID)),
  };
};

const recordedName = (value: string | undefined): string | undefined =>
  value && value.toLowerCase() !== "unknown" ? value : undefined;

const tokensOf = (value: unknown): TokenUsage | undefined => {
  const tokens = asRecord(value);
  if (!tokens) return undefined;
  const cache = asRecord(tokens.cache);
  return {
    input: asNumber(tokens.input),
    output: asNumber(tokens.output),
    reasoning: asNumber(tokens.reasoning),
    cache: cache ? { read: asNumber(cache.read), write: asNumber(cache.write) } : undefined,
  };
};

const sumTokens = (tokens: TokenUsage | undefined): number =>
  (tokens?.input ?? 0) +
  (tokens?.output ?? 0) +
  (tokens?.reasoning ?? 0) +
  (tokens?.cache?.read ?? 0) +
  (tokens?.cache?.write ?? 0);

const rememberFork = (state: OpenCode2TrackerState, sessionID: string, title: string | undefined, created: number | undefined) => {
  if (!isForkSessionTitle(title) || state.forkCutoffMs.has(sessionID)) return;
  state.forkCutoffMs.set(sessionID, created ?? Date.now());
};

const joinedText = (state: OpenCode2TrackerState, messageID: string): string => {
  const parts = state.texts.get(messageID);
  if (!parts) return "";
  return [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text.trim())
    .filter(Boolean)
    .join("\n");
};

const toolOutput = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" ? asString(record.text) : undefined;
    })
    .filter((part): part is string => !!part)
    .join("\n")
    .trim();
  return text || undefined;
};

export const mapOpenCode2Event = (
  state: OpenCode2TrackerState,
  event: OpenCode2Event,
  options: { includeMessageContent: boolean; includeToolOutput: boolean; now?: number },
): IngestEvent[] => {
  const now = options.now ?? event.created ?? Date.now();
  const data = dataOf(event);
  const sessionID = sessionIDOf(event);
  if (!sessionID) return [];
  if (state.hidden.has(sessionID) && event.type !== "session.created" && event.type !== "session.renamed") return [];

  if (event.type === "session.created" || event.type === "session.renamed") {
    const title = asString(data.title);
    if (isHiddenSessionTitle(title)) {
      state.hidden.add(sessionID);
      return [];
    }
    rememberFork(state, sessionID, title, event.created);
  }
  if (state.hidden.has(sessionID)) return [];

  const createdAt = new Date(now).toISOString();
  const model = modelOf(data.model);

  if (event.type === "session.created") {
    const metadata: Record<string, unknown> = {};
    const agent = asString(data.agent);
    const parentID = asString(data.parentID);
    if (agent) metadata.opencode_agent = agent;
    if (parentID) metadata.is_subagent = true;
    if (isForkSessionTitle(asString(data.title))) metadata.is_fork = true;
    return [{
      type: "session.created",
      session_id: sessionID,
      agent: "opencode",
      title: asString(data.title),
      parent_session_id: parentID,
      model: model?.id,
      provider: model?.providerID,
      directory: asString(asRecord(data.location)?.directory),
      metadata: Object.keys(metadata).length ? metadata : undefined,
    }];
  }

  if (event.type === "session.renamed") {
    return [{ type: "session.updated", session_id: sessionID, agent: "opencode", title: asString(data.title) }];
  }

  if (event.type === "session.model.selected" && model?.id) {
    return [{ type: "session.updated", session_id: sessionID, agent: "opencode", model: model.id, provider: model.providerID }];
  }

  if (event.type === "session.usage.updated") {
    const tokens = tokensOf(data.tokens);
    return [{
      type: "session.updated",
      session_id: sessionID,
      agent: "opencode",
      session_cost_usd: asNumber(data.cost),
      session_input_tokens: tokens?.input,
      session_output_tokens: tokens?.output,
      session_total_tokens: sumTokens(tokens) || undefined,
      provider: model?.providerID,
      model: model?.id,
    }];
  }

  if (event.type === "session.inbox.enqueued" && options.includeMessageContent) {
    const item = asRecord(data.item);
    const payload = asRecord(item?.payload);
    const text = asString(payload?.text)?.trim();
    if (item?.type !== "user" || !text) return [];
    const message: IngestMessageEvent = {
      type: "message",
      session_id: sessionID,
      message_id: asString(data.inboxID) ?? asString(data.id) ?? `user-${now}`,
      role: "user",
      content: text,
      created_at: createdAt,
    };
    // 入队尚无实际执行 Agent；只在 delivered 后的 step.started 绑定本条来源，不能用会话当前 Agent 回填历史。
    state.userMessages.set(message.message_id!, message);
    return [];
  }

  if (event.type === "session.inbox.delivered") {
    const id = asString(data.inboxID);
    if (id && state.userMessages.has(id)) state.deliveredUsers.add(id);
    return [];
  }

  if (event.type === "session.inbox.cancelled") {
    const id = asString(data.inboxID);
    const message = id ? state.userMessages.get(id) : undefined;
    if (id) { state.userMessages.delete(id); state.deliveredUsers.delete(id); }
    return message ? [message] : [];
  }

  if (event.type === "session.text.ended") {
    const messageID = asString(data.assistantMessageID);
    const text = asString(data.text);
    if (!messageID || !text) return [];
    const parts = state.texts.get(messageID) ?? new Map<number, string>();
    parts.set(asNumber(data.ordinal) ?? parts.size, text);
    state.texts.set(messageID, parts);
    return [];
  }

  if (event.type === "session.step.started") {
    const previous = state.pending.get(sessionID);
    state.pending.set(sessionID, {
      model: model?.id ?? previous?.model ?? "",
      provider: model?.providerID ?? previous?.provider ?? "",
      startTime: event.created ?? now,
      messageID: asString(data.assistantMessageID),
      agentKey: memoryAgentKey(asString(data.agent)),
    });
    const messages: IngestEvent[] = [];
    for (const [id, message] of state.userMessages) {
      if (message.session_id !== sessionID || !state.deliveredUsers.has(id)) continue;
      messages.push({ ...message, agent_key: memoryAgentKey(asString(data.agent)) });
      state.userMessages.delete(id);
      state.deliveredUsers.delete(id);
    }
    return messages;
  }

  if (event.type === "session.tool.called") {
    const callID = asString(data.id);
    const name = asString(data.name);
    if (!callID || !name) return [];
    const input = asRecord(data.input);
    state.tools.set(callID, { name, input });
    return [];
  }

  if (event.type === "session.tool.success" && options.includeToolOutput) {
    const callID = asString(data.id);
    if (!callID) return [];
    const cached = callID ? state.tools.get(callID) : undefined;
    const name = cached?.name ?? asString(data.name) ?? "tool";
    if (shouldSkipTool(name)) return [];
    return [{
      type: "tool.result",
      session_id: sessionID,
      agent: "opencode",
      tool_name: name,
      call_id: callID,
      args: cached?.input,
      output_metadata: asRecord(data.metadata),
      output_text: toolOutput(data.content),
      duration_ms: 0,
      created_at: createdAt,
    }];
  }

  if (event.type === "session.step.ended") {
    const messageID = asString(data.assistantMessageID);
    const finish = asString(data.finish);
    if (!messageID || state.completed.has(messageID)) return [];
    const cutoff = state.forkCutoffMs.get(sessionID);
    if (cutoff != null && (event.created ?? now) < cutoff) return [];
    const pending = state.pending.get(sessionID);
    const tokens = tokensOf(data.tokens);
    state.completed.add(messageID);
    state.pending.delete(sessionID);
    const events: IngestEvent[] = [{
      type: "turn.completed",
      session_id: sessionID,
      turn_id: messageID,
      message_id: messageID,
      model: recordedName(pending?.model) ?? model?.id ?? "unknown",
      provider: recordedName(pending?.provider) ?? model?.providerID ?? "unknown",
      input_tokens: tokens?.input ?? 0,
      output_tokens: tokens?.output ?? 0,
      cache_read_tokens: tokens?.cache?.read,
      cache_write_tokens: tokens?.cache?.write,
      reasoning_tokens: tokens?.reasoning,
      total_tokens: sumTokens(tokens),
      duration_ms: pending ? now - pending.startTime : 0,
      cost_usd: asNumber(data.cost),
      finish_reason: finish,
      created_at: createdAt,
    }];
    const content = joinedText(state, messageID);
    if (options.includeMessageContent && content) {
      events.push({
        type: "message",
        session_id: sessionID,
        message_id: messageID,
        role: "assistant",
        content,
        agent_key: pending?.agentKey,
        model: recordedName(pending?.model) ?? model?.id,
        provider: recordedName(pending?.provider) ?? model?.providerID,
        created_at: createdAt,
      });
      state.texts.delete(messageID);
    }
    return events;
  }

  if (event.type === "session.step.failed" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
    const pending = state.pending.get(sessionID);
    if (!pending) return [];
    const error = asRecord(data.error);
    const reason = asString(data.reason);
    const errorName = asString(error?.message) ?? reason ?? event.type;
    const aborted = reason === "user" || /abort|interrupt/i.test(errorName);
    state.pending.delete(sessionID);
    return [{
      type: "turn.error",
      session_id: sessionID,
      turn_id: pending.messageID ?? `turn-${sessionID}-${pending.startTime}`,
      model: recordedName(pending.model) ?? "unknown",
      provider: recordedName(pending.provider) ?? "unknown",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: now - pending.startTime,
      error: errorName,
      finish_reason: aborted ? "aborted" : errorName,
      created_at: createdAt,
    }];
  }

  if (event.type === "session.execution.succeeded") {
    return [{ type: "session.idle", session_id: sessionID, agent: "opencode", ended_at: createdAt }];
  }

  return [];
};
