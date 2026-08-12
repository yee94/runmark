import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGrokSessionEvents, ticksToUsd, resolveGrokSessionDir } from "../src/session";

const ROOT = join(tmpdir(), `runmark-grok-test-${process.pid}`);

function setupSession(sessionId: string, cwd: string) {
  const encoded = encodeURIComponent(cwd);
  const sessionDir = join(ROOT, "sessions", encoded, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd },
      session_summary: "Test session",
      generated_title: "Test session",
      current_model_id: "grok-4.5",
      git_remotes: ["https://github.com/acme/app.git"],
      head_branch: "main",
      agent_name: "grok-build",
      reasoning_effort: "high",
    }),
  );
  return sessionDir;
}

describe("ticksToUsd", () => {
  it("converts 1e9 ticks to 1 USD", () => {
    expect(ticksToUsd(1_000_000_000)).toBe(1);
    expect(ticksToUsd(1_801_068_000)).toBeCloseTo(1.801068, 5);
    expect(ticksToUsd(undefined)).toBeUndefined();
  });
});

describe("parseGrokSessionEvents", () => {
  const sessionId = "019f8e21-test-session";
  const cwd = "/tmp/runmark-grok-proj";
  let sessionDir: string;
  let stateDir: string;

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    sessionDir = setupSession(sessionId, cwd);
    stateDir = join(ROOT, "state");
    mkdirSync(stateDir, { recursive: true });

    writeFileSync(
      join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: "<user_query>\nhello world\n</user_query>" }],
          prompt_index: 0,
        }),
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: "<system-reminder>ignore</system-reminder>" }],
          synthetic_reason: "system_reminder",
        }),
        JSON.stringify({
          type: "assistant",
          content: "I will help.",
          model_id: "grok-4.5-build",
          tool_calls: [
            {
              id: "call-1",
              name: "search_replace",
              arguments: JSON.stringify({ path: "a.ts" }),
            },
            {
              id: "call-2",
              name: "read_file",
              arguments: JSON.stringify({ target_file: "b.ts" }),
            },
          ],
        }),
      ].join("\n") + "\n",
    );

    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        // 噪声：_meta.totalTokens 不应被当成计费 turn
        JSON.stringify({
          timestamp: 0,
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
          },
          _meta: { totalTokens: 99999 },
        }),
        // 权威：turn_completed + usage + costUsdTicks（每轮独立，非累计）
        JSON.stringify({
          timestamp: 1,
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "turn_completed",
              prompt_id: "prompt-1",
              usage: {
                inputTokens: 1000,
                outputTokens: 100,
                totalTokens: 1100,
                cachedReadTokens: 200,
                reasoningTokens: 50,
                costUsdTicks: 500_000_000,
                modelUsage: { "grok-4.5-build": {} },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: 2,
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "turn_completed",
              prompt_id: "prompt-2",
              usage: {
                inputTokens: 2000,
                outputTokens: 50,
                totalTokens: 2050,
                cachedReadTokens: 1000,
                reasoningTokens: 10,
                costUsdTicks: 250_000_000,
                modelUsage: { "grok-4.5-build": {} },
              },
            },
          },
        }),
      ].join("\n") + "\n",
    );

    writeFileSync(
      join(sessionDir, "events.jsonl"),
      JSON.stringify({
        ts: "2026-07-23T00:00:00Z",
        type: "tool_completed",
        tool_name: "search_replace",
        duration_ms: 15,
        outcome: "success",
        tool_call_id: "call-1",
      }) + "\n",
    );
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("resolves session dir under encoded cwd", () => {
    const dir = resolveGrokSessionDir(
      { sessionId, cwd },
      { grokHome: ROOT },
    );
    expect(dir).toBe(sessionDir);
  });

  it("parses messages, tools, and turn.completed with cost", () => {
    const events = parseGrokSessionEvents({
      input: { sessionId, cwd },
      grokHome: ROOT,
      stateDir,
      sessionDir,
    });

    expect(events.some((e) => e.type === "session.updated")).toBe(true);

    const user = events.find((e) => e.type === "message" && e.role === "user");
    expect(user).toMatchObject({ content: "hello world" });

    const assistant = events.find((e) => e.type === "message" && e.role === "assistant");
    expect(assistant).toMatchObject({
      content: "I will help.",
      model: "grok-4.5-build",
    });

    // read_file 应被 skip；search_replace 应上报
    const tools = events.filter((e) => e.type === "tool.result");
    expect(tools.some((t) => t.tool_name === "search_replace")).toBe(true);
    expect(tools.some((t) => t.tool_name === "read_file")).toBe(false);

    const turns = events.filter((e) => e.type === "turn.completed");
    expect(turns.length).toBe(2);
    const turn = turns[0];
    expect(turn).toBeTruthy();
    if (turn && turn.type === "turn.completed") {
      expect(turn.output_tokens).toBe(100);
      expect(turn.cache_read_tokens).toBe(200);
      expect(turn.reasoning_tokens).toBe(50);
      expect(turn.cost_usd).toBeCloseTo(0.5, 5);
      expect(turn.provider).toBe("xai");
      expect(turn.turn_id).toContain("prompt-1");
    }
    const turn2 = turns[1];
    if (turn2 && turn2.type === "turn.completed") {
      expect(turn2.cost_usd).toBeCloseTo(0.25, 5);
      expect(turn2.output_tokens).toBe(50);
    }
  });

  it("is idempotent on second parse (offset state)", () => {
    const first = parseGrokSessionEvents({
      input: { sessionId, cwd },
      grokHome: ROOT,
      stateDir,
      sessionDir,
    });
    expect(first.length).toBeGreaterThan(0);

    const second = parseGrokSessionEvents({
      input: { sessionId, cwd },
      grokHome: ROOT,
      stateDir,
      sessionDir,
    });
    // 第二次只可能有 session.updated，不应再有新 message / turn
    expect(second.filter((e) => e.type === "message").length).toBe(0);
    expect(second.filter((e) => e.type === "turn.completed").length).toBe(0);
  });

  it("ignores _meta.totalTokens-only snapshots", () => {
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      JSON.stringify({
        timestamp: 1,
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk" },
        },
        _meta: { totalTokens: 42424 },
      }) + "\n",
    );
    // 清空其它消息文件避免干扰
    writeFileSync(join(sessionDir, "chat_history.jsonl"), "");
    writeFileSync(join(sessionDir, "events.jsonl"), "");

    const events = parseGrokSessionEvents({
      input: { sessionId, cwd },
      grokHome: ROOT,
      stateDir: join(ROOT, "state-meta-only"),
      sessionDir,
    });
    expect(events.filter((e) => e.type === "turn.completed").length).toBe(0);
  });
});
