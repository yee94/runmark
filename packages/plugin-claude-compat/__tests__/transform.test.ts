import { describe, expect, it } from "bun:test";
import {
  inferProvider,
  resolveAgent,
  transformPostToolUse,
  transformSessionResume,
  transformSessionStart,
  transformStop,
  transformStopAbortFallback,
  transformStopFailure,
  transformUserPrompt,
  isInterruptAssistantText,
} from "../src/transform";

describe("resolveAgent", () => {
  it("maps runtime hints to claude / codebuddy / workbuddy", () => {
    expect(resolveAgent({ runtime: "claude" })).toBe("claude");
    expect(resolveAgent({ runtime: "codebuddy" })).toBe("codebuddy");
    expect(resolveAgent({ runtime: "workbuddy" })).toBe("workbuddy");
    expect(resolveAgent({ transcript_path: "/Users/x/.codebuddy/projects/a/s.jsonl" })).toBe("codebuddy");
    expect(resolveAgent({ transcript_path: "/Users/x/.workbuddy/projects/a/s.jsonl" })).toBe("workbuddy");
    expect(resolveAgent({ transcript_path: "/Users/x/.claude/projects/a/s.jsonl" })).toBe("claude");
    expect(resolveAgent({ transcript_path: "/Users/x/.tclaude/projects/-tmp/s.jsonl" })).toBe("claude");
  });

  it("prefers ~/.workbuddy transcript over misleading codebuddy runtime hint", () => {
    // WorkBuddy Desktop 内嵌 CLI 常带着 CODEBUDDY_* → hostRuntime=codebuddy
    expect(
      resolveAgent({
        runtime: "codebuddy",
        transcript_path: "/Users/x/.workbuddy/projects/Users-x-Code-ai-work/s.jsonl",
      }),
    ).toBe("workbuddy");
  });
});

describe("detectHostRuntime", () => {
  it("detects workbuddy before codebuddy when CONFIG_DIR or product path says so", async () => {
    const { detectHostRuntime } = await import("../src/transform");
    expect(
      detectHostRuntime({
        CODEBUDDY_PLUGIN_ROOT: "/tmp/plugin",
        CODEBUDDY_CONFIG_DIR: "/Users/x/.workbuddy",
      } as NodeJS.ProcessEnv),
    ).toBe("workbuddy");
    expect(
      detectHostRuntime({
        CODEBUDDY_PLUGIN_ROOT: "/tmp/plugin",
        ACC_PRODUCT_CONFIG_PATH: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json",
      } as NodeJS.ProcessEnv),
    ).toBe("workbuddy");
    expect(
      detectHostRuntime({
        CODEBUDDY_PLUGIN_ROOT: "/tmp/plugin",
        CODEBUDDY_CONFIG_DIR: "/Users/x/.codebuddy",
      } as NodeJS.ProcessEnv),
    ).toBe("codebuddy");
  });
});

describe("inferProvider", () => {
  it("infers common model providers", () => {
    expect(inferProvider("claude-sonnet-4")).toBe("anthropic");
    expect(inferProvider("gpt-5.5")).toBe("openai");
    expect(inferProvider("deepseek-v4-flash")).toBe("codebuddy");
    expect(inferProvider("glm-5.2-ioa")).toBe("zhipu");
    expect(inferProvider("hy3-ioa")).toBe("hunyuan");
    expect(inferProvider(undefined)).toBe("unknown");
  });
});

describe("transform hooks", () => {
  it("maps SessionStart startup to session.created", () => {
    const ev = transformSessionStart(
      {
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: "/tmp/demo",
        model: "claude-sonnet-4",
      },
      { agent: "codebuddy", author: "a@b.com", repoUrl: "git@x", branch: "main", hostname: "host", directory: "/tmp/demo" },
    );
    expect(ev).toMatchObject({
      type: "session.created",
      session_id: "s1",
      agent: "codebuddy",
      provider: "anthropic",
      model: "claude-sonnet-4",
      user_email: "a@b.com",
      repo_url: "git@x",
      branch: "main",
    });
  });

  it("maps SessionStart resume to session.compacted", () => {
    const ev = transformSessionResume({
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "resume",
    }, "workbuddy");
    expect(ev).toMatchObject({ type: "session.compacted", agent: "workbuddy", session_id: "s1" });
  });

  it("maps UserPromptSubmit to user message", () => {
    const ev = transformUserPrompt({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
      model: "claude-opus-4",
    }, "claude");
    expect(ev).toMatchObject({
      type: "message",
      role: "user",
      content: "hello",
      session_id: "s1",
      provider: "anthropic",
    });
    expect("agent" in ev).toBe(false);
  });

  it("maps PostToolUse to tool.result with agent", () => {
    const ev = transformPostToolUse({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_use_id: "toolu_1",
      tool_input: { url: "https://example.com" },
      tool_response: { output: "ok" },
    }, "codebuddy");
    expect(ev).toMatchObject({
      type: "tool.result",
      agent: "codebuddy",
      tool_name: "WebFetch",
      call_id: "toolu_1",
    });
    expect(ev.output_text).toContain("ok");
  });

  it("maps Stop to session.idle and optional assistant fallback", () => {
    const events = transformStop({
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "done",
      model: "claude-sonnet-4",
    }, "claude");
    expect(events[0]).toMatchObject({ type: "session.idle", agent: "claude" });
    expect(events[1]).toMatchObject({ type: "message", role: "assistant", content: "done" });
  });

  it("does not map Interrupted by user Stop fallback to assistant message", () => {
    const events = transformStop({
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Interrupted by user",
      model: "unknown",
    }, "workbuddy");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session.idle" });
  });

  it("maps Interrupted Stop fallback to turn.error without unknown assistant", () => {
    const ev = transformStopAbortFallback({
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Interrupted by user",
      model: "kimi-k2.7-ioa",
    }, "workbuddy");
    expect(ev).toMatchObject({
      type: "turn.error",
      finish_reason: "aborted",
      error: "aborted",
      model: "kimi-k2.7-ioa",
      provider: "moonshot",
    });
    expect(transformStopAbortFallback({
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "hello",
    }, "workbuddy")).toBeNull();
  });

  it("maps StopFailure to turn.error", () => {
    const ev = transformStopFailure({
      session_id: "s1",
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429",
      last_assistant_message: "API Error: Rate limit reached",
      model: "claude-sonnet-4",
    }, "claude");
    expect(ev).toMatchObject({
      type: "turn.error",
      session_id: "s1",
      finish_reason: "rate_limit",
      provider: "anthropic",
    });
    expect(ev.error).toContain("rate_limit");
    expect(ev.error).toContain("429");
  });

  it("detects interrupt assistant text", () => {
    expect(isInterruptAssistantText("Interrupted by user")).toBe(true);
    expect(isInterruptAssistantText("Interrupted by user.")).toBe(true);
    expect(isInterruptAssistantText("hello")).toBe(false);
  });
});
