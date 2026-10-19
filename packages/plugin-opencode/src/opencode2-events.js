import { isForkSessionTitle, isHiddenSessionTitle, shouldSkipTool } from "@agent-tracker/shared";
export const createOpenCode2TrackerState = () => ({
    hidden: new Set(),
    forkCutoffMs: new Map(),
    pending: new Map(),
    texts: new Map(),
    tools: new Map(),
    completed: new Set(),
});
const asRecord = (value) => value && typeof value === "object" ? value : undefined;
const asString = (value) => (typeof value === "string" && value ? value : undefined);
const asNumber = (value) => (typeof value === "number" ? value : undefined);
const dataOf = (event) => event.data ?? {};
const sessionIDOf = (event) => asString(dataOf(event).sessionID);
const modelOf = (value) => {
    const model = asRecord(value);
    if (!model)
        return undefined;
    return { id: asString(model.id), providerID: asString(model.providerID) };
};
const tokensOf = (value) => {
    const tokens = asRecord(value);
    if (!tokens)
        return undefined;
    const cache = asRecord(tokens.cache);
    return {
        input: asNumber(tokens.input),
        output: asNumber(tokens.output),
        reasoning: asNumber(tokens.reasoning),
        cache: cache ? { read: asNumber(cache.read), write: asNumber(cache.write) } : undefined,
    };
};
const sumTokens = (tokens) => (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0);
const rememberFork = (state, sessionID, title, created) => {
    if (!isForkSessionTitle(title) || state.forkCutoffMs.has(sessionID))
        return;
    state.forkCutoffMs.set(sessionID, created ?? Date.now());
};
const joinedText = (state, messageID) => {
    const parts = state.texts.get(messageID);
    if (!parts)
        return "";
    return [...parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text.trim())
        .filter(Boolean)
        .join("\n");
};
const toolOutput = (content) => {
    if (!Array.isArray(content))
        return undefined;
    const text = content
        .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" ? asString(record.text) : undefined;
    })
        .filter((part) => !!part)
        .join("\n")
        .trim();
    return text || undefined;
};
export const mapOpenCode2Event = (state, event, options) => {
    const now = options.now ?? event.created ?? Date.now();
    const data = dataOf(event);
    const sessionID = sessionIDOf(event);
    if (!sessionID)
        return [];
    if (state.hidden.has(sessionID) && event.type !== "session.created" && event.type !== "session.renamed")
        return [];
    if (event.type === "session.created" || event.type === "session.renamed") {
        const title = asString(data.title);
        if (isHiddenSessionTitle(title)) {
            state.hidden.add(sessionID);
            return [];
        }
        rememberFork(state, sessionID, title, event.created);
    }
    if (state.hidden.has(sessionID))
        return [];
    const createdAt = new Date(now).toISOString();
    const model = modelOf(data.model);
    if (event.type === "session.created") {
        const metadata = {};
        const agent = asString(data.agent);
        const parentID = asString(data.parentID);
        if (agent)
            metadata.opencode_agent = agent;
        if (parentID)
            metadata.is_subagent = true;
        if (isForkSessionTitle(asString(data.title)))
            metadata.is_fork = true;
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
        if (item?.type !== "user" || !text)
            return [];
        return [{
                type: "message",
                session_id: sessionID,
                message_id: asString(data.inboxID) ?? asString(data.id) ?? `user-${now}`,
                role: "user",
                content: text,
                created_at: createdAt,
            }];
    }
    if (event.type === "session.text.ended") {
        const messageID = asString(data.assistantMessageID);
        const text = asString(data.text);
        if (!messageID || !text)
            return [];
        const parts = state.texts.get(messageID) ?? new Map();
        parts.set(asNumber(data.ordinal) ?? parts.size, text);
        state.texts.set(messageID, parts);
        return [];
    }
    if (event.type === "session.step.started") {
        state.pending.set(sessionID, {
            model: model?.id ?? state.pending.get(sessionID)?.model ?? "unknown",
            provider: model?.providerID ?? state.pending.get(sessionID)?.provider ?? "unknown",
            startTime: event.created ?? now,
            messageID: asString(data.assistantMessageID),
        });
        return [];
    }
    if (event.type === "session.tool.called") {
        const callID = asString(data.id);
        const name = asString(data.name);
        if (!callID || !name)
            return [];
        const input = asRecord(data.input);
        state.tools.set(callID, { name, input });
        return [];
    }
    if (event.type === "session.tool.success" && options.includeToolOutput) {
        const callID = asString(data.id);
        if (!callID)
            return [];
        const cached = callID ? state.tools.get(callID) : undefined;
        const name = cached?.name ?? asString(data.name) ?? "tool";
        if (shouldSkipTool(name))
            return [];
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
        if (!messageID || state.completed.has(messageID))
            return [];
        const cutoff = state.forkCutoffMs.get(sessionID);
        if (cutoff != null && (event.created ?? now) < cutoff)
            return [];
        const pending = state.pending.get(sessionID);
        const tokens = tokensOf(data.tokens);
        state.completed.add(messageID);
        state.pending.delete(sessionID);
        const events = [{
                type: "turn.completed",
                session_id: sessionID,
                turn_id: messageID,
                message_id: messageID,
                model: pending?.model ?? model?.id ?? "unknown",
                provider: pending?.provider ?? model?.providerID ?? "unknown",
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
                model: pending?.model ?? model?.id,
                provider: pending?.provider ?? model?.providerID,
                created_at: createdAt,
            });
            state.texts.delete(messageID);
        }
        return events;
    }
    if (event.type === "session.step.failed" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        const pending = state.pending.get(sessionID);
        if (!pending)
            return [];
        const error = asRecord(data.error);
        const reason = asString(data.reason);
        const errorName = asString(error?.message) ?? reason ?? event.type;
        const aborted = reason === "user" || /abort|interrupt/i.test(errorName);
        state.pending.delete(sessionID);
        return [{
                type: "turn.error",
                session_id: sessionID,
                turn_id: pending.messageID ?? `turn-${sessionID}-${pending.startTime}`,
                model: pending.model,
                provider: pending.provider,
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
//# sourceMappingURL=opencode2-events.js.map