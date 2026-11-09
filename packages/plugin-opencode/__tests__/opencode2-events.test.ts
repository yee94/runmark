import { describe, expect, it } from "bun:test";
import { computeCost } from "@agent-tracker/shared";
import { createOpenCode2TrackerState, mapOpenCode2Event } from "../src/opencode2-events";

const options = { includeMessageContent: true, includeToolOutput: true, now: 1_700_000_000_000 };

describe("mapOpenCode2Event", () => {
  it.each([true, false])("reports the delivered client in the actual session agent field (capture=%s)", (includeMessageContent) => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown> = {}) => mapOpenCode2Event(state, { type, data: { sessionID: "yuri-session", ...data } }, { ...options, includeMessageContent });
    expect(event("session.created")[0]).toMatchObject({ agent: "opencode", metadata: { runtime: "opencode" } });
    event("session.inbox.enqueued", { inboxID: "input", item: { type: "user", payload: { text: "hello", metadata: { client: { id: "yuri" } } } } });
    expect(event("session.inbox.delivered", { inboxID: "input" })).toEqual([{ type: "session.updated", session_id: "yuri-session", agent: "yuri" }]);
    expect(event("session.inbox.delivered", { inboxID: "input" })).toEqual([]);
    event("session.step.started", { assistantMessageID: "answer", agent: "build" });
    event("session.step.ended", { assistantMessageID: "answer" });
    expect(event("session.execution.succeeded")[0]).toMatchObject({ agent: "yuri" });
    expect(event("session.renamed", { title: "renamed" })[0]).toMatchObject({ agent: "yuri" });
    expect(event("session.usage.updated", { cost: 1 })[0]).toMatchObject({ agent: "yuri" });
    expect(event("session.model.selected", { model: { id: "test" } })[0]).toMatchObject({ agent: "yuri" });
    event("session.tool.called", { id: "tool", name: "custom_tool" });
    expect(event("session.tool.success", { id: "tool", content: [] })[0]).toMatchObject({ agent: "yuri" });
  });

  it("does not change agent for queued or cancelled clients, and inherits the reported agent for child sessions", () => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown> = {}) => mapOpenCode2Event(state, { type, data: { sessionID: "parent", ...data } }, options);
    const enqueue = (inboxID: string, client: string) => event("session.inbox.enqueued", { inboxID, item: { type: "user", payload: { text: inboxID, metadata: { client: { id: client } } } } });
    enqueue("queued", "other");
    expect(event("session.renamed")[0]).toMatchObject({ agent: "opencode" });
    event("session.inbox.cancelled", { inboxID: "queued" });
    enqueue("actual", "yuri");
    event("session.inbox.delivered", { inboxID: "actual" });
    expect(event("session.created", { sessionID: "child", parentID: "parent" })[0]).toMatchObject({ agent: "yuri", parent_session_id: "parent" });
    expect(event("session.created", { sessionID: "separate" })[0]).toMatchObject({ agent: "opencode" });
    event("session.inbox.delivered", { inboxID: "unknown" });
    expect(event("session.usage.updated")[0]).toMatchObject({ agent: "yuri" });
    enqueue("switch", "other");
    expect(event("session.inbox.delivered", { inboxID: "switch" })[0]).toMatchObject({ agent: "other" });
    expect(event("session.usage.updated")[0]).toMatchObject({ agent: "other" });
  });

  it.each(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])("clears provenance after %s while preserving queued prompts and other sessions", (terminal) => {
    const state = createOpenCode2TrackerState();
    const event = (sessionID: string, type: string, data: Record<string, unknown> = {}) => mapOpenCode2Event(state, { type, data: { sessionID, ...data } }, options);
    const enqueue = (sessionID: string, id: string, client?: string) => event(sessionID, "session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: id, metadata: { client: { id: client } } } } });
    for (const session of ["first", "second"]) {
      enqueue(session, session, "yuri");
      event(session, "session.inbox.delivered", { inboxID: session });
      event(session, "session.step.started", { assistantMessageID: session });
      event(session, "session.step.ended", { assistantMessageID: session });
    }
    enqueue("first", "queued", "other");
    enqueue("first", "interrupted-before-step", "yuri");
    event("first", "session.inbox.delivered", { inboxID: "interrupted-before-step" });
    event("first", terminal);
    event("first", "session.step.started", { assistantMessageID: "new-unknown" });
    expect((event("first", "session.step.ended", { assistantMessageID: "new-unknown" })[0] as any).client_id).toBeUndefined();
    event("second", "session.step.started", { assistantMessageID: "second-continuation" });
    expect(event("second", "session.step.ended", { assistantMessageID: "second-continuation" })[0]).toMatchObject({ client_id: "yuri" });
    event("first", "session.inbox.delivered", { inboxID: "queued" });
    event("first", "session.step.started", { assistantMessageID: "queued-answer" });
    expect(event("first", "session.step.ended", { assistantMessageID: "queued-answer" })[0]).toMatchObject({ client_id: "other" });
  });

  it.each([true, false])("does not guess a turn source when a delivered input is unknown (%s)", (enqueueUnknown) => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "mixed", ...data } }, options);
    event("session.inbox.enqueued", { inboxID: "known", item: { type: "user", payload: { text: "known", metadata: { client: { id: "yuri" } } } } });
    event("session.inbox.delivered", { inboxID: "known" });
    if (enqueueUnknown) event("session.inbox.enqueued", { inboxID: "unknown", item: { type: "user", payload: { text: "unmarked" } } });
    event("session.inbox.delivered", { inboxID: "unknown" });
    event("session.step.started", { assistantMessageID: "answer" });
    expect((event("session.step.ended", { assistantMessageID: "answer" })[0] as any).client_id).toBeUndefined();
  });

  it("ignores enqueue/delivery replays after consumption and keeps retry/failure turns tied to their execution", () => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "replay", ...data } }, options);
    const input = { inboxID: "input", item: { type: "user", payload: { text: "prompt", metadata: { client: { id: "yuri" } } } } };
    event("session.inbox.enqueued", input);
    event("session.inbox.delivered", input);
    event("session.step.started", { assistantMessageID: "failed" });
    expect(event("session.step.failed", { error: { message: "retryable" } })[0]).toMatchObject({ client_id: "yuri" });
    event("session.inbox.enqueued", input);
    event("session.inbox.delivered", input);
    expect(event("session.step.started", { assistantMessageID: "retry" })).toEqual([]);
    expect(event("session.execution.interrupted", { reason: "user" })[0]).toMatchObject({ client_id: "yuri", finish_reason: "aborted" });
    expect(event("session.execution.interrupted", { reason: "user" })).toEqual([]);
    event("session.inbox.enqueued", input);
    event("session.inbox.delivered", input);
    event("session.step.started", { assistantMessageID: "unmarked" });
    expect((event("session.step.ended", { assistantMessageID: "unmarked" })[0] as any).client_id).toBeUndefined();
  });

  it.each([true, false])("tracks delivered client provenance independently of message capture (%s)", (includeMessageContent) => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "shared", ...data } }, { ...options, includeMessageContent });
    event("session.inbox.enqueued", { inboxID: "yuri", item: { type: "user", payload: { text: "first", metadata: { client: { id: "yuri" } } } } });
    event("session.inbox.enqueued", { inboxID: "cli", item: { type: "user", payload: { text: "queued" } } });
    event("session.inbox.delivered", { inboxID: "yuri" });
    const user = event("session.step.started", { agent: "build", assistantMessageID: "first" });
    if (includeMessageContent) expect(user).toMatchObject([{ client_id: "yuri", agent_key: "opencode/build" }]);
    else expect(user).toEqual([]);
    expect(event("session.step.ended", { assistantMessageID: "first" })[0]).toMatchObject({ client_id: "yuri" });
    event("session.step.started", { agent: "build", assistantMessageID: "continuation" });
    expect(event("session.step.ended", { assistantMessageID: "continuation" })[0]).toMatchObject({ client_id: "yuri" });
    event("session.inbox.delivered", { inboxID: "cli" });
    event("session.step.started", { agent: "plan", assistantMessageID: "cli-answer" });
    const cli = event("session.step.ended", { assistantMessageID: "cli-answer" })[0];
    expect((cli as any).client_id).toBeUndefined();
  });

  it("keeps mixed delivered clients separate and never attributes their shared turn to one UI", () => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "mixed", ...data } }, options);
    for (const id of ["yuri", "other"]) {
      event("session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: id, metadata: { client: { id } } } } });
      event("session.inbox.delivered", { inboxID: id });
    }
    expect(event("session.step.started", { agent: "build", assistantMessageID: "answer" }).map(item => (item as any).client_id)).toEqual(["yuri", "other"]);
    expect((event("session.step.ended", { assistantMessageID: "answer" })[0] as any).client_id).toBeUndefined();
  });

  it("preserves admission provenance on duplicates, ignores cancelled prompts and clears completed execution context", () => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "retry", ...data } }, options);
    for (const id of ["yuri", "other"]) event("session.inbox.enqueued", { inboxID: "fixed", item: { type: "user", payload: { text: "same", metadata: { client: { id } } } } });
    event("session.inbox.delivered", { inboxID: "fixed" });
    event("session.step.started", { assistantMessageID: "answer" });
    expect(event("session.step.ended", { assistantMessageID: "answer" })[0]).toMatchObject({ client_id: "yuri" });
    expect(event("session.execution.succeeded", {})[0]).toMatchObject({ agent: "yuri" });
    event("session.inbox.enqueued", { inboxID: "cancelled", item: { type: "user", payload: { text: "cancel", metadata: { client: { id: "yuri" } } } } });
    event("session.inbox.cancelled", { inboxID: "cancelled" });
    event("session.inbox.delivered", { inboxID: "cancelled" });
    event("session.step.started", { assistantMessageID: "unmarked" });
    expect((event("session.step.ended", { assistantMessageID: "unmarked" })[0] as any).client_id).toBeUndefined();
  });

  it.each([null, [], { id: "Yuri" }, { id: "x".repeat(65) }, { id: "bad\nheader" }].map(client => ({ client })))("treats malformed client declarations as unknown (%j)", ({ client }) => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "bad", ...data } }, options);
    event("session.inbox.enqueued", { inboxID: "input", item: { type: "user", payload: { text: "hello", metadata: { client } } } });
    event("session.inbox.delivered", { inboxID: "input" });
    expect((event("session.step.started", { assistantMessageID: "answer" })[0] as any).client_id).toBeUndefined();
  });

  it("binds only delivered prompts to their executing step across Agent switches", () => {
    const state = createOpenCode2TrackerState();
    const event = (type: string, data: Record<string, unknown>) => mapOpenCode2Event(state, { type, data: { sessionID: "same", ...data } }, options);
    for (const id of ["first", "queued"]) event("session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: id } } });
    event("session.inbox.delivered", { inboxID: "first" });
    expect(event("session.step.started", { agent: "build", assistantMessageID: "answer" })).toMatchObject([{ message_id: "first", agent_key: "opencode/build" }]);
    event("session.agent.selected", { agent: "plan" });
    event("session.text.ended", { assistantMessageID: "answer", text: "built" });
    expect(event("session.step.ended", { assistantMessageID: "answer" }).find(item => item.type === "message")).toMatchObject({ agent_key: "opencode/build" });
    event("session.inbox.delivered", { inboxID: "queued" });
    expect(event("session.step.started", { agent: "plan", assistantMessageID: "plan-answer" })).toMatchObject([{ message_id: "queued", agent_key: "opencode/plan" }]);
    expect(event("session.step.started", { agent: "build", assistantMessageID: "next" })).toEqual([]);
    event("session.inbox.enqueued", { inboxID: "unknown", item: { type: "user", payload: { text: "unknown" } } });
    event("session.inbox.delivered", { inboxID: "unknown" });
    expect((event("session.step.started", { assistantMessageID: "unknown-answer" })[0] as any).agent_key).toBeUndefined();
  });
  it("reports every billable model step, including tool-call continuations", () => {
    const state = createOpenCode2TrackerState();
    const events = [];
    for (const [messageID, finish] of [["msg_tool", "tool-calls"], ["msg_final", "stop"]]) {
      mapOpenCode2Event(state, {
        type: "session.step.started", created: options.now,
        data: { sessionID: "ses_billing", assistantMessageID: messageID, model: { id: "gpt-6-astra", providerID: "openai" } },
      }, options);
      const ended = {
        type: "session.step.ended", created: options.now + 20,
        data: { sessionID: "ses_billing", assistantMessageID: messageID, finish, cost: 0,
          tokens: { input: 1000, output: 100, reasoning: 200, cache: { read: 100000, write: 0 } } },
      };
      events.push(...mapOpenCode2Event(state, ended, options));
      expect(mapOpenCode2Event(state, ended, options)).toEqual([]);
    }
    const turns = events.filter((event) => event.type === "turn.completed");
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.turn_id)).toEqual(["msg_tool", "msg_final"]);
    expect(turns.reduce((sum, turn) => sum + turn.total_tokens, 0)).toBe(202600);
    expect(turns.reduce((sum, turn) => sum + computeCost(turn.provider, turn.model, turn), 0)).toBe(0.25);
  });

  it("maps a session, user prompt, and completed step into ingest events", () => {
    const state = createOpenCode2TrackerState();
    const created = mapOpenCode2Event(state, {
      type: "session.created",
      created: options.now,
      data: { sessionID: "ses_1", title: "fix plugin", agent: "build", location: { directory: "/tmp/repo" } },
    }, options);
    expect(created[0]).toMatchObject({ type: "session.created", session_id: "ses_1", title: "fix plugin" });

    const user = mapOpenCode2Event(state, {
      type: "session.inbox.enqueued",
      data: { sessionID: "ses_1", inboxID: "in_1", item: { type: "user", payload: { text: "hello" } } },
    }, options);
    expect(user).toEqual([]);
    mapOpenCode2Event(state, { type: "session.inbox.delivered", data: { sessionID: "ses_1", inboxID: "in_1" } }, options);

    const delivered = mapOpenCode2Event(state, {
      type: "session.step.started",
      created: options.now,
      data: { sessionID: "ses_1", agent: "build", assistantMessageID: "msg_1", model: { id: "grok-4.7", providerID: "xai" } },
    }, options);
    expect(delivered[0]).toMatchObject({ type: "message", role: "user", content: "hello", message_id: "in_1", agent_key: "opencode/build" });
    mapOpenCode2Event(state, {
      type: "session.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "done" },
    }, options);
    const step = mapOpenCode2Event(state, {
      type: "session.step.ended",
      created: options.now + 20,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0.01,
        tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 1, write: 0 } },
      },
    }, { ...options, now: options.now + 20 });

    expect(step.map((event) => event.type)).toEqual(["turn.completed", "message"]);
    expect(step[0]).toMatchObject({
      model: "grok-4.7",
      provider: "xai",
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 8,
      cost_usd: 0.01,
    });
    expect(step[1]).toMatchObject({ role: "assistant", content: "done", agent_key: "opencode/build" });
  });

  it("does not record placeholder unknown when a step has no model", () => {
    const state = createOpenCode2TrackerState();
    mapOpenCode2Event(state, {
      type: "session.step.started",
      created: options.now,
      data: { sessionID: "ses_missing", assistantMessageID: "msg_missing" },
    }, options);
    const step = mapOpenCode2Event(state, {
      type: "session.step.ended",
      created: options.now + 20,
      data: {
        sessionID: "ses_missing",
        assistantMessageID: "msg_missing",
        finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }, { ...options, now: options.now + 20 });
    expect(step[0]).toMatchObject({ type: "turn.completed", model: "unknown" });

    const usage = mapOpenCode2Event(state, {
      type: "session.usage.updated",
      data: { sessionID: "ses_missing", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    }, options);
    expect(usage[0]).toMatchObject({ type: "session.updated" });
    expect((usage[0] as { model?: string }).model).toBeUndefined();
  });

  it("reads modelID when OpenCode sends the legacy model shape", () => {
    const state = createOpenCode2TrackerState();
    const selected = mapOpenCode2Event(state, {
      type: "session.model.selected",
      data: { sessionID: "ses_legacy", model: { modelID: "deepseek-v4.1-flash", providerID: "magpie-workbuddy" } },
    }, options);
    expect(selected[0]).toMatchObject({ model: "deepseek-v4.1-flash", provider: "magpie-workbuddy" });
  });

  it("skips hidden sessions and noisy tools", () => {
    const state = createOpenCode2TrackerState();
    expect(mapOpenCode2Event(state, {
      type: "session.created",
      data: { sessionID: "ses_hidden", title: "smartfetch-secondary" },
    }, options)).toEqual([]);
    expect(mapOpenCode2Event(state, {
      type: "session.step.ended",
      data: { sessionID: "ses_hidden", assistantMessageID: "msg", finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    }, options)).toEqual([]);

    const tools = createOpenCode2TrackerState();
    mapOpenCode2Event(tools, {
      type: "session.tool.called",
      data: { sessionID: "ses_1", id: "call_1", name: "read", input: { path: "a.ts" } },
    }, options);
    expect(mapOpenCode2Event(tools, {
      type: "session.tool.success",
      data: { sessionID: "ses_1", id: "call_1", content: [{ type: "text", text: "file" }] },
    }, options)).toEqual([]);
  });
});
