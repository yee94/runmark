import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscriptEvents } from "../src/transcript";

function writeTranscript(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-tracker-claude-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

/** 构造 CodeBuddy IDE history/index.json + messages/*.json */
function writeIdeHistory(messages: Array<Record<string, unknown>>, requests?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-tracker-cb-ide-"));
  const messagesDir = join(dir, "messages");
  mkdirSync(messagesDir, { recursive: true });
  const indexMessages = messages.map((m) => ({
    id: m.id,
    type: "text",
    role: m.role,
    isComplete: true,
  }));
  for (const m of messages) {
    writeFileSync(join(messagesDir, `${m.id}.json`), JSON.stringify(m));
  }
  const indexPath = join(dir, "index.json");
  writeFileSync(
    indexPath,
    JSON.stringify({
      messages: indexMessages,
      requests: requests ?? [],
    }),
  );
  return indexPath;
}

describe("parseClaudeTranscriptEvents", () => {
  it("extracts assistant message, tool result and turn usage from Claude-style JSONL", () => {
    const path = writeTranscript([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "fix me" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [
            { type: "text", text: "running" },
            { type: "tool_use", id: "toolu_1", name: "WebFetch", input: { url: "https://example.com" } },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "s1",
        agent: "codebuddy",
        transcript_path: path,
      });

      const messages = events.filter((e) => e.type === "message" && e.role === "assistant");
      const tools = events.filter((e) => e.type === "tool.result");
      const turns = events.filter((e) => e.type === "turn.completed");

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ content: "running", model: "claude-sonnet-4", provider: "anthropic" });
      expect(messages[1]).toMatchObject({ content: "done" });
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        agent: "codebuddy",
        tool_name: "WebFetch",
        call_id: "toolu_1",
        output_text: "ok",
      });
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        input_tokens: 90,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        output_tokens: 40,
        total_tokens: 160,
        provider: "anthropic",
        model: "claude-sonnet-4",
      });
      expect(turns[1]).toMatchObject({
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
      });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("skips Read/Write/Bash/Grep tool.result like Cursor", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/a" } },
            { type: "tool_use", id: "toolu_mcp", name: "mcp__foo", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_bash", content: "/tmp" },
            { type: "tool_result", tool_use_id: "toolu_read", content: "file" },
            { type: "tool_result", tool_use_id: "toolu_mcp", content: "mcp-ok" },
          ],
        },
      },
    ]);

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "s1",
        agent: "claude",
        transcript_path: path,
      });
      const tools = events.filter((e) => e.type === "tool.result");
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ tool_name: "mcp__foo", output_text: "mcp-ok" });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses Claude/TClaude native transcript (type=user|assistant + nested message)", () => {
    const path = writeTranscript([
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-09T04:05:00.000Z",
        message: { role: "user", content: "Reply with exactly: CLAUDE_PONG" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-07-09T04:05:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "CLAUDE_PONG" }],
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 1937,
            cache_read_input_tokens: 0,
            output_tokens: 12,
          },
        },
      },
    ]);

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "s-claude",
        agent: "claude",
        transcript_path: path,
        stateDir: join(path, "..", "state-claude"),
      });
      const messages = events.filter((e) => e.type === "message" && e.role === "assistant");
      const turns = events.filter((e) => e.type === "turn.completed");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ content: "CLAUDE_PONG", model: "claude-opus-4-8", provider: "anthropic" });
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        input_tokens: 2,
        cache_write_tokens: 1937,
        output_tokens: 12,
        total_tokens: 1951,
        provider: "anthropic",
      });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses CodeBuddy native transcript (type=message + top-level role/content)", () => {
    const path = writeTranscript([
      {
        id: "u1",
        timestamp: 1783569464506,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly: PONG." }],
        sessionId: "s-cb",
      },
      {
        id: "a1",
        parentId: "u1",
        timestamp: 1783569466292,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "PONG." }],
        providerData: {
          model: "deepseek-v4-flash-ioa",
          rawUsage: {
            prompt_tokens: 6482,
            completion_tokens: 3,
            total_tokens: 6485,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          usage: {
            inputTokens: 6482,
            outputTokens: 3,
            totalTokens: 6485,
          },
        },
        message: {
          usage: {
            input_tokens: 6482,
            output_tokens: 3,
            total_tokens: 6485,
          },
        },
        sessionId: "s-cb",
      },
    ]);

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "s-cb",
        agent: "codebuddy",
        transcript_path: path,
        stateDir: join(path, "..", "state-cb"),
      });
      const messages = events.filter((e) => e.type === "message" && e.role === "assistant");
      const turns = events.filter((e) => e.type === "turn.completed");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ content: "PONG.", model: "deepseek-v4-flash-ioa", provider: "codebuddy" });
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        input_tokens: 6482,
        output_tokens: 3,
        total_tokens: 6485,
        model: "deepseek-v4-flash-ioa",
        provider: "codebuddy",
      });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses CodeBuddy IDE history index.json + messages/*.json", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T04:42:08.595Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "看看本项目" }],
          }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T04:42:12.532Z",
          message: JSON.stringify({
            role: "assistant",
            content: [
              { type: "reasoning", text: "先读文档" },
              {
                type: "tool-call",
                toolCallId: "call_read",
                toolName: "read_file",
                args: { filePath: "/tmp/README.md" },
              },
              {
                type: "tool-call",
                toolCallId: "call_list",
                toolName: "list_dir",
                args: { target_directory: "/tmp/src" },
              },
            ],
          }),
          extra: JSON.stringify({ modelId: "glm-5.2-ioa", modelName: "GLM-5.2" }),
        },
        {
          id: "t1",
          role: "tool",
          createdAt: "2026-07-09T04:42:12.537Z",
          message: JSON.stringify({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_read",
                toolName: "read_file",
                result: { status: "success", result: { type: "read_file_result", truncated: true } },
              },
              {
                type: "tool-result",
                toolCallId: "call_list",
                toolName: "list_dir",
                result: { status: "success", result: { type: "list_files_result", files: [] } },
              },
            ],
          }),
          extra: JSON.stringify({ modelId: "glm-5.2-ioa" }),
        },
        {
          id: "a2",
          role: "assistant",
          createdAt: "2026-07-09T04:42:53.124Z",
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "## 项目概览\n这是后台服务。" }],
          }),
          extra: JSON.stringify({
            modelId: "glm-5.2-ioa",
            modelName: "GLM-5.2",
            lastStepInputTokens: 64117,
            lastStepOutputTokens: 1035,
            lastStepCachedInputTokens: 62656,
            statsSnapshot: { cacheWriteTokens: 0, thinkingTokens: 0, elapsedMs: 42513 },
          }),
        },
      ],
      [
        {
          id: "req1",
          type: "craft",
          messages: ["u1", "a1", "t1", "a2"],
          usage: { inputTokens: 272727, outputTokens: 2001, totalTokens: 274728 },
        },
      ],
    );

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "a73e47aa383044848cc8eaac301bfb19",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir: join(indexPath, "..", "state-ide"),
      });

      const assistants = events.filter((e) => e.type === "message" && e.role === "assistant");
      const tools = events.filter((e) => e.type === "tool.result");
      const turns = events.filter((e) => e.type === "turn.completed");

      expect(assistants.length).toBeGreaterThanOrEqual(1);
      expect(assistants.some((m) => (m as { content?: string }).content?.includes("项目概览"))).toBe(true);
      // read_file / list_dir（≈Glob）均跳过
      expect(tools).toHaveLength(0);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        turn_id: "a2",
        model: "glm-5.2-ioa",
        provider: "zhipu",
        input_tokens: 1461, // 64117 - 62656
        cache_read_tokens: 62656,
        output_tokens: 1035,
        duration_ms: 42513,
      });

      // 增量：再跑一遍不应重复
      const again = parseClaudeTranscriptEvents({
        session_id: "a73e47aa383044848cc8eaac301bfb19",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir: join(indexPath, "..", "state-ide"),
      });
      expect(again).toHaveLength(0);
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("emits turn.error when CodeBuddy IDE marks assistant isCancelled", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T06:00:00.000Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "run something long" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T06:00:05.000Z",
          // Abort 时常无正文
          message: JSON.stringify({ role: "assistant", content: [] }),
          extra: JSON.stringify({
            modelId: "hy3-ioa",
            modelName: "Hy3",
            isCancelled: true,
          }),
        },
      ],
      [
        {
          id: "req1",
          type: "craft",
          messages: ["u1", "a1"],
          state: "complete",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ],
    );

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "s-abort",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir: join(indexPath, "..", "state-abort"),
      });
      const errors = events.filter((e) => e.type === "turn.error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        turn_id: "a1",
        error: "aborted",
        finish_reason: "aborted",
        model: "hy3-ioa",
      });
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);

      // 增量不应重复
      expect(
        parseClaudeTranscriptEvents({
          session_id: "s-abort",
          agent: "codebuddy",
          transcript_path: indexPath,
          stateDir: join(indexPath, "..", "state-abort"),
        }),
      ).toHaveLength(0);
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("debounces: holds assistant until isCancelled, then emits message + turn.error together", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T06:10:00.000Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "hi" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T06:10:01.000Z",
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "partial..." }],
          }),
          // 首轮 Stop：尚未标记取消 → 按住，不上报回复
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
      ],
      [],
    );
    const stateDir = join(indexPath, "..", "state-late-abort");
    const messagesDir = join(indexPath, "..", "messages");

    try {
      const first = parseClaudeTranscriptEvents({
        session_id: "s-late-abort",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(first).toHaveLength(0);

      writeFileSync(
        join(messagesDir, "a1.json"),
        JSON.stringify({
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T06:10:01.000Z",
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "partial..." }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa", isCancelled: true }),
        }),
      );

      const second = parseClaudeTranscriptEvents({
        session_id: "s-late-abort",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(second.map((e) => e.type)).toEqual(["message", "turn.error"]);
      expect(second[1]).toMatchObject({ error: "aborted", turn_id: "a1" });
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("debounces: holds assistant until lastStep*, then emits message + turn together", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T04:54:03.778Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "oo 这下好了" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T04:54:21.278Z",
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "明白了，确实是 bug。" }],
          }),
          // 首轮 Stop：正文已落盘，但 lastStep* 尚未写入 → 按住
          extra: JSON.stringify({ modelId: "hy3-ioa", modelName: "Hy3" }),
        },
      ],
      [
        {
          id: "req1",
          type: "craft",
          messages: ["u1", "a1"],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ],
    );

    const stateDir = join(indexPath, "..", "state-late");
    try {
      const first = parseClaudeTranscriptEvents({
        session_id: "s-late",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(first).toHaveLength(0);

      // 模拟 CodeBuddy 稍后补写 token
      const msgPath = join(indexPath, "..", "messages", "a1.json");
      const record = JSON.parse(readFileSync(msgPath, "utf-8"));
      record.extra = JSON.stringify({
        modelId: "hy3-ioa",
        modelName: "Hy3",
        lastStepInputTokens: 63618,
        lastStepOutputTokens: 872,
        lastStepCachedInputTokens: 0,
        statsSnapshot: { cacheWriteTokens: 0, thinkingTokens: 0, elapsedMs: 8621 },
      });
      writeFileSync(msgPath, JSON.stringify(record));

      const second = parseClaudeTranscriptEvents({
        session_id: "s-late",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(second.map((e) => e.type)).toEqual(["message", "turn.completed"]);
      expect(second[1]).toMatchObject({
        turn_id: "a1",
        model: "hy3-ioa",
        input_tokens: 63618,
        output_tokens: 872,
        duration_ms: 8621,
      });

      const third = parseClaudeTranscriptEvents({
        session_id: "s-late",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(third).toHaveLength(0);
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("flushHeldAssistants emits assistant without turn after debounce hold", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T06:17:48.000Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "Hey 你好" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T06:18:00.000Z",
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }],
          }),
          // 尚无 lastStep* —— 正常 Debounce 会按住
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
      ],
      [],
    );
    const stateDir = join(indexPath, "..", "state-flush");
    try {
      expect(
        parseClaudeTranscriptEvents({
          session_id: "s-flush",
          agent: "codebuddy",
          transcript_path: indexPath,
          stateDir,
        }),
      ).toHaveLength(0);

      const flushed = parseClaudeTranscriptEvents({
        session_id: "s-flush",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
        flushHeldAssistants: true,
      });
      expect(flushed.filter((e) => e.type === "message" && e.role === "assistant")).toHaveLength(1);
      expect(flushed.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("debounces: request.usage can unlock last assistant with message + turn", () => {
    const indexPath = writeIdeHistory(
      [
        {
          id: "u1",
          role: "user",
          createdAt: "2026-07-09T05:53:52.225Z",
          message: JSON.stringify({
            role: "user",
            content: [{ type: "text", text: "xixi" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa" }),
        },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-07-09T05:53:56.611Z",
          // 第一次 Stop：只有正文，尚无 lastStep*
          message: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "你好！" }],
          }),
          extra: JSON.stringify({ modelId: "hy3-ioa", modelName: "HY3" }),
        },
      ],
      [],
    );
    const stateDir = join(indexPath, "..", "state-late");

    try {
      const first = parseClaudeTranscriptEvents({
        session_id: "s-late",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(first).toHaveLength(0);

      // 仅 index.requests.usage 到位（无 lastStep*）也可解封末条 assistant
      writeFileSync(
        indexPath,
        JSON.stringify({
          messages: [
            { id: "u1", type: "text", role: "user", isComplete: true },
            { id: "a1", type: "text", role: "assistant", isComplete: true },
          ],
          requests: [
            {
              id: "req1",
              messages: ["u1", "a1"],
              usage: { inputTokens: 26642, outputTokens: 110, totalTokens: 26752 },
            },
          ],
        }),
      );

      const second = parseClaudeTranscriptEvents({
        session_id: "s-late",
        agent: "codebuddy",
        transcript_path: indexPath,
        stateDir,
      });
      expect(second.map((e) => e.type)).toEqual(["message", "turn.completed"]);
      expect(second[1]).toMatchObject({
        turn_id: "a1",
        model: "hy3-ioa",
        output_tokens: 110,
        total_tokens: 26752,
      });
      expect(
        parseClaudeTranscriptEvents({
          session_id: "s-late",
          agent: "codebuddy",
          transcript_path: indexPath,
          stateDir,
        }),
      ).toHaveLength(0);
    } finally {
      rmSync(join(indexPath, ".."), { recursive: true, force: true });
    }
  });

  it("supports incremental offset so Stop can re-run without duplicating turns", () => {
    const path = writeTranscript([
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "one" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    try {
      const first = parseClaudeTranscriptEvents({
        session_id: "s1",
        agent: "claude",
        transcript_path: path,
        stateDir: join(path, "..", "state"),
      });
      expect(first.filter((e) => e.type === "turn.completed")).toHaveLength(1);

      writeFileSync(
        path,
        [
          JSON.stringify({
            type: "assistant",
            uuid: "a1",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4",
              content: [{ type: "text", text: "one" }],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "a2",
            timestamp: "2026-01-01T00:00:02.000Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4",
              content: [{ type: "text", text: "two" }],
              usage: { input_tokens: 12, output_tokens: 6 },
            },
          }),
        ].join("\n") + "\n",
      );

      const second = parseClaudeTranscriptEvents({
        session_id: "s1",
        agent: "claude",
        transcript_path: path,
        stateDir: join(path, "..", "state"),
      });
      const turns = second.filter((e) => e.type === "turn.completed");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ output_tokens: 6, total_tokens: 18 });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("WorkBuddy Abort: isPartialAborted + Interrupted marker → turn.error, no unknown assistant", () => {
    const path = writeTranscript([
      {
        type: "message",
        role: "user",
        id: "u1",
        timestamp: 1_000,
        content: [{ type: "input_text", text: "看看本项目，我会测试 Abort 功能" }],
        sessionId: "wb-abort",
      },
      {
        type: "message",
        role: "assistant",
        id: "a1",
        timestamp: 2_000,
        status: "incomplete",
        content: [{ type: "output_text", text: "我先看一下项目结构，然后定位 Abort 相关的部分。" }],
        providerData: {
          model: "kimi-k2.7-ioa",
          requestModelId: "kimi-k2.7-ioa",
          isPartialAborted: true,
          agent: "cli",
        },
        sessionId: "wb-abort",
      },
      {
        type: "message",
        role: "assistant",
        id: "a-interrupt",
        timestamp: 3_000,
        status: "incomplete",
        content: [{ type: "output_text", text: "Interrupted by user" }],
        providerData: {
          skipRun: true,
          error: { message: "Interrupted by user" },
          agent: "cli",
        },
        sessionId: "wb-abort",
      },
    ]);

    try {
      const events = parseClaudeTranscriptEvents({
        session_id: "wb-abort",
        agent: "workbuddy",
        transcript_path: path,
        stateDir: join(path, "..", "state-wb-abort"),
      });

      const assistants = events.filter((e) => e.type === "message" && e.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0]).toMatchObject({
        content: "我先看一下项目结构，然后定位 Abort 相关的部分。",
        model: "kimi-k2.7-ioa",
      });
      // 不得出现 Interrupted / model=unknown 假消息
      expect(
        assistants.some(
          (e) =>
            e.type === "message" &&
            (e.model === "unknown" || String(e.content ?? "").includes("Interrupted")),
        ),
      ).toBe(false);

      const errors = events.filter((e) => e.type === "turn.error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        finish_reason: "aborted",
        error: "aborted",
        model: "kimi-k2.7-ioa",
        provider: "moonshot",
        // 与成功 Turn 同结构：挂在半截 assistant 的 message_id 上
        turn_id: "a1",
        message_id: "a1",
      });
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
