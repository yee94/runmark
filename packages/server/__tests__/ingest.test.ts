import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { ingestService } from "../src/services/ingest";
import { costService } from "../src/services/cost";
import type { IngestEvent, ModelPricing } from "@agent-tracker/shared";

describe("ingestService", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);

    const pricing: ModelPricing[] = [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        input_price: 3.0,
        output_price: 15.0,
      },
      { provider: "codebuddy", model: "deepseek-v4-flash", input_price: 0.429, output_price: 1.286 },
    ];
    costService.setPricing(pricing);
  });

  it("creates a session on session.created", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        user_email: "user@example.com",
        repo_url: "https://git.example.com/repo",
        branch: "main",
        project_name: "demo",
        hostname: "mbp",
        worktree: "/tmp/repo",
        directory: "/tmp/repo",
        metadata: { foo: "bar" },
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "s-1" });
    expect(session).toBeTruthy();
    expect((session as any).agent).toBe("opencode");
    expect((session as any).project_name).toBe("demo");
  });

  it("stores parent_session_id for subagent sessions", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "parent-1",
        agent: "opencode",
        title: "主会话",
      },
      {
        type: "session.created",
        session_id: "child-1",
        agent: "opencode",
        title: "探索代码库",
        parent_session_id: "parent-1",
        metadata: { opencode_agent: "explore", is_subagent: true },
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(2);

    const child = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "child-1" }) as any;
    expect(child.parent_session_id).toBe("parent-1");
    expect(JSON.parse(child.metadata).opencode_agent).toBe("explore");
  });

  it("records a turn and updates session aggregates", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
      {
        type: "turn.completed",
        session_id: "s-1",
        turn_id: "t-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        duration_ms: 1200,
        created_at: new Date().toISOString(),
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(2);

    const turn = db.query("SELECT * FROM turns WHERE id = $id").get({ $id: "t-1" });
    expect(turn).toBeTruthy();
    expect((turn as any).cost_usd).toBeCloseTo(0.003 + 0.0075, 6);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "s-1" });
    expect((session as any).total_input_tokens).toBe(1000);
    expect((session as any).total_output_tokens).toBe(500);
    expect((session as any).total_tokens).toBe(1500);
    expect((session as any).request_count).toBe(1);
    expect((session as any).total_cost_usd).toBeCloseTo(0.0105, 6);
  });

  it("creates cursor assistant placeholder turn for usage enrich", () => {
    const at = "2026-06-16T10:00:00.000Z";
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "c-1",
        agent: "cursor",
      },
      {
        type: "message",
        session_id: "c-1",
        message_id: "assistant-gen-1",
        role: "assistant",
        content: "done",
        model: "composer-2.5",
        provider: "cursor",
        created_at: at,
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(2);

    const turn = db.query("SELECT * FROM turns WHERE id = $id").get({ $id: "assistant-gen-1" }) as any;
    expect(turn).toBeTruthy();
    expect(turn.total_tokens).toBe(0);
    expect(turn.cost_usd).toBe(0);
    expect(turn.created_at).toBe(at);
  });

  it("updates existing turn finish_reason/error when abort reuses same turn_id", () => {
    const at = "2026-07-09T06:49:00.000Z";
    const turnId = "assistant-gen-abort";
    ingestService.ingestBatch(db, [
      {
        type: "session.created",
        session_id: "c-abort",
        agent: "cursor",
        provider: "cursor",
        model: "grok-4.5-fast-high",
      },
      {
        type: "turn.completed",
        session_id: "c-abort",
        turn_id: turnId,
        message_id: turnId,
        model: "grok-4.5-fast-high",
        provider: "cursor",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        created_at: at,
      },
    ]);

    const result = ingestService.ingestBatch(db, [
      {
        type: "turn.error",
        session_id: "c-abort",
        turn_id: turnId,
        message_id: turnId,
        model: "grok-4.5-fast-high",
        provider: "cursor",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        error: "aborted",
        finish_reason: "aborted",
        created_at: at,
      },
    ]);
    expect(result.errors).toHaveLength(0);

    const turns = db.query("SELECT * FROM turns WHERE session_id = $id").all({ $id: "c-abort" }) as any[];
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe(turnId);
    expect(turns[0].message_id).toBe(turnId);
    expect(turns[0].finish_reason).toBe("aborted");
    expect(turns[0].error).toBe("aborted");
  });

  it("stores messages and tool results", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
      },
      {
        type: "message",
        session_id: "s-1",
        message_id: "m-1",
        role: "user",
        content: "Hello",
        created_at: new Date().toISOString(),
      },
      {
        type: "tool.result",
        session_id: "s-1",
        tool_name: "bash",
        call_id: "c-1",
        output_title: "bash output",
        duration_ms: 100,
        created_at: new Date().toISOString(),
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(3);

    const msg = db.query("SELECT * FROM messages WHERE id = $id").get({ $id: "m-1" });
    expect((msg as any).content).toBe("Hello");

    const tool = db.query("SELECT * FROM tool_calls WHERE call_id = $id").get({ $id: "c-1" });
    expect((tool as any).tool_name).toBe("bash");
  });

  it("dedupes user messages with same content in a session (hook vs transcript)", () => {
    const at = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-dedup",
        agent: "codebuddy",
      },
      {
        type: "message",
        session_id: "s-dedup",
        message_id: "msg-hook-1",
        role: "user",
        content: "继续",
        created_at: at,
      },
      {
        type: "message",
        session_id: "s-dedup",
        message_id: "jsonl-u1",
        role: "user",
        content: "继续",
        created_at: at,
      },
      {
        type: "message",
        session_id: "s-dedup",
        message_id: "jsonl-u2",
        role: "user",
        content: "<system-reminder>hint</system-reminder>\n继续",
        created_at: at,
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.errors).toHaveLength(0);

    const rows = db
      .query("SELECT id, content FROM messages WHERE session_id = $id AND role = 'user' ORDER BY id")
      .all({ $id: "s-dedup" }) as Array<{ id: string; content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["jsonl-u2", "msg-hook-1"].sort());
  });

  it("keeps tool results idempotent by session and call id", () => {
    const at = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "tool.result",
        session_id: "s-1",
        tool_name: "exec_command",
        call_id: "call-1",
        output_text: "ok",
        duration_ms: 0,
        created_at: at,
      },
      {
        type: "tool.result",
        session_id: "s-1",
        tool_name: "exec_command",
        call_id: "call-1",
        output_text: "ok",
        duration_ms: 0,
        created_at: at,
      },
    ];

    ingestService.ingestBatch(db, events);

    const row = db.query("SELECT COUNT(*) as count FROM tool_calls WHERE session_id = $session_id AND call_id = $call_id").get({
      $session_id: "s-1",
      $call_id: "call-1",
    }) as { count: number };
    expect(row.count).toBe(1);
  });

  it("estimates turn cost when OpenCode reports cost_usd 0", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-sub",
        agent: "opencode",
        parent_session_id: "s-parent",
      },
      {
        type: "turn.completed",
        session_id: "s-sub",
        turn_id: "t-sub",
        model: "deepseek-v4-flash-ioa",
        provider: "codebuddy",
        input_tokens: 10_000,
        output_tokens: 5_000,
        total_tokens: 15_000,
        duration_ms: 500,
        cost_usd: 0,
        created_at: new Date().toISOString(),
      },
    ];

    ingestService.ingestBatch(db, events);

    const turn = db.query("SELECT * FROM turns WHERE id = $id").get({ $id: "t-sub" }) as any;
    expect(turn.cost_usd).toBeGreaterThan(0);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "s-sub" }) as any;
    expect(session.total_cost_usd).toBeGreaterThan(0);
  });

  it("syncs session totals from session.updated opencode cost", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-1",
        agent: "opencode",
      },
      {
        type: "session.updated",
        session_id: "s-1",
        agent: "opencode",
        session_cost_usd: 0.42,
        session_input_tokens: 1000,
        session_output_tokens: 500,
        session_total_tokens: 1500,
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "s-1" }) as any;
    expect(session.total_cost_usd).toBeCloseTo(0.42, 6);
    expect(session.total_tokens).toBe(1500);
  });

  it("auto-creates session when turn arrives before session.created", () => {
    const events: IngestEvent[] = [
      {
        type: "turn.completed",
        session_id: "s-late",
        turn_id: "t-1",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        duration_ms: 1000,
        created_at: new Date().toISOString(),
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "s-late" });
    expect(session).toBeTruthy();
    expect((session as any).agent).toBe("unknown");
    expect((session as any).model).toBe("claude-sonnet-4-20250514");
  });

  it("tool.result with missing turn_id still inserts tool and uses event agent", () => {
    const at = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "tool.result",
        session_id: "cursor-phantom",
        agent: "cursor",
        turn_id: "generation-does-not-exist",
        tool_name: "Shell",
        call_id: "tc-phantom-1",
        output_text: "ok",
        duration_ms: 10,
        created_at: at,
      },
    ];

    const result = ingestService.ingestBatch(db, events);
    expect(result.ingested).toBe(1);
    expect(result.errors).toHaveLength(0);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "cursor-phantom" }) as any;
    expect(session.agent).toBe("cursor");

    const tool = db.query("SELECT * FROM tool_calls WHERE call_id = $id").get({ $id: "tc-phantom-1" }) as any;
    expect(tool).toBeTruthy();
    expect(tool.turn_id).toBeNull();
  });

  it("tool.result without agent defaults ensureSession agent to unknown not opencode", () => {
    const at = new Date().toISOString();
    ingestService.ingestBatch(db, [
      {
        type: "tool.result",
        session_id: "orphan-tool",
        tool_name: "bash",
        call_id: "c-orphan",
        duration_ms: 0,
        created_at: at,
      },
    ]);
    const session = db.query("SELECT agent FROM sessions WHERE id = $id").get({ $id: "orphan-tool" }) as any;
    expect(session.agent).toBe("unknown");
  });

  it("does not overwrite existing session title on session.updated", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-title",
        agent: "cursor",
        title: "LLM 摘要标题",
      },
      {
        type: "session.updated",
        session_id: "s-title",
        agent: "cursor",
        title: "用户新消息 prompt 不应覆盖",
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT title FROM sessions WHERE id = $id").get({ $id: "s-title" }) as any;
    expect(session.title).toBe("LLM 摘要标题");
  });

  it("sets session title from session.updated when title is empty", () => {
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "s-no-title",
        agent: "cursor",
      },
      {
        type: "session.updated",
        session_id: "s-no-title",
        agent: "cursor",
        title: "首条 prompt 标题",
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT title FROM sessions WHERE id = $id").get({ $id: "s-no-title" }) as any;
    expect(session.title).toBe("首条 prompt 标题");
  });

  it("skips OpenCode smartfetch-secondary temporary sessions", () => {
    const result = ingestService.ingestBatch(db, [
      {
        type: "session.created",
        session_id: "s-smartfetch",
        agent: "opencode",
        title: "smartfetch-secondary",
      },
      {
        type: "session.updated",
        session_id: "s-smartfetch",
        agent: "opencode",
        title: "smartfetch-secondary",
      },
    ]);

    expect(result.ingested).toBe(2);
    expect(result.errors).toEqual([]);
    const session = db.query("SELECT id FROM sessions WHERE id = $id").get({ $id: "s-smartfetch" });
    expect(session).toBeNull();
  });

  it("does not overwrite cursor agent when turn arrives after session.created", () => {
    const now = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "cursor-s1",
        agent: "cursor",
        title: "Cursor chat",
      },
      {
        type: "turn.completed",
        session_id: "cursor-s1",
        turn_id: "t-c1",
        model: "composer-2.5",
        provider: "cursor",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 0,
        created_at: now,
      },
      {
        type: "message",
        session_id: "cursor-s1",
        message_id: "m-c1",
        role: "user",
        content: "hello",
        created_at: now,
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: "cursor-s1" }) as any;
    expect(session.agent).toBe("cursor");
  });

  it("merges distinct models into sessions.model as comma-separated list", () => {
    const now = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "multi-model-1",
        agent: "opencode",
        model: "glm-5-1",
      },
      {
        type: "turn.completed",
        session_id: "multi-model-1",
        turn_id: "t-mm-1",
        model: "glm-5-1",
        provider: "zhipu",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        duration_ms: 1,
        created_at: now,
      },
      {
        type: "turn.completed",
        session_id: "multi-model-1",
        turn_id: "t-mm-2",
        model: "deepseek-v4-pro",
        provider: "deepseek",
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        duration_ms: 1,
        created_at: now,
      },
      {
        type: "turn.completed",
        session_id: "multi-model-1",
        turn_id: "t-mm-3",
        model: "GLM-5-1",
        provider: "zhipu",
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        duration_ms: 1,
        created_at: now,
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT model FROM sessions WHERE id = $id").get({ $id: "multi-model-1" }) as any;
    expect(session.model).toBe("glm-5-1, deepseek-v4-pro");
  });

  it("does not append placeholder unknown into sessions.model", () => {
    const now = new Date().toISOString();
    const events: IngestEvent[] = [
      {
        type: "session.created",
        session_id: "placeholder-model-1",
        agent: "opencode",
        model: "deepseek-v4.1-flash",
      },
      {
        type: "session.updated",
        session_id: "placeholder-model-1",
        agent: "opencode",
        model: "unknown",
      },
      {
        type: "turn.completed",
        session_id: "placeholder-model-1",
        turn_id: "t-ph-1",
        model: "unknown",
        provider: "unknown",
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        duration_ms: 1,
        created_at: now,
      },
    ];

    ingestService.ingestBatch(db, events);

    const session = db.query("SELECT model FROM sessions WHERE id = $id").get({ $id: "placeholder-model-1" }) as any;
    expect(session.model).toBe("deepseek-v4.1-flash");
  });
});
