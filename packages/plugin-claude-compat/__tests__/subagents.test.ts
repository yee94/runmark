import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSubagentEvents,
  isSubagentTranscriptPath,
  listCodeBuddySubagentTranscripts,
  parentSessionIdFromSubagentPath,
  sessionIdFromTranscriptPath,
  findSubagentOwningCallId,
  resolvePostToolUseTarget,
} from "../src/subagents";

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("subagent path helpers", () => {
  it("detects /subagents/ segment and parent uuid", () => {
    const child =
      "/Users/x/.codebuddy/projects/demo/parent-uuid/subagents/child-uuid.jsonl";
    expect(isSubagentTranscriptPath(child)).toBe(true);
    expect(parentSessionIdFromSubagentPath(child)).toBe("parent-uuid");
    expect(sessionIdFromTranscriptPath(child)).toBe("child-uuid");

    expect(
      isSubagentTranscriptPath("/Users/x/.codebuddy/projects/demo/parent-uuid.jsonl"),
    ).toBe(false);
    expect(
      parentSessionIdFromSubagentPath("/Users/x/.codebuddy/projects/demo/parent-uuid.jsonl"),
    ).toBeUndefined();
  });

  it("lists …/<parentId>/subagents/*.jsonl beside parent transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-sub-"));
    try {
      const parentPath = join(root, "parent-abc.jsonl");
      writeFileSync(parentPath, "{}\n");
      const subDir = join(root, "parent-abc", "subagents");
      mkdirSync(subDir, { recursive: true });
      const childA = join(subDir, "child-a.jsonl");
      const childB = join(subDir, "child-b.jsonl");
      writeFileSync(childA, "{}\n");
      writeFileSync(childB, "{}\n");
      writeFileSync(join(subDir, "notes.txt"), "ignore");

      expect(listCodeBuddySubagentTranscripts(parentPath)).toEqual([childA, childB].sort());
      expect(listCodeBuddySubagentTranscripts(join(root, "missing.jsonl"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectSubagentEvents", () => {
  it("emits session.created with parent_session_id and parses child CLI rows", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-sub-collect-"));
    const stateDir = join(root, "state");
    try {
      const parentId = "parent-sess";
      const childId = "child-sess";
      const parentPath = join(root, `${parentId}.jsonl`);
      writeFileSync(parentPath, "\n");
      const childPath = join(root, parentId, "subagents", `${childId}.jsonl`);
      writeJsonl(childPath, [
        {
          id: "u-child",
          timestamp: 1_000,
          type: "message",
          role: "user",
          content: [{ type: "text", text: "explore" }],
          sessionId: childId,
        },
        {
          id: "fc-child",
          timestamp: 2_000,
          type: "function_call",
          callId: "call_child_1",
          name: "Bash",
          arguments: JSON.stringify({ command: "pwd" }),
          providerData: {
            model: "claude-sonnet-4",
            rawUsage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
              prompt_cache_hit_tokens: 0,
            },
          },
          sessionId: childId,
        },
        {
          id: "fcr-child",
          timestamp: 3_000,
          type: "function_call_result",
          callId: "call_child_1",
          name: "Bash",
          status: "completed",
          output: { type: "text", text: "/tmp" },
          sessionId: childId,
        },
      ]);

      const events = collectSubagentEvents({
        parentSessionId: parentId,
        parentTranscriptPath: parentPath,
        agent: "codebuddy",
        stateDir,
      });

      const created = events.filter((e) => e.type === "session.created");
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        session_id: childId,
        agent: "codebuddy",
        parent_session_id: parentId,
        metadata: { is_subagent: true },
      });

      const childMessages = events.filter(
        (e) => e.type === "message" && e.session_id === childId,
      );
      expect(childMessages.some((e) => e.role === "user")).toBe(true);

      const tools = events.filter((e) => e.type === "tool.result");
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        session_id: childId,
        call_id: "call_child_1",
        tool_name: "Bash",
      });

      const turns = events.filter((e) => e.type === "turn.completed");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ session_id: childId, turn_id: "fc-child" });

      // 二次收集：独立 offset，不应重复 transcript 事件（仍会发 session.created）
      const again = collectSubagentEvents({
        parentSessionId: parentId,
        parentTranscriptPath: parentPath,
        agent: "codebuddy",
        stateDir,
      });
      expect(again.filter((e) => e.type === "session.created")).toHaveLength(1);
      expect(again.filter((e) => e.type === "tool.result")).toHaveLength(0);
      expect(again.filter((e) => e.type === "turn.completed")).toHaveLength(0);
      expect(again.filter((e) => e.type === "message")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips for claude agent; empty when no subagents dir", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-sub-empty-"));
    try {
      const parentPath = join(root, "p.jsonl");
      writeFileSync(parentPath, "\n");
      expect(
        collectSubagentEvents({
          parentSessionId: "p",
          parentTranscriptPath: parentPath,
          agent: "claude",
        }),
      ).toEqual([]);
      expect(
        collectSubagentEvents({
          parentSessionId: "p",
          parentTranscriptPath: parentPath,
          agent: "codebuddy",
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePostToolUseTarget", () => {
  it("keeps parent WebSearch when call_id is not in subagent jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-ptu-keep-"));
    try {
      const parentPath = join(root, "parent-sess.jsonl");
      writeFileSync(parentPath, "\n");
      const childPath = join(root, "parent-sess", "subagents", "child-sess.jsonl");
      writeJsonl(childPath, [
        {
          type: "function_call",
          callId: "tooluse_child_only",
          name: "WebSearch",
        },
      ]);
      expect(
        resolvePostToolUseTarget({
          agent: "codebuddy",
          sessionId: "parent-sess",
          transcriptPath: parentPath,
          callId: "tooluse_parent_search",
        }),
      ).toEqual({ sessionId: "parent-sess", skip: false });
      expect(findSubagentOwningCallId(parentPath, "tooluse_parent_search")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips parent PostToolUse when call_id already exists in subagents jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-ptu-skip-"));
    try {
      const parentPath = join(root, "parent-sess.jsonl");
      writeFileSync(parentPath, "\n");
      const childPath = join(root, "parent-sess", "subagents", "child-sess.jsonl");
      writeJsonl(childPath, [
        {
          type: "function_call",
          callId: "tooluse_6sTmvLRmzOegrVckce0P7c",
          name: "WebSearch",
        },
      ]);
      expect(findSubagentOwningCallId(parentPath, "tooluse_6sTmvLRmzOegrVckce0P7c")).toBe("child-sess");
      expect(
        resolvePostToolUseTarget({
          agent: "codebuddy",
          sessionId: "parent-sess",
          transcriptPath: parentPath,
          callId: "tooluse_6sTmvLRmzOegrVckce0P7c",
        }),
      ).toEqual({ sessionId: "parent-sess", skip: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("remaps PostToolUse session_id when transcript_path is under /subagents/", () => {
    expect(
      resolvePostToolUseTarget({
        agent: "codebuddy",
        sessionId: "parent-sess",
        transcriptPath: "/tmp/proj/parent-sess/subagents/child-sess.jsonl",
        callId: "tooluse_x",
      }),
    ).toEqual({ sessionId: "child-sess", skip: false });
  });

  it("keeps Agent spawn PostToolUse on the parent session", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-tracker-ptu-agent-"));
    try {
      const parentPath = join(root, "parent-sess.jsonl");
      writeFileSync(parentPath, "\n");
      const childPath = join(root, "parent-sess", "subagents", "child-sess.jsonl");
      writeJsonl(childPath, [
        { type: "function_call", callId: "tooluse_child_ws", name: "WebSearch" },
      ]);
      expect(
        resolvePostToolUseTarget({
          agent: "codebuddy",
          sessionId: "parent-sess",
          transcriptPath: parentPath,
          callId: "tooluse_JEJlR1eNsMhMqi0dz5jdvo",
        }),
      ).toEqual({ sessionId: "parent-sess", skip: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not skip for claude", () => {
    expect(
      resolvePostToolUseTarget({
        agent: "claude",
        sessionId: "s1",
        transcriptPath: "/tmp/s1.jsonl",
        callId: "any",
      }),
    ).toEqual({ sessionId: "s1", skip: false });
  });
});
