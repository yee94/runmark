import { describe, expect, it } from "bun:test";
import { createTraceHelpers } from "../public/modules/trace.eficy.js";

function makeTraceHelpers() {
  return createTraceHelpers({
    formatMessageContent: (content: unknown) => String(content ?? ""),
    isGarbageMessage: () => false,
    parseSessionMetadata: () => ({}),
    formatTokens: (value: unknown) => String(value ?? 0),
    formatCost: (value: unknown) => String(value ?? 0),
    formatDuration: (value: unknown) => String(value ?? 0),
    formatSessionDuration: (value: unknown) => String(value ?? 0),
    expandedSubagents: { value: {} },
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
  });
});
