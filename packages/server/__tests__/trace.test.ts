import { describe, expect, it } from "bun:test";
import {
  TRACE_CATEGORIES,
  countTraceCategories,
  createTraceHelpers,
  cursorTurnTraceKey,
  filterTraceItems,
  isForkStructuralItem,
  resolveTraceSelection,
  toggleTraceSelectionKey,
  toolTraceKey,
  traceChildQuery,
  traceItemCategory,
} from "../public/modules/trace.eficy.js";

function makeTraceHelpers(expanded: Record<string, boolean> = {}) {
  return createTraceHelpers({
    formatMessageContent: (content: unknown) => String(content ?? ""),
    isGarbageMessage: () => false,
    parseSessionMetadata: () => ({}),
    formatTokens: (value: unknown) => String(value ?? 0),
    formatCost: (value: unknown) => String(value ?? 0),
    formatDuration: (value: unknown) => String(value ?? 0),
    formatSessionDuration: (value: unknown) => String(value ?? 0),
    expandedSubagents: { value: expanded },
  });
}

describe("trace timeline", () => {
  it("orders same-timestamp items as user, turn, assistant", () => {
    const ts = "2026-07-09T11:08:36.000Z";
    const { mergeForkTraceItems } = makeTraceHelpers();

    const items = mergeForkTraceItems(
      { id: "sess-1", agent: "cursor", started_at: ts },
      {
        messages: [
          {
            id: "assistant-gen-1",
            role: "assistant",
            content: "done",
            created_at: ts,
          },
          {
            id: "user-gen-1",
            role: "user",
            content: "do it",
            created_at: ts,
          },
        ],
        turns: [
          {
            id: "assistant-gen-1",
            message_id: "assistant-gen-1",
            model: "cursor",
            provider: "cursor",
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            duration_ms: 0,
            cost_cny: 0,
            created_at: ts,
          },
        ],
        tools: [],
        children: [],
      },
    );

    expect(items.map((item) => item.kind === "message" ? item.role : item.kind)).toEqual([
      "user",
      "turn",
      "assistant",
    ]);
    expect(items.find((item) => item.kind === "turn")?.key).toBe("turn-assistant-gen-1");
    expect(items.every((item) => item.ownerSessionId === "sess-1")).toBe(true);
  });

  it("uses database primary keys and cursor-turn prefix for synthetic turns", () => {
    const ts = "2026-07-09T11:08:36.000Z";
    const { mergeForkTraceItems } = makeTraceHelpers();

    const items = mergeForkTraceItems(
      { id: "sess-cursor", agent: "cursor", started_at: ts },
      {
        messages: [
          {
            id: "assistant-no-hook",
            role: "assistant",
            content: "hello",
            created_at: ts,
          },
        ],
        turns: [
          {
            id: "cursor-usage-1",
            message_id: "assistant-no-hook",
            model: "cursor",
            provider: "cursor",
            created_at: ts,
          },
        ],
        tools: [
          {
            id: "tool-row-9",
            call_id: "call-xyz",
            tool_name: "bash",
            created_at: ts,
          },
        ],
        children: [{ id: "child-1", title: "Nested", started_at: ts }],
      },
    );

    expect(items.map((item) => item.key)).toEqual([
      "cursor-turn-assistant-no-hook",
      "msg-assistant-no-hook",
      "tool-tool-row-9",
      "subagent-child-1",
    ]);
    expect(cursorTurnTraceKey("assistant-no-hook")).toBe("cursor-turn-assistant-no-hook");
    expect(toolTraceKey({ id: "tool-row-9" })).toBe("tool-tool-row-9");
  });

  it("assigns ownerSessionId and recursively flattens a flat childDetails map", () => {
    const t1 = "2026-07-09T11:00:00.000Z";
    const t2 = "2026-07-09T11:01:00.000Z";
    const t3 = "2026-07-09T11:02:00.000Z";
    const t4 = "2026-07-09T11:03:00.000Z";
    const t5 = "2026-07-09T11:04:00.000Z";
    const { mergeForkTraceItems } = makeTraceHelpers({
      "child-1": true,
      "grand-1": true,
    });

    const items = mergeForkTraceItems(
      { id: "root-1", started_at: t1 },
      {
        messages: [{ id: "root-msg", role: "user", content: "root", created_at: t1 }],
        turns: [],
        tools: [],
        children: [{ id: "child-1", title: "Child", started_at: t2 }],
        childDetails: {
          "child-1": {
            messages: [{ id: "child-msg", role: "user", content: "child", created_at: t3 }],
            turns: [],
            tools: [],
            children: [{ id: "grand-1", title: "Grand", started_at: t4 }],
          },
          "grand-1": {
            messages: [{ id: "grand-msg", role: "assistant", content: "grand", created_at: t5 }],
            turns: [],
            tools: [],
            children: [],
          },
        },
      },
    );

    expect(items.map((item) => [item.key, item.ownerSessionId, !!item.nested])).toEqual([
      ["msg-root-msg", "root-1", false],
      ["subagent-child-1", "root-1", false],
      ["msg-child-msg", "child-1", true],
      ["subagent-grand-1", "child-1", true],
      ["msg-grand-msg", "grand-1", true],
    ]);
    expect(items.every((item) => item.ownerSessionId)).toBe(true);
  });

  it("synthesizes nested Cursor turns using child session metadata", () => {
    const t1 = "2026-07-09T11:00:00.000Z";
    const t2 = "2026-07-09T11:01:00.000Z";
    const t3 = "2026-07-09T11:02:00.000Z";
    const { mergeForkTraceItems } = makeTraceHelpers({
      "child-from-item": true,
      "child-from-detail": true,
    });

    const items = mergeForkTraceItems(
      { id: "root-1", agent: "opencode", started_at: t1 },
      {
        messages: [{ id: "root-msg", role: "user", content: "root", created_at: t1 }],
        turns: [],
        tools: [],
        children: [
          { id: "child-from-item", agent: "cursor", title: "From item", started_at: t2 },
          { id: "child-from-detail", title: "From detail", started_at: t3 },
        ],
        childDetails: {
          "child-from-item": {
            messages: [{ id: "asst-item", role: "assistant", content: "from item", created_at: t2 }],
            turns: [{
              id: "cursor-usage-item",
              message_id: "asst-item",
              model: "cursor",
              provider: "cursor",
              created_at: t2,
            }],
            tools: [],
            children: [],
          },
          "child-from-detail": {
            session: { id: "child-from-detail", agent: "cursor" },
            messages: [{ id: "asst-detail", role: "assistant", content: "from detail", created_at: t3 }],
            turns: [{
              id: "cursor-usage-detail",
              message_id: "asst-detail",
              model: "cursor",
              provider: "cursor",
              created_at: t3,
            }],
            tools: [],
            children: [],
          },
        },
      },
    );

    expect(items.map((item) => [item.key, item.ownerSessionId, !!item.nested])).toEqual([
      ["msg-root-msg", "root-1", false],
      ["subagent-child-from-item", "root-1", false],
      ["cursor-turn-asst-item", "child-from-item", true],
      ["msg-asst-item", "child-from-item", true],
      ["subagent-child-from-detail", "root-1", false],
      ["cursor-turn-asst-detail", "child-from-detail", true],
      ["msg-asst-detail", "child-from-detail", true],
    ]);
  });

  it("keeps fork prelude rows visible and owned by the current session", () => {
    const { mergeForkTraceItems } = makeTraceHelpers();
    const items = mergeForkTraceItems(
      { id: "fork-1", is_fork: true, started_at: "2026-07-09T12:00:00.000Z" },
      {
        forkParent: { id: "parent-1", title: "Source", started_at: "2026-07-09T11:00:00.000Z" },
        forkParentFirstMessage: {
          id: "pmsg-1",
          role: "user",
          content: "origin",
          created_at: "2026-07-09T11:00:00.000Z",
        },
        messages: [
          { id: "fmsg", role: "user", content: "after fork", created_at: "2026-07-09T12:00:01.000Z" },
        ],
        turns: [],
        tools: [],
        children: [],
      },
    );

    expect(items.map((item) => [item.key, item.ownerSessionId])).toEqual([
      ["fork-from-parent-1", "fork-1"],
      ["fork-origin-msg-pmsg-1", "fork-1"],
      ["msg-fmsg", "fork-1"],
    ]);
    expect(filterTraceItems(items, ["tool"]).map((item) => item.key)).toEqual([
      "fork-from-parent-1",
      "fork-origin-msg-pmsg-1",
    ]);
  });
});

describe("trace category helpers", () => {
  it("maps items onto the fixed category list and keeps fork rows structural", () => {
    expect(TRACE_CATEGORIES).toEqual([
      "user",
      "reasoning",
      "assistant",
      "turn",
      "tool",
      "abort",
      "error",
      "subagent",
    ]);

    const mapped = [
      { kind: "message", role: "user" },
      { kind: "message", role: "system" },
      { kind: "message", role: "reasoning" },
      { kind: "message", role: "assistant" },
      { kind: "message", role: "tool" },
      { kind: "turn", role: "turn" },
      { kind: "tool", role: "tool" },
      { kind: "turn", role: "turn-abort", abort: true },
      { kind: "turn", role: "turn-fail" },
      { kind: "subagent", role: "subagent" },
      { kind: "fork-from", role: "fork-from" },
      { kind: "message", role: "user", forkOrigin: true },
    ].map((item) => [traceItemCategory(item), isForkStructuralItem(item)]);

    expect(mapped).toEqual([
      ["user", false],
      ["user", false],
      ["reasoning", false],
      ["assistant", false],
      ["tool", false],
      ["turn", false],
      ["tool", false],
      ["abort", false],
      ["error", false],
      ["subagent", false],
      [null, true],
      [null, true],
    ]);
  });

  it("counts unfiltered categories and always keeps fork structural rows", () => {
    const items = [
      { key: "fork-from-p", kind: "fork-from", role: "fork-from" },
      { key: "fork-origin-msg-1", kind: "message", role: "user", forkOrigin: true },
      { key: "msg-u", kind: "message", role: "user" },
      { key: "msg-r", kind: "message", role: "reasoning" },
      { key: "msg-a", kind: "message", role: "assistant" },
      { key: "turn-1", kind: "turn", role: "turn" },
      { key: "tool-1", kind: "tool", role: "tool" },
      { key: "turn-abort", kind: "turn", role: "turn-abort", abort: true },
      { key: "turn-fail", kind: "turn", role: "turn-fail" },
      { key: "subagent-1", kind: "subagent", role: "subagent" },
    ];

    expect(countTraceCategories(items)).toEqual({
      user: 1,
      reasoning: 1,
      assistant: 1,
      turn: 1,
      tool: 1,
      abort: 1,
      error: 1,
      subagent: 1,
    });

    expect(filterTraceItems(items, []).map((item) => item.key)).toEqual(items.map((item) => item.key));
    expect(filterTraceItems(items, ["error"]).map((item) => item.key)).toEqual([
      "fork-from-p",
      "fork-origin-msg-1",
      "turn-fail",
    ]);
    expect(filterTraceItems(items, ["nope", "tool"]).map((item) => item.key)).toEqual([
      "fork-from-p",
      "fork-origin-msg-1",
      "tool-1",
    ]);
  });

});

describe("trace selection resolution", () => {
  const items = [
    { key: "fork-from-p", kind: "fork-from", role: "fork-from" },
    { key: "msg-u", kind: "message", role: "user" },
    { key: "turn-1", kind: "turn", role: "turn" },
    { key: "msg-a", kind: "message", role: "assistant" },
    { key: "tool-1", kind: "tool", role: "tool" },
    { key: "msg-a2", kind: "message", role: "assistant" },
  ];

  it("keeps an explicit pending route key until the row exists", () => {
    expect(resolveTraceSelection(items, "missing-url-node", ["tool"])).toBe("missing-url-node");
    expect(resolveTraceSelection([], "pending-nested-node", [])).toBe("pending-nested-node");
    expect(resolveTraceSelection(items, "msg-a", ["assistant"])).toBe("msg-a");
  });

  it("clears an explicit selection when filters hide it", () => {
    expect(resolveTraceSelection(items, "turn-1", ["assistant", "tool"])).toBeNull();
    expect(resolveTraceSelection(items, "turn-1", ["user", "assistant"])).toBeNull();
    expect(resolveTraceSelection(items, "turn-1", ["user", "tool"])).toBeNull();
  });

  it("clears selection when the filtered timeline is empty", () => {
    expect(resolveTraceSelection(
      [
        { key: "msg-u", kind: "message", role: "user" },
        { key: "turn-1", kind: "turn", role: "turn" },
      ],
      "turn-1",
      ["subagent"],
    )).toBeNull();
    expect(resolveTraceSelection([], null, [])).toBeNull();
  });

  it("keeps the timeline unselected without an explicit node", () => {
    expect(resolveTraceSelection(items, null, [])).toBeNull();
    expect(resolveTraceSelection(items, "", ["user", "turn", "tool"])).toBeNull();
    expect(resolveTraceSelection(items, null, ["subagent"])).toBeNull();
  });

  it("toggles an explicitly selected row off", () => {
    expect(toggleTraceSelectionKey(null, "turn-1")).toBe("turn-1");
    expect(toggleTraceSelectionKey("turn-1", "turn-1")).toBeNull();
    expect(toggleTraceSelectionKey("turn-1", "msg-a")).toBe("msg-a");
  });
});

describe("trace child query", () => {
  it("derives child from ownerSessionId versus root and keeps subagent stubs on the parent", () => {
    expect(traceChildQuery({ key: "msg-root", ownerSessionId: "root-1" }, "root-1")).toBeNull();
    expect(traceChildQuery({
      key: "subagent-child-1",
      kind: "subagent",
      ownerSessionId: "root-1",
      childSessionId: "child-1",
    }, "root-1")).toBeNull();
    expect(traceChildQuery({
      key: "msg-child",
      kind: "message",
      ownerSessionId: "child-1",
    }, "root-1")).toBe("child-1");
    expect(traceChildQuery({
      key: "subagent-grand-1",
      kind: "subagent",
      ownerSessionId: "child-1",
      childSessionId: "grand-1",
    }, "root-1")).toBe("child-1");
    expect(traceChildQuery({ key: "msg-grand", ownerSessionId: "grand-1" }, "root-1")).toBe("grand-1");
    expect(traceChildQuery(null, "root-1")).toBeNull();
    expect(traceChildQuery({ key: "msg-child", ownerSessionId: "child-1" }, "")).toBeNull();
  });
});
