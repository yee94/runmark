import { describe, expect, it } from "bun:test";
import type { IngestEvent } from "@agent-tracker/shared";
import {
  collectCodeBuddyIdeTranscriptEvents,
  collectTranscriptEventsForStop,
  hasTerminalTurn,
  isCodeBuddyIdeTranscriptPath,
  orderIdeEventsForIngest,
  shouldDebounceCodeBuddyIde,
} from "../src/strategies/codebuddy-ide";

describe("codebuddy-ide strategy", () => {
  it("detects IDE index.json path only", () => {
    expect(isCodeBuddyIdeTranscriptPath("/x/history/s/index.json")).toBe(true);
    expect(isCodeBuddyIdeTranscriptPath("/x/projects/s.jsonl")).toBe(false);
    expect(isCodeBuddyIdeTranscriptPath(null)).toBe(false);
  });

  it("debounces only for codebuddy + index.json (not claude/workbuddy)", () => {
    expect(shouldDebounceCodeBuddyIde("codebuddy", "/x/history/s/index.json")).toBe(true);
    expect(shouldDebounceCodeBuddyIde("codebuddy", "/x/projects/s.jsonl")).toBe(false);
    expect(shouldDebounceCodeBuddyIde("claude", "/x/history/s/index.json")).toBe(false);
    expect(shouldDebounceCodeBuddyIde("workbuddy", "/x/history/s/index.json")).toBe(false);
  });

  it("treats turn.error as terminal (Abort)", () => {
    expect(hasTerminalTurn([{ type: "turn.error" } as IngestEvent])).toBe(true);
    expect(hasTerminalTurn([{ type: "turn.completed" } as IngestEvent])).toBe(true);
    expect(hasTerminalTurn([{ type: "message" } as IngestEvent])).toBe(false);
  });

  it("orders assistant message before turn in the same batch", () => {
    const ordered = orderIdeEventsForIngest([
      { type: "turn.completed" } as IngestEvent,
      { type: "message", role: "assistant" } as IngestEvent,
      { type: "session.idle" } as IngestEvent,
    ]);
    expect(ordered.map((e) => e.type)).toEqual(["message", "turn.completed", "session.idle"]);
  });

  it("debounces until turn is ready, then emits assistant + turn together", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const events = await collectCodeBuddyIdeTranscriptEvents({
      sessionId: "s1",
      transcriptPath: "/tmp/index.json",
      delaysMs: [10, 20, 30],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      parseOnce: () => {
        calls += 1;
        // 未就绪：解析侧按住，返回空；就绪后同批 message + turn
        if (calls < 3) return [];
        return [
          { type: "turn.completed" } as IngestEvent,
          { type: "message", role: "assistant" } as IngestEvent,
        ];
      },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    // assistant 在 turn 前
    expect(events.map((e) => e.type)).toEqual(["message", "turn.completed"]);
  });

  it("does not flush assistant alone when turn never arrives", async () => {
    let onceCalls = 0;
    const events = await collectCodeBuddyIdeTranscriptEvents({
      sessionId: "s1",
      transcriptPath: "/tmp/index.json",
      delaysMs: [5, 5],
      sleep: async () => {},
      parseOnce: () => {
        onceCalls += 1;
        return [];
      },
    });
    expect(onceCalls).toBe(3);
    expect(events).toEqual([]);
  });

  it("CLI jsonl path does not sleep-retry", async () => {
    let calls = 0;
    const events = await collectTranscriptEventsForStop({
      sessionId: "s1",
      agent: "codebuddy",
      transcriptPath: "/tmp/session.jsonl",
      sleep: async () => {
        throw new Error("should not sleep for CLI");
      },
      parseOnce: () => {
        calls += 1;
        return [{ type: "message", role: "user" } as IngestEvent];
      },
    });
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("workbuddy/claude never debounce even if path looks like index.json", async () => {
    for (const agent of ["workbuddy", "claude"] as const) {
      let calls = 0;
      await collectTranscriptEventsForStop({
        sessionId: "s1",
        agent,
        transcriptPath: "/tmp/history/s/index.json",
        sleep: async () => {
          throw new Error(`should not sleep for ${agent}`);
        },
        parseOnce: () => {
          calls += 1;
          return [];
        },
      });
      expect(calls).toBe(1);
    }
  });
});
