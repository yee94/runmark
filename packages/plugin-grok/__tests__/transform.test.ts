import { describe, expect, it } from "bun:test";
import {
  inferProvider,
  resolveSessionId,
  resolveHookEventName,
  transformSessionStart,
  transformUserPrompt,
  transformPostToolUse,
  transformStop,
  transformStopFailure,
} from "../src/transform";

describe("inferProvider", () => {
  it("maps grok models to xai", () => {
    expect(inferProvider("grok-4.5")).toBe("xai");
    expect(inferProvider("grok-4.5-build")).toBe("xai");
    expect(inferProvider(undefined)).toBe("xai");
  });
});

describe("field normalization", () => {
  it("accepts camelCase sessionId / hookEventName", () => {
    expect(resolveSessionId({ sessionId: "abc" })).toBe("abc");
    expect(resolveSessionId({ session_id: "xyz" })).toBe("xyz");
    expect(resolveHookEventName({ hookEventName: "Stop" })).toBe("Stop");
    expect(resolveHookEventName({ hook_event_name: "SessionStart" })).toBe("SessionStart");
  });
});

describe("transformSessionStart", () => {
  it("maps to session.created with agent=grok", () => {
    const ev = transformSessionStart(
      {
        sessionId: "s1",
        hookEventName: "SessionStart",
        source: "startup",
        model: "grok-4.5",
        cwd: "/tmp/proj",
      },
      {
        author: "me@example.com",
        repoUrl: "https://github.com/acme/app",
        branch: "main",
        hostname: "mac",
        directory: "/tmp/proj",
      },
    );
    expect(ev).toMatchObject({
      type: "session.created",
      session_id: "s1",
      agent: "grok",
      model: "grok-4.5",
      provider: "xai",
      repo_url: "https://github.com/acme/app",
      branch: "main",
      user_email: "me@example.com",
    });
  });
});

describe("transformUserPrompt", () => {
  it("maps prompt to user message", () => {
    const ev = transformUserPrompt({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
      model: "grok-4.5",
      turn_id: "t1",
    });
    expect(ev).toMatchObject({
      type: "message",
      role: "user",
      content: "fix the bug",
      session_id: "s1",
      message_id: "t1",
      provider: "xai",
    });
  });
});

describe("transformPostToolUse", () => {
  it("maps tool result", () => {
    const ev = transformPostToolUse({
      sessionId: "s1",
      toolName: "search_replace",
      toolUseId: "call-1",
      toolInput: { path: "a.ts" },
      toolResponse: "ok",
      durationMs: 12,
    });
    expect(ev).toMatchObject({
      type: "tool.result",
      agent: "grok",
      tool_name: "search_replace",
      call_id: "call-1",
      duration_ms: 12,
    });
  });

  it("maps failure", () => {
    const ev = transformPostToolUse(
      {
        sessionId: "s1",
        toolName: "run_terminal_command",
        error: "exit 1",
      },
      { failed: true },
    );
    expect(ev.error).toBe("exit 1");
  });
});

describe("transformStop", () => {
  it("emits session.idle and optional assistant", () => {
    const events = transformStop({
      sessionId: "s1",
      lastAssistantMessage: "done",
      model: "grok-4.5",
    });
    expect(events.some((e) => e.type === "session.idle")).toBe(true);
    expect(
      events.some((e) => e.type === "message" && e.role === "assistant"),
    ).toBe(true);
  });
});

describe("transformStopFailure", () => {
  it("emits turn.error with required token fields", () => {
    const events = transformStopFailure({
      sessionId: "s1",
      error: "api boom",
    });
    const err = events.find((e) => e.type === "turn.error");
    expect(err).toMatchObject({
      type: "turn.error",
      session_id: "s1",
      error: "api boom",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});
