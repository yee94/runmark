import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCodexModelForServiceTier, parseTranscriptEvents } from "../src/transcript";
import type { CodexHookInput } from "../src/transform";

function writeTranscript(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-tracker-codex-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
  return path;
}

describe("parseTranscriptEvents", () => {
  it("normalizes fast and priority GPT models to their pricing ids", () => {
    expect(normalizeCodexModelForServiceTier("gpt-5.6-terra", "priority")).toBe("gpt-5.6-terra-fast");
    expect(normalizeCodexModelForServiceTier("gpt-5.5", "fast")).toBe("gpt-5.5-fast");
    expect(normalizeCodexModelForServiceTier("gpt-5.6-terra", "default")).toBe("gpt-5.6-terra");
    expect(normalizeCodexModelForServiceTier("claude-opus-4-8", "priority")).toBe("claude-opus-4-8");
  });

  it("applies rollout service tier to transcript turns", () => {
    const path = writeTranscript([
      { type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-terra", service_tier: "priority" } } },
      { type: "turn_context", timestamp: "2026-01-01T00:00:01.000Z", payload: { turn_id: "t1", model: "gpt-5.6-terra" } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "task_complete", turn_id: "t1", completed_at: 1767225603 } },
    ]);

    try {
      const input = { session_id: "s1", hook_event_name: "Stop", transcript_path: path, model: "gpt-5.6-terra", stop_hook_active: false } as CodexHookInput;
      const turns = parseTranscriptEvents(input).filter((event) => event.type === "turn.completed");

      expect(turns[0]).toMatchObject({ model: "gpt-5.6-terra-fast", provider: "openai" });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("uses total_token_usage deltas instead of summing context windows", () => {
    const path = writeTranscript([
      { type: "turn_context", timestamp: "2026-01-01T00:00:00.000Z", payload: { turn_id: "t1", model: "gpt-5.5" } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "task_started", turn_id: "t1", started_at: 1767225600 } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 1_100 }, last_token_usage: { input_tokens: 1_000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 10, total_tokens: 1_100 } } } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "task_complete", turn_id: "t1", completed_at: 1767225602, duration_ms: 2_000 } },
      { type: "turn_context", timestamp: "2026-01-01T00:01:00.000Z", payload: { turn_id: "t2", model: "gpt-5.5" } },
      { type: "event_msg", timestamp: "2026-01-01T00:01:00.000Z", payload: { type: "task_started", turn_id: "t2", started_at: 1767225660 } },
      { type: "event_msg", timestamp: "2026-01-01T00:01:01.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_500, cached_input_tokens: 600, output_tokens: 300, reasoning_output_tokens: 40, total_tokens: 1_800 }, last_token_usage: { input_tokens: 900, cached_input_tokens: 500, output_tokens: 220, reasoning_output_tokens: 35, total_tokens: 1_120 } } } },
      { type: "event_msg", timestamp: "2026-01-01T00:01:02.000Z", payload: { type: "task_complete", turn_id: "t2", completed_at: 1767225662, duration_ms: 2_000 } },
    ]);

    try {
      const input = { session_id: "s1", hook_event_name: "Stop", transcript_path: path, model: "gpt-5.5", stop_hook_active: false } as CodexHookInput;
      const turns = parseTranscriptEvents(input).filter((event) => event.type === "turn.completed");

      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({ input_tokens: 800, cache_read_tokens: 200, output_tokens: 100, reasoning_tokens: 10, total_tokens: 1_100 });
      expect(turns[1]).toMatchObject({ input_tokens: 100, cache_read_tokens: 400, output_tokens: 200, reasoning_tokens: 30, total_tokens: 700 });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses Codex function, custom, and tool-search call outputs", () => {
    const path = writeTranscript([
      { type: "turn_context", timestamp: "2026-01-01T00:00:00.000Z", payload: { turn_id: "t1", model: "gpt-5.5" } },
      { type: "response_item", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "function_call", name: "exec_command", call_id: "call-f", arguments: "{\"cmd\":\"pwd\"}", internal_chat_message_metadata_passthrough: { turn_id: "t1" } } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "function_call_output", call_id: "call-f", output: "ok" } },
      { type: "response_item", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call-c", input: "patch", internal_chat_message_metadata_passthrough: { turn_id: "t1" } } },
      { type: "response_item", timestamp: "2026-01-01T00:00:04.000Z", payload: { type: "custom_tool_call_output", call_id: "call-c", output: [{ type: "input_text", text: "patched" }] } },
      { type: "response_item", timestamp: "2026-01-01T00:00:05.000Z", payload: { type: "tool_search_call", execution: "client", call_id: "call-s", arguments: { query: "x" }, internal_chat_message_metadata_passthrough: { turn_id: "t1" } } },
      { type: "response_item", timestamp: "2026-01-01T00:00:06.000Z", payload: { type: "tool_search_output", call_id: "call-s", output: { text: "found" } } },
    ]);

    try {
      const input = { session_id: "s1", hook_event_name: "Stop", transcript_path: path, model: "gpt-5.5", stop_hook_active: false } as CodexHookInput;
      const tools = parseTranscriptEvents(input).filter((event) => event.type === "tool.result");

      expect(tools).toHaveLength(3);
      expect(tools.map((tool) => tool.tool_name)).toEqual(["exec_command", "apply_patch", "client"]);
      expect(tools.map((tool) => tool.output_text)).toEqual(["ok", "patched", "found"]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
