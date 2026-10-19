import { describe, expect, it } from "bun:test";
import type { IngestEvent } from "@agent-tracker/shared";
import type { ServerConfig } from "../src/config";
import { AgentThrottleScheduler, parseSchedule, parseThrottleMs } from "../src/services/agentScheduler";
import { AgentRunBusyError, type AgentRuntime } from "../src/services/agents";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function testConfig(): ServerConfig {
  return {
    port: 3456,
    apiKey: "test-key",
    dbPath: ":memory:",
    publicDir: "./public",
    publicDashboard: true,
    extraApiKeys: [],
    debug: false,
    logFile: "",
    cursorSyncEnabled: false,
    cursorApiKey: "test-key",
    llmBaseUrl: "https://api.example.com/v1/chat/completions",
    llmApiKey: "ac:test",
    llmModel: "deepseek_v4_flash_code",
    agentThrottleMs: 80,
    agentAutoRunEnabled: true,
    updateEnabled: false,
    updateManifestUrl: "",
    updateScript: "/opt/runmark-updater/update.sh",
    updateStatePath: "/opt/runmark-updater/update-state.json",
  };
}

function messageEvent(sessionId: string, messageId: string): IngestEvent {
  return {
    type: "message",
    session_id: sessionId,
    message_id: messageId,
    role: "user",
    content: "hello",
    created_at: "2026-07-08T00:00:00.000Z",
  };
}

describe("parseThrottleMs", () => {
  it("parses duration suffixes and falls back when invalid", () => {
    expect(parseThrottleMs("1m", 30)).toBe(60_000);
    expect(parseThrottleMs("10m", 30)).toBe(600_000);
    expect(parseThrottleMs("30s", 30)).toBe(30_000);
    expect(parseThrottleMs("500ms", 30)).toBe(500);
    expect(parseThrottleMs("250", 30)).toBe(250);
    expect(parseThrottleMs("", 30)).toBe(30);
    expect(parseThrottleMs("bad", 30)).toBe(30);
  });
});

describe("parseSchedule", () => {
  it("parses the scheduling mechanism, optional session scope, and duration", () => {
    expect(parseSchedule("debounce:1m", 30)).toEqual({ mode: "debounce", scope: "agent", waitMs: 60_000, waitRaw: "1m" });
    expect(parseSchedule("throttle:250ms", 30)).toEqual({ mode: "throttle", scope: "agent", waitMs: 250, waitRaw: "250ms" });
    expect(parseSchedule("session:debounce:1m", 30)).toEqual({ mode: "debounce", scope: "session", waitMs: 60_000, waitRaw: "1m" });
    expect(parseSchedule("debounce:session:1m", 30)).toEqual({ mode: "debounce", scope: "session", waitMs: 60_000, waitRaw: "1m" });
    expect(parseSchedule("session:1m:debounce", 30)).toEqual({ mode: "debounce", scope: "session", waitMs: 60_000, waitRaw: "1m" });
    expect(parseSchedule("invalid", 30)).toEqual({ mode: "throttle", scope: "agent", waitMs: 30, waitRaw: null });
  });
});

describe("AgentThrottleScheduler", () => {
  it("uses one fixed throttle window per enabled chat-event agent without delaying on later events", async () => {
    const calls: Array<{ agentId: string; sessionId?: string; sessionIds?: string[]; reason?: string }> = [];
    const runtime = {
      listAgents: () => [
        {
          id: "agent-a",
          enabled: true,
          triggers: [{ id: "chat_event", enabled: true }],
        },
        {
          id: "agent-b",
          enabled: true,
          triggers: [{ id: "chat_event", enabled: true }],
        },
      ],
      runAgent: async (agentId: string, input: any) => {
        calls.push({ agentId, sessionId: input.session_id, sessionIds: input.session_ids, reason: input.run_reason });
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-1", "m-1")]);
    await wait(50);
    scheduler.scheduleAfterIngest([messageEvent("s-2", "m-2")]);
    await wait(50);

    expect(calls).toEqual([
      { agentId: "agent-a", sessionId: undefined, sessionIds: ["s-1", "s-2"], reason: "throttled_chat_event" },
      { agentId: "agent-b", sessionId: undefined, sessionIds: ["s-1", "s-2"], reason: "throttled_chat_event" },
    ]);

    scheduler.scheduleAfterIngest([messageEvent("s-3", "m-3")]);
    await wait(100);
    expect(calls.slice(2)).toEqual([
      { agentId: "agent-a", sessionId: undefined, sessionIds: ["s-3"], reason: "throttled_chat_event" },
      { agentId: "agent-b", sessionId: undefined, sessionIds: ["s-3"], reason: "throttled_chat_event" },
    ]);
  });

  it("uses the trigger schedule instead of global agentThrottleMs", async () => {
    const calls: string[] = [];
    const runtime = {
      listAgents: () => [
        {
          id: "agent-fast",
          enabled: true,
          triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:40ms" }],
        },
        {
          id: "agent-slow",
          enabled: true,
          triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:120ms" }],
        },
      ],
      runAgent: async (agentId: string) => {
        calls.push(agentId);
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-1", "m-1")]);
    await wait(70);
    expect(calls).toEqual(["agent-fast"]);
    await wait(80);
    expect(calls).toEqual(["agent-fast", "agent-slow"]);
  });

  it("resets the debounce window when later chat events arrive", async () => {
    const calls: Array<{ sessionIds: string[]; reason: string }> = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-summary",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "debounce:60ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push({ sessionIds: input.session_ids, reason: input.run_reason });
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-1", "m-1")]);
    await wait(40);
    scheduler.scheduleAfterIngest([messageEvent("s-2", "m-2")]);
    await wait(35);
    expect(calls).toEqual([]);
    await wait(40);

    expect(calls).toEqual([{ sessionIds: ["s-1", "s-2"], reason: "debounced_chat_event" }]);
  });

  it("debounces each session independently when schedule uses session scope", async () => {
    const calls: Array<{ sessionIds: string[]; reason: string }> = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-summary",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "session:debounce:60ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push({ sessionIds: input.session_ids, reason: input.run_reason });
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    // s-1 先到；约 40ms 后 s-2 到达。全局 debounce 会把 s-1 一起重置；session 级应让 s-1 先到时先跑
    scheduler.scheduleAfterIngest([messageEvent("s-1", "m-1")]);
    await wait(40);
    scheduler.scheduleAfterIngest([messageEvent("s-2", "m-2")]);
    await wait(35);
    expect(calls).toEqual([{ sessionIds: ["s-1"], reason: "debounced_chat_event" }]);
    await wait(40);
    expect(calls).toEqual([
      { sessionIds: ["s-1"], reason: "debounced_chat_event" },
      { sessionIds: ["s-2"], reason: "debounced_chat_event" },
    ]);
  });

  it("accepts debounce:session:duration token order for session-scoped debounce", async () => {
    const calls: string[][] = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-summary",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "debounce:session:40ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-a", "m-1")]);
    await wait(20);
    scheduler.scheduleAfterIngest([messageEvent("s-a", "m-2")]);
    await wait(25);
    expect(calls).toEqual([]);
    await wait(30);
    expect(calls).toEqual([["s-a"]]);
  });

  it("keeps one in-flight run and merges events that arrive during a long-running batch", async () => {
    const calls: string[][] = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;
    let releaseFirstRun!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const runtime = {
      listAgents: () => [{
        id: "agent-slow",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:20ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        activeRuns++;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        try {
          if (calls.length === 1) await firstRun;
          return {};
        } finally {
          activeRuns--;
        }
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-1", "m-1")]);
    await wait(35);
    scheduler.scheduleAfterIngest([messageEvent("s-2", "m-2")]);
    scheduler.scheduleAfterIngest([messageEvent("s-2", "m-3"), messageEvent("s-3", "m-4")]);
    await wait(50);

    expect(calls).toEqual([["s-1"]]);
    expect(maxActiveRuns).toBe(1);

    releaseFirstRun();
    await wait(30);
    expect(calls).toEqual([["s-1"], ["s-2", "s-3"]]);
    expect(maxActiveRuns).toBe(1);
  });

  it("retries session-scoped ready sessions after busy without spinning", async () => {
    const calls: string[][] = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-busy",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "session:debounce:20ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        if (calls.length === 1) throw new AgentRunBusyError("agent-busy");
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-busy", "m-busy")]);
    await wait(40);
    expect(calls).toEqual([["s-busy"]]);
    await wait(80);
    expect(calls).toEqual([["s-busy"]]);
    await wait(250);
    expect(calls).toEqual([["s-busy"], ["s-busy"]]);
  });

  it("does not tight-loop when a session-scoped agent stays busy", async () => {
    const calls: string[][] = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-busy",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "session:debounce:10ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        throw new AgentRunBusyError("agent-busy");
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-busy", "m-busy")]);
    await wait(80);
    expect(calls.length).toBe(1);
  });

  it("requeues a throttled batch when another entry point is already running the agent", async () => {
    const calls: string[][] = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-busy",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:20ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        if (calls.length === 1) throw new AgentRunBusyError("agent-busy");
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-busy", "m-busy")]);
    await wait(55);

    expect(calls).toEqual([["s-busy"], ["s-busy"]]);
  });

  it("releases scheduler state after a failed run so later events can proceed", async () => {
    const calls: string[][] = [];
    const runtime = {
      listAgents: () => [{
        id: "agent-failure",
        enabled: true,
        triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:20ms" }],
      }],
      runAgent: async (_agentId: string, input: any) => {
        calls.push(input.session_ids);
        if (calls.length === 1) throw new Error("simulated failure");
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([messageEvent("s-failed", "m-failed")]);
    await wait(30);
    scheduler.scheduleAfterIngest([messageEvent("s-after-failure", "m-after-failure")]);
    await wait(30);

    expect(calls).toEqual([["s-failed"], ["s-after-failure"]]);
  });

  it("ignores session.created / tool.result-only ingest for chat_event scheduling", async () => {
    const calls: string[] = [];
    const runtime = {
      listAgents: () => [
        {
          id: "agent-summary",
          enabled: true,
          triggers: [{ id: "chat_event", enabled: true, schedule: "throttle:20ms" }],
        },
      ],
      runAgent: async (agentId: string) => {
        calls.push(agentId);
        return {};
      },
    } as unknown as AgentRuntime;
    const scheduler = new AgentThrottleScheduler(runtime, testConfig());

    scheduler.scheduleAfterIngest([
      { type: "session.created", session_id: "empty-1", agent: "cursor" },
      {
        type: "tool.result",
        session_id: "empty-1",
        agent: "cursor",
        tool_name: "Shell",
        call_id: "t1",
        duration_ms: 0,
        created_at: "2026-07-09T00:00:00.000Z",
      },
    ]);
    await wait(40);
    expect(calls).toEqual([]);

    scheduler.scheduleAfterIngest([messageEvent("empty-1", "m-1")]);
    await wait(40);
    expect(calls).toEqual(["agent-summary"]);
  });
});
