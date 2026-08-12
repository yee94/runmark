import { describe, it, expect } from "bun:test";
import { mapHookPayload, resolveSessionId } from "../src/map";

describe("mapHookPayload", () => {
  it("sessionStart does not create session until first prompt", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "sessionStart",
        session_id: "sess-1",
        composer_mode: "agent",
        workspace_roots: ["/tmp/proj"],
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events).toHaveLength(0);
  });

  it("beforeSubmitPrompt emits session + user message", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "conv-1",
        generation_id: "gen-1",
        prompt: "fix the bug in auth.ts",
        model: "composer-2.5",
        composer_mode: "agent",
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events.some((e) => e.type === "session.created")).toBe(true);
    expect(events.some((e) => e.type === "message" && e.role === "user")).toBe(true);
    const created = events.find((e) => e.type === "session.created") as any;
    expect(created.title).toContain("fix the bug");
    expect(created.metadata?.composer_mode).toBe("agent");
    expect(resolveSessionId({ conversation_id: "conv-1" })).toBe("conv-1");
  });

  it("afterAgentResponse emits assistant message and placeholder turn (billing via Usage API UPDATE)", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "conv-1",
        generation_id: "gen-2",
        text: "Here is the fix.",
        model: "claude-sonnet-4",
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events.some((e) => e.type === "message" && e.role === "assistant")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed" && e.turn_id === "assistant-gen-2")).toBe(true);
    const turn = events.find((e) => e.type === "turn.completed") as any;
    expect(turn.total_tokens).toBe(0);
    expect(turn.input_tokens).toBe(0);
  });

  it("stop aborted reuses assistant-${generationId} turn like success path", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "stop",
        conversation_id: "conv-1",
        generation_id: "gen-abort",
        status: "aborted",
        model: "claude-sonnet-4",
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn.error",
      turn_id: "assistant-gen-abort",
      message_id: "assistant-gen-abort",
      finish_reason: "aborted",
      error: "aborted",
      model: "claude-sonnet-4",
    });
  });

  it("postToolUse skips shared noise tools including Bash", () => {
    for (const tool_name of ["Read", "Write", "Shell", "Bash", "Grep", "Glob", "read", "SHELL", "bash"]) {
      const events = mapHookPayload(
        {
          hook_event_name: "postToolUse",
          conversation_id: "conv-1",
          tool_name,
          tool_use_id: `tc-${tool_name}`,
          tool_input: { path: "a.ts" },
          tool_output: "ok",
          duration: 10,
        },
        { includeMessages: true, includeToolOutput: true },
      );
      expect(events).toHaveLength(0);
    }
  });

  it("postToolUse still emits non-noise tools", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "postToolUse",
        conversation_id: "conv-1",
        tool_name: "EditNotebook",
        tool_use_id: "tc-nb",
        tool_input: { target_notebook: "a.ipynb" },
        tool_output: "ok",
        duration: 50,
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool.result",
      tool_name: "EditNotebook",
      call_id: "tc-nb",
      agent: "cursor",
    });
  });

  it("postToolUseFailure also skips noise tools", () => {
    for (const tool_name of ["Shell", "Bash"]) {
      const events = mapHookPayload(
        {
          hook_event_name: "postToolUseFailure",
          conversation_id: "conv-1",
          tool_name,
          tool_use_id: `tc-fail-${tool_name}`,
          error_message: "exit 1",
        },
        { includeMessages: true, includeToolOutput: true },
      );
      expect(events).toHaveLength(0);
    }
  });

  it("subagentStart creates child session", () => {
    const events = mapHookPayload(
      {
        hook_event_name: "subagentStart",
        subagent_id: "sub-1",
        parent_conversation_id: "conv-1",
        task: "Explore auth module",
        subagent_model: "composer-2.5",
      },
      { includeMessages: true, includeToolOutput: true },
    );
    expect(events[0]).toMatchObject({
      type: "session.created",
      session_id: "sub-1",
      parent_session_id: "conv-1",
      agent: "cursor",
    });
  });
});
