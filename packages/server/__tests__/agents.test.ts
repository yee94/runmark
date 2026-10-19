import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { initializeDatabase } from "../src/db";
import { createAgentsRoute } from "../src/routes/agents";
import { AgentRunBusyError, getAgentRuntime, seedBuiltinAgentConfig } from "../src/services/agents";
import { beijingDateStart, beijingParts } from "../src/services/stats";
import type { ServerConfig } from "../src/config";

function matterPlanSubmit(payload: {
  thought?: string;
  matter_plan: { matters: any[] };
  session_dispositions?: any[];
}): string {
  const matters = payload.matter_plan.matters;
  const derivedDispositions = matters.flatMap((matter) => matter.session_ids.map((sessionId: string) => ({
    session_id: sessionId,
    action: matter.existing_matter_id ? "merge" : "archive",
    reason: matter.existing_matter_id ? "该会话属于已有事项。" : "该会话形成可归档工程事项。",
    ...(matter.existing_matter_id ? { existing_matter_id: matter.existing_matter_id } : {}),
  })));
  return JSON.stringify({
    thought: payload.thought,
    tool_calls: [{
      name: "matter.plan.submit",
      arguments: {
        matters,
        session_dispositions: payload.session_dispositions ?? derivedDispositions,
      },
    }],
  });
}

describe("Agent API", () => {
  let db: Database;
  let app: Hono;
  let config: ServerConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
    config = {
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
      llmBaseUrl: "https://api.deepseek.com",
      llmApiKey: "ac:test",
      llmModel: "deepseek-chat",
      agentThrottleMs: 10 * 60 * 1000,
      agentAutoRunEnabled: false,
      updateEnabled: false,
      updateManifestUrl: "",
      updateScript: "/opt/runmark-updater/update.sh",
      updateStatePath: "/opt/runmark-updater/update-state.json",
    };
    app = new Hono();
    app.route("/", createAgentsRoute(db, config));
  });

  it("seeds default agents and the default Astra models", async () => {
    const agentsRes = await app.request("/v1/agents");
    const agents = await agentsRes.json();
    expect(agentsRes.status).toBe(200);
    expect(agents.map((a: any) => a.id).sort()).toEqual(["agent-matter-archive", "agent-matter-search", "agent-session-search", "agent-session-summary"]);
    const matterAgent = agents.find((a: any) => a.id === "agent-matter-archive");
    const matterSearchAgent = agents.find((a: any) => a.id === "agent-matter-search");
    const sessionSearchAgent = agents.find((a: any) => a.id === "agent-session-search");
    const summaryAgent = agents.find((a: any) => a.id === "agent-session-summary");
    const summaryTrigger = summaryAgent.triggers.find((t: any) => t.id === "chat_event");
    const matterTrigger = matterAgent.triggers.find((t: any) => t.id === "chat_event");
    expect(summaryTrigger.schedule).toBe("session:debounce:5m");
    expect(matterTrigger.schedule).toBe("throttle:10m");
    expect(summaryTrigger.scope).toBeUndefined();
    expect(matterTrigger.scope).toBeUndefined();
    expect(summaryAgent.tools).toContain("session.summary.write");
    expect(matterAgent.tools).toContain("matters.query");
    expect(matterAgent.tools).toContain("matter.detail.read");
    expect(matterAgent.tools).toContain("matter.plan.submit");
    expect(matterAgent.tools).toContain("matter.archive.write");
    expect(matterAgent.system_prompt).toContain("existing_open_matters");
    expect(matterAgent.system_prompt).toContain("agent-tracker-react-tools-v10");
    expect(matterAgent.system_prompt).toContain("必须调用 matter.plan.submit");
    expect(matterAgent.system_prompt).toContain("禁止输出裸 matter_plan");
    expect(matterAgent.system_prompt).toContain("项目名：事项标题");
    expect(matterAgent.system_prompt).toContain("user_intent");
    expect(summaryAgent.system_prompt).not.toContain("包含摘要、主要工作、关键文件或接口、后续建议");
    expect(summaryAgent.system_prompt).toContain("禁止生成");
    expect(summaryAgent.model_id).toBe("model-deepseek-flash");
    expect(matterAgent.model_id).toBe("model-deepseek-pro");
    expect(matterSearchAgent.triggers).toEqual([]);
    expect(matterSearchAgent.tools).toEqual(["matter.archive.search"]);
    expect(sessionSearchAgent.triggers).toEqual([]);
    expect(sessionSearchAgent.tools).toEqual(["session.keyword.search", "session.digest.search"]);

    const configRes = await app.request("/v1/system-config");
    const systemConfig = await configRes.json();
    expect(systemConfig.providers[0].base_url).toBe("https://api.deepseek.com");
    expect(systemConfig.models.map((m: any) => m.model).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("built-in DB seed writes agents and provider without token", () => {
    const seeded = new Database(":memory:");
    seeded.exec("PRAGMA foreign_keys = ON;");
    seeded.exec(SCHEMA_SQL);
    seedBuiltinAgentConfig(seeded);

    const provider = seeded.query("SELECT id, base_url, api_key FROM agent_providers WHERE id = 'provider-deepseek-default'").get() as any;
    const models = seeded.query("SELECT id, model, purpose FROM agent_models ORDER BY id").all() as any[];
    const agents = seeded.query("SELECT id, model_id, triggers, system_prompt, task_brief FROM agents ORDER BY id").all() as any[];
    const promptRows = seeded.query("SELECT agent_id, system_prompt, task_brief FROM agent_prompts ORDER BY agent_id").all() as any[];

    expect(provider.base_url).toBe("https://api.deepseek.com");
    expect(provider.api_key).toBeNull();
    expect(models.map((m) => m.model).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(agents.map((a) => a.id)).toEqual(["agent-matter-archive", "agent-matter-search", "agent-session-search", "agent-session-summary"]);
    expect(agents.find((a) => a.id === "agent-session-summary").model_id).toBe("model-deepseek-flash");
    expect(agents.find((a) => a.id === "agent-matter-archive").model_id).toBe("model-deepseek-pro");
    expect(JSON.parse(agents.find((a) => a.id === "agent-session-summary").triggers)[0].schedule).toBe("session:debounce:5m");
    expect(JSON.parse(agents.find((a) => a.id === "agent-matter-archive").triggers)[0].schedule).toBe("throttle:10m");
    expect(agents.every((a) => a.system_prompt.includes("agent-tracker-react-tools-v10"))).toBe(true);
    expect(agents.every((a) => a.task_brief.length > 0)).toBe(true);
    expect(promptRows.map((a) => a.agent_id)).toEqual(["agent-matter-archive", "agent-matter-search", "agent-session-search", "agent-session-summary"]);
    expect(promptRows.every((a) => a.system_prompt.includes("agent-tracker-react-tools-v10"))).toBe(true);
    expect(promptRows.every((a) => a.task_brief.length > 0)).toBe(true);
    expect(agents.filter((a) => JSON.parse(a.triggers).length).every((a) => JSON.parse(a.triggers)[0].scope == null)).toBe(true);
    seeded.close();
  });

  it("migrates built-in triggers to their configured scheduling mode", () => {
    const seeded = new Database(":memory:");
    seeded.exec("PRAGMA foreign_keys = ON;");
    seeded.exec(SCHEMA_SQL);
    seedBuiltinAgentConfig(seeded);
    seeded.query("UPDATE agents SET triggers = $triggers").run({
      $triggers: JSON.stringify([{ id: "chat_event", enabled: true, debounce: "30m" }]),
    });

    seedBuiltinAgentConfig(seeded);

    const agents = seeded.query("SELECT id, triggers FROM agents ORDER BY id").all() as any[];
    const summaryTrigger = JSON.parse(agents.find((agent) => agent.id === "agent-session-summary").triggers)[0];
    const matterTrigger = JSON.parse(agents.find((agent) => agent.id === "agent-matter-archive").triggers)[0];
    expect(summaryTrigger).toEqual({ id: "chat_event", enabled: true, schedule: "session:debounce:30m" });
    expect(matterTrigger).toEqual({ id: "chat_event", enabled: true, schedule: "throttle:30m" });
    seeded.close();
  });

  it("migrates an existing old SQLite database without overwriting existing values", () => {
    const path = `/tmp/agent-tracker-migrate-${crypto.randomUUID()}.db`;
    const oldDb = new Database(path, { create: true });
    oldDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE cursor_usage_events (
        event_id TEXT PRIMARY KEY,
        timestamp INTEGER
      );
      CREATE TABLE pricing (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_price REAL NOT NULL DEFAULT 0,
        output_price REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, model)
      );
      CREATE TABLE agent_providers (
        id TEXT PRIMARY KEY,
        base_url TEXT,
        api_key TEXT
      );
      INSERT INTO agent_providers (id, base_url, api_key) VALUES ('provider-deepseek-default', 'https://custom.example/v1/chat/completions', 'dirty-token');
      CREATE TABLE agent_models (
        id TEXT PRIMARY KEY,
        label TEXT,
        model TEXT
      );
      INSERT INTO agent_models (id, label, model) VALUES ('model-deepseek-flash', 'custom-model', 'custom-model');
      CREATE TABLE agents (
        id TEXT PRIMARY KEY
      );
      INSERT INTO agents (id) VALUES ('agent-session-summary'), ('agent-matter-archive');
      CREATE TABLE agent_prompts (
        agent_id TEXT PRIMARY KEY
      );
      INSERT INTO agent_prompts (agent_id) VALUES ('agent-matter-archive');
      CREATE TABLE matter_archives (
        id TEXT PRIMARY KEY
      );
    `);
    oldDb.close();

    const migrated = new Database(path, { create: true });
    initializeDatabase(migrated);
    const sessionCols = migrated.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const cursorCols = migrated.query("PRAGMA table_info(cursor_usage_events)").all() as Array<{ name: string }>;
    const pricingCols = migrated.query("PRAGMA table_info(pricing)").all() as Array<{ name: string }>;
    const matterCols = migrated.query("PRAGMA table_info(matter_archives)").all() as Array<{ name: string }>;
    const provider = migrated.query("SELECT base_url, api_key FROM agent_providers WHERE id = 'provider-deepseek-default'").get() as any;
    const model = migrated.query("SELECT label, model FROM agent_models WHERE id = 'model-deepseek-flash'").get() as any;
    const models = migrated.query("SELECT id, model FROM agent_models ORDER BY id").all() as any[];
    const agents = migrated.query("SELECT id, name, model_id, tools, system_prompt FROM agents ORDER BY id").all() as any[];
    const matterPrompt = migrated.query("SELECT system_prompt FROM agent_prompts WHERE agent_id = 'agent-matter-archive'").get() as any;
    const matterAgent = migrated.query("SELECT tools, system_prompt FROM agents WHERE id = 'agent-matter-archive'").get() as any;

    expect(sessionCols.some((c) => c.name === "AISummary")).toBe(true);
    expect(sessionCols.some((c) => c.name === "parent_session_id")).toBe(true);
    expect(cursorCols.some((c) => c.name === "enriched_at")).toBe(true);
    expect(pricingCols.some((c) => c.name === "cache_read_price")).toBe(true);
    expect(matterCols.some((c) => c.name === "updated_at")).toBe(true);
    expect(provider.base_url).toBe("https://custom.example/v1/chat/completions");
    expect(provider.api_key).toBe("dirty-token");
    expect(model.model).toBe("custom-model");
    expect(models.some((m) => m.id === "model-deepseek-pro" && m.model === "deepseek-reasoner")).toBe(true);
    expect(agents.map((a) => a.id)).toEqual(["agent-matter-archive", "agent-matter-search", "agent-session-search", "agent-session-summary"]);
    expect(agents.find((a) => a.id === "agent-session-summary").model_id).toBe("model-deepseek-flash");
    expect(agents.find((a) => a.id === "agent-matter-archive").model_id).toBe("model-deepseek-flash");
    expect(agents.every((a) => a.name.length > 0 && a.system_prompt.length > 0)).toBe(true);
    expect(agents.every((a) => a.system_prompt.includes("agent-tracker-react-tools-v10"))).toBe(true);
    expect(matterPrompt.system_prompt).toContain("事项归档智能体");
    expect(matterPrompt.system_prompt).toContain("existing_open_matters");
    expect(JSON.parse(matterAgent.tools)).toContain("matter.detail.read");
    expect(JSON.parse(matterAgent.tools)).toContain("matter.archive.write");
    expect(matterAgent.system_prompt).toContain("existing_open_matters");

    migrated.close();
    try {
      Bun.file(path).delete();
    } catch {}
  });

  it("updates agent config", async () => {
    const res = await app.request("/v1/agents/agent-session-summary/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        triggers: [{ id: "chat_event", enabled: true, schedule: "debounce:10m" }],
        tools: ["session.context.read"],
      }),
    });
    const agent = await res.json();
    expect(res.status).toBe(200);
    expect(agent.enabled).toBe(false);
    expect(agent.triggers[0].schedule).toBe("session:debounce:10m");
    expect(agent.tools).toContain("session.context.read");
    expect(agent.tools).toContain("session.summary.write");
  });

  it("allows Matter Archive model to be saved as flash", async () => {
    const res = await app.request("/v1/agents/agent-matter-archive/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        model_id: "model-deepseek-flash",
      }),
    });
    const agent = await res.json();

    expect(res.status).toBe(200);
    expect(agent.model_id).toBe("model-deepseek-flash");

    getAgentRuntime(db, config).ensureDefaults();
    const afterDefaults = await app.request("/v1/agents/agent-matter-archive/config");
    const reloaded = await afterDefaults.json();
    expect(reloaded.model_id).toBe("model-deepseek-flash");
  });

  it("refreshes built-in prompts when the prompt version changes", () => {
    seedBuiltinAgentConfig(db);
    db.query(`
      UPDATE agents
      SET system_prompt = 'legacy prompt agent-tracker-react-tools-v8',
          task_brief = 'legacy brief'
      WHERE id = 'agent-matter-archive'
    `).run();
    db.query(`
      UPDATE agent_prompts
      SET system_prompt = 'legacy prompt agent-tracker-react-tools-v8',
          task_brief = 'legacy brief'
      WHERE agent_id = 'agent-matter-archive'
    `).run();

    seedBuiltinAgentConfig(db);
    const agent = db.query("SELECT system_prompt, task_brief FROM agents WHERE id = 'agent-matter-archive'").get() as any;
    const prompt = db.query("SELECT system_prompt, task_brief FROM agent_prompts WHERE agent_id = 'agent-matter-archive'").get() as any;

    expect(agent.system_prompt).toContain("agent-tracker-react-tools-v10");
    expect(agent.system_prompt).toContain("matter.plan.submit");
    expect(agent.system_prompt).toContain("北京时间");
    expect(agent.task_brief).not.toBe("legacy brief");
    expect(prompt.system_prompt).toContain("agent-tracker-react-tools-v10");
    expect(prompt.system_prompt).toContain("matter.plan.submit");
    expect(prompt.system_prompt).toContain("北京时间");
    expect(prompt.task_brief).not.toBe("legacy brief");
  });

  it("marks interrupted running jobs failed when runtime starts", () => {
    const interruptedDb = new Database(":memory:");
    interruptedDb.exec("PRAGMA foreign_keys = ON;");
    interruptedDb.exec(SCHEMA_SQL);
    seedBuiltinAgentConfig(interruptedDb);
    interruptedDb.query(`
      INSERT INTO agent_jobs (id, agent_id, status, started_at, duration_ms)
      VALUES ('job-interrupted-1', 'agent-matter-archive', 'running', '2026-07-08T05:00:00.000Z', 0)
    `).run();

    getAgentRuntime(interruptedDb, config).ensureDefaults();
    const row = interruptedDb.query("SELECT status, finished_at, duration_ms, error FROM agent_jobs WHERE id = 'job-interrupted-1'").get() as any;

    expect(row.status).toBe("failed");
    expect(row.finished_at).toBeTruthy();
    expect(row.duration_ms).toBeGreaterThan(0);
    expect(row.error).toContain("server restart");
    interruptedDb.close();
  });

  it("skips Session Summary for OpenCode subagent sessions", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, parent_session_id, metadata)
      VALUES (
        's-subagent-1',
        'opencode',
        'explore subagent',
        'anthropic',
        'claude-sonnet-4',
        '2026-07-08T01:00:00.000Z',
        's-parent-1',
        '{"opencode_agent":"explore","is_subagent":true}'
      );
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-subagent-1', 's-subagent-1', 'user', '探索代码库', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ thought: "should not run", final: {} }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-subagent-1/resummarize?sync=1", { method: "POST" });
      const body = await res.json();
      const summary = db.query("SELECT id FROM session_summaries WHERE session_id = 's-subagent-1'").get();
      const skipTools = db.query(
        "SELECT tool_name, detail, result FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at",
      ).all({ $job_id: body.id }) as Array<{ tool_name: string; detail: string; result: string | null }>;
      const output = typeof body.output_json === "string" ? JSON.parse(body.output_json) : body.output_json;

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(output?.skipped_subagent_session_ids).toEqual(["s-subagent-1"]);
      expect(summary).toBeNull();
      expect(fetchCount).toBe(0);
      expect(skipTools.some((row) => row.tool_name === "session.summary.skip" && row.detail.includes("subagent"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reruns a session summary through the Session Summary Agent", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-1', 'codex', '旧标题', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-1', 's-summary-1', 'user', '请实现会话摘要重新生成', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      const content = fetchCount === 1
        ? JSON.stringify({
          thought: "上下文足够，写入会话摘要。",
          tool_calls: [{
            name: "session.summary.write",
            arguments: {
              session_id: "s-summary-1",
              title: "会话摘要重新生成",
              summary: "完成会话摘要重新生成。",
              markdown: "## 摘要\n服务端通过 Session Summary Agent 重新生成会话摘要。",
            },
          }],
        })
        : JSON.stringify({
          thought: "写入工具已完成。",
          final: { summary: "完成会话摘要重新生成。" },
        });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-summary-1/resummarize?sync=1", { method: "POST" });
      const body = await res.json();
      const session = db.query("SELECT title, AISummary FROM sessions WHERE id = 's-summary-1'").get() as any;
      const summary = db.query("SELECT session_id, job_id, markdown FROM session_summaries WHERE session_id = 's-summary-1'").get() as any;
      const toolNames = db.query("SELECT tool_name FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at").all({ $job_id: body.id }).map((row: any) => row.tool_name);

      expect(res.status).toBe(200);
      expect(body.agent_id).toBe("agent-session-summary");
      expect(body.run_reason).toBe("session_resummarize");
      expect(session.title).toBe("会话摘要重新生成");
      expect(session.AISummary).toContain("Session Summary Agent");
      expect(summary.job_id).toBe(body.id);
      expect(toolNames).toContain("session.summary.write");
      expect(fetchCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects concurrent runs for the same agent across runtime and API entry points", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-lock-1', 'codex', '并发互斥', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-lock-1', 's-summary-lock-1', 'user', '验证同一 Agent 只能运行一个任务。', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let releaseFirstFetch!: (response: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const llmResponse = (content: unknown) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }), { headers: { "Content-Type": "application/json" } });
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) return await firstFetch;
      return llmResponse({ thought: "摘要写入完成。", final: { summary: "done" } });
    }) as typeof fetch;
    const runtime = getAgentRuntime(db, config);
    try {
      const firstRun = runtime.runAgent("agent-session-summary", {
        session_id: "s-summary-lock-1",
        trigger: "chat_event",
      });
      expect(runtime.isAgentRunning("agent-session-summary")).toBe(true);

      await expect(runtime.runAgent("agent-session-summary", {
        session_id: "s-summary-lock-1",
      })).rejects.toBeInstanceOf(AgentRunBusyError);
      const apiRes = await app.request("/v1/agents/agent-session-summary/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-summary-lock-1" }),
      });
      expect(apiRes.status).toBe(409);

      releaseFirstFetch(llmResponse({
        thought: "写入被锁保护的摘要。",
        tool_calls: [{
          name: "session.summary.write",
          arguments: {
            session_id: "s-summary-lock-1",
            title: "Agent 并发互斥",
            summary: "同一 Agent 不会并发执行。",
            markdown: "## 摘要\n已验证同一 Agent 的进程内互斥。",
          },
        }],
      }));
      const completed = await firstRun;
      expect(completed.status).toBe("success");
      expect(runtime.isAgentRunning("agent-session-summary")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries HTTP 498 three times with backoff before continuing the ReAct loop", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-498-1', 'codex', '498 重试', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-498-1', 's-summary-498-1', 'user', '验证 LLM 498 后可以退避重试并继续总结。', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount <= 3) {
        return new Response(JSON.stringify({ message: "LLM request failed: 498" }), {
          status: 498,
          headers: { "Content-Type": "application/json", "Retry-After": "0" },
        });
      }
      const content = fetchCount === 4
        ? JSON.stringify({
          thought: "三次瞬态失败后恢复，写入会话摘要。",
          tool_calls: [{
            name: "session.summary.write",
            arguments: {
              session_id: "s-summary-498-1",
              title: "LLM 498 退避重试验证",
              summary: "LLM 498 后完成三次退避重试并恢复。",
              markdown: "## 摘要\nLLM 请求连续三次返回 498，服务端退避重试后继续 ReAct 会话摘要写入。",
            },
          }],
        })
        : JSON.stringify({ thought: "摘要写入完成。", final: { summary: "已完成。" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-summary-498-1/resummarize?sync=1", { method: "POST" });
      const body = await res.json();
      const session = db.query("SELECT title, AISummary FROM sessions WHERE id = 's-summary-498-1'").get() as any;

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(session.title).toBe("LLM 498 退避重试验证");
      expect(session.AISummary).toContain("退避重试");
      expect(fetchCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers truncated session.summary.write JSON instead of storing protocol payload", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-trunc-1', 'codex', '旧标题', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-trunc-1', 's-summary-trunc-1', 'user', '请实现会话摘要重新生成', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    // 模拟 LLM 输出在 markdown 字段中途被截断，导致 JSON.parse 失败
    const truncated = [
      '{"thought":"上下文足够，写入会话摘要。","tool_calls":[{"name":"session.summary.write","arguments":{',
      '"session_id":"s-summary-trunc-1",',
      '"title":"截断摘要恢复",',
      '"summary":"从截断 JSON 恢复 Markdown。",',
      '"markdown":"## 会话摘要\\n\\n**会话标题：** 截断摘要恢复\\n\\n### 主要工作\\n服务端从截断的 tool_calls JSON 中恢复真正的 Markdown 正文。',
    ].join("");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: truncated } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-summary-trunc-1/resummarize?sync=1", { method: "POST" });
      const body = await res.json();
      const session = db.query("SELECT title, AISummary FROM sessions WHERE id = 's-summary-trunc-1'").get() as any;
      const summary = db.query("SELECT markdown FROM session_summaries WHERE session_id = 's-summary-trunc-1'").get() as any;
      const toolNames = db.query("SELECT tool_name FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at").all({ $job_id: body.id }).map((row: any) => row.tool_name);

      expect(res.status).toBe(200);
      expect(session.title).toBe("截断摘要恢复");
      expect(session.AISummary).toContain("## 会话摘要");
      expect(session.AISummary).toContain("恢复真正的 Markdown");
      expect(session.AISummary).not.toContain('"tool_calls"');
      expect(summary.markdown).toContain("## 会话摘要");
      expect(toolNames).toContain("session.summary.write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps legacy summary JSON compatible by writing through the summary tool", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-legacy-1', 'codex', '旧标题', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-legacy-1', 's-summary-legacy-1', 'user', '请实现会话摘要重新生成', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: "会话摘要重新生成",
            summary: "完成会话摘要重新生成。",
            markdown: "## 摘要\n服务端通过 Session Summary Agent 重新生成会话摘要。",
          }),
        },
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-summary-legacy-1/resummarize?sync=1", { method: "POST" });
      const body = await res.json();
      const session = db.query("SELECT title, AISummary FROM sessions WHERE id = 's-summary-legacy-1'").get() as any;
      const summary = db.query("SELECT session_id, job_id, markdown FROM session_summaries WHERE session_id = 's-summary-legacy-1'").get() as any;
      const toolNames = db.query("SELECT tool_name FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at").all({ $job_id: body.id }).map((row: any) => row.tool_name);

      expect(res.status).toBe(200);
      expect(body.agent_id).toBe("agent-session-summary");
      expect(body.run_reason).toBe("session_resummarize");
      expect(session.title).toBe("会话摘要重新生成");
      expect(session.AISummary).toContain("Session Summary Agent");
      expect(summary.job_id).toBe(body.id);
      expect(toolNames).toContain("session.summary.write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("starts manual resummarize requests asynchronously by default", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary)
      VALUES ('s-summary-async-1', 'codex', '异步摘要', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '旧总结');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-summary-async-1', 's-summary-async-1', 'user', '请异步生成摘要', '2026-07-08T01:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: fetchCount === 1 ? JSON.stringify({
              thought: "写入异步摘要。",
              tool_calls: [{
                name: "session.summary.write",
                arguments: {
                  session_id: "s-summary-async-1",
                  title: "异步摘要",
                  summary: "已异步生成摘要。",
                  markdown: "## 摘要\nAgent 异步生成会话摘要。",
                },
              }],
            }) : JSON.stringify({
              thought: "异步摘要写入完成。",
              final: { summary: "已异步生成摘要。" },
            }),
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/s-summary-async-1/resummarize", { method: "POST" });
      const body = await res.json();
      const immediate = db.query("SELECT status FROM agent_jobs WHERE id = $id").get({ $id: body.id }) as any;
      const duplicateRes = await app.request("/v1/sessions/s-summary-async-1/resummarize", { method: "POST" });
      const duplicateBody = await duplicateRes.json();
      const runningJobCount = (db.query(`
        SELECT COUNT(*) AS count
        FROM agent_jobs
        WHERE agent_id = 'agent-session-summary'
          AND target_session_id = 's-summary-async-1'
          AND status = 'running'
      `).get() as any).count;

      expect(res.status).toBe(202);
      expect(body.status).toBe("running");
      expect(immediate.status).toBe("running");
      expect(duplicateRes.status).toBe(202);
      expect(duplicateBody.id).toBe(body.id);
      expect(duplicateBody.deduplicated).toBe(true);
      expect(runningJobCount).toBe(1);

      const deadline = Date.now() + 2_000;
      let finished: { status: string; error?: string | null } | null = null;
      while (Date.now() < deadline) {
        finished = db.query("SELECT status, error FROM agent_jobs WHERE id = $id").get({ $id: body.id }) as any;
        if (finished?.status === "success" || finished?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (finished?.status !== "success") {
        throw new Error(
          `async resummarize job ${body.id} did not reach success within 2000ms; last=${JSON.stringify(finished)} fetchCount=${fetchCount}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries failed Matter Archive runs with restored session ids", async () => {
    seedBuiltinAgentConfig(db);
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-retry-1', 'codex', '重试事项一', 'astra', 'deepseek-chat', '2026-07-08T02:00:00.000Z', '第一个失败归档来源', 1200);
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-retry-2', 'codex', '重试事项二', 'astra', 'deepseek-chat', '2026-07-08T02:05:00.000Z', '第二个失败归档来源', 800);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-retry-1', 's-retry-1', 'user', '请重试失败事项归档。', '2026-07-08T02:01:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-retry-2', 's-retry-2', 'user', '两个 Session 应该一起重跑。', '2026-07-08T02:06:00.000Z');
      INSERT INTO agent_jobs (id, agent_id, status, trigger, run_reason, target_session_id, input_json, started_at, duration_ms, error)
      VALUES ('job-retry-source', 'agent-matter-archive', 'failed', 'chat_event', 'throttled_chat_event', 's-retry-1', '{"session_ids":["s-retry-1","s-retry-2"]}', '2026-07-08T02:10:00.000Z', 120000, 'The operation was aborted.');
      INSERT INTO agent_tool_calls (id, job_id, tool_name, state, detail, args, result, created_at)
      VALUES (
        'tool-retry-trigger',
        'job-retry-source',
        'trigger.session_changes',
        'ok',
        '记录 2 个去重后的新对话 SessionId',
        '{"session_ids":["s-retry-1","s-retry-2"]}',
        '{"changed_session_ids":["s-retry-1","s-retry-2"]}',
        '2026-07-08T02:10:01.000Z'
      );
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages?.map((m: any) => m.content).join("\n") || "";
      expect(prompt).toContain("s-retry-1");
      expect(prompt).toContain("s-retry-2");
      if (fetchCount === 1) expect(prompt).toContain("trigger_session_changes");
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "重试时保留两个 Session，并规划一个事项。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "Agent Tracker：失败事项归档重试",
              type: "Fix",
              topic: "失败事项归档重试",
              session_ids: ["s-retry-1", "s-retry-2"],
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按重试 plan 写入事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "Agent Tracker：失败事项归档重试",
                type: "Fix",
                topic: "失败事项归档重试",
                summary: "失败 Agent Run 可以从原始 session 范围重试。",
                result: "已重新生成事项。",
                markdown: "## 摘要\n失败 Agent Run 通过 retry 接口重跑，并保留两个 Session 来源。",
                dependency_refs: ["packages/server/src/routes/agents.ts"],
                timeline_points: ["2026-07-08T02:10:00.000Z: 用户触发失败 run 重试"],
              },
            }],
          })
          : JSON.stringify({
            thought: "重试写入完成。",
            final: { summary: "已重试事项归档。" },
          });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agent-runs/job-retry-source/retry?sync=1", { method: "POST" });
      const body = await res.json();
      const linkedSessions = db.query("SELECT session_id FROM matter_sessions ORDER BY session_id").all().map((row: any) => row.session_id);
      const oldJob = db.query("SELECT id FROM agent_jobs WHERE id = 'job-retry-source'").get();
      const oldToolCount = db.query("SELECT COUNT(*) as count FROM agent_tool_calls WHERE job_id = 'job-retry-source'").get() as any;

      expect(res.status).toBe(200);
      expect(body.id).not.toBe("job-retry-source");
      expect(body.agent_id).toBe("agent-matter-archive");
      expect(body.target_session_id).toBe("s-retry-1");
      expect(body.run_reason).toBe("retry:throttled_chat_event");
      expect(linkedSessions).toEqual(["s-retry-1", "s-retry-2"]);
      expect(oldJob).toBeNull();
      expect(oldToolCount.count).toBe(0);
      expect(fetchCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects retry for non-failed Agent runs", async () => {
    seedBuiltinAgentConfig(db);
    db.exec(`
      INSERT INTO agent_jobs (id, agent_id, status, started_at, duration_ms)
      VALUES ('job-retry-success', 'agent-matter-archive', 'success', '2026-07-08T02:10:00.000Z', 10);
    `);

    const res = await app.request("/v1/agent-runs/job-retry-success/retry", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("Only failed");
  });

  it("executes planning tools and rejects plans that omit candidate sessions", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-plan-tool-1', 'codex', '事项规划工具执行', 'astra', 'deepseek-chat', '2026-07-08T01:00:00.000Z', '需要执行 Tool 后归档', 1200);
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-plan-tool-2', 'codex', '事项规划覆盖校验', 'astra', 'deepseek-chat', '2026-07-08T01:05:00.000Z', '需要明确跳过原因', 300);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-plan-tool-1', 's-plan-tool-1', 'user', '先读取已有事项，再归档本次修复。', '2026-07-08T01:01:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-plan-tool-2', 's-plan-tool-2', 'user', '这是一次简单讨论，没有形成独立交付。', '2026-07-08T01:06:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages?.map((message: any) => message.content).join("\n") || "";
      if (fetchCount === 3) {
        expect(prompt).toContain("matter.plan.submit validation failed");
        expect(prompt).toContain("missing disposition for candidate session: s-plan-tool-2");
      }
      const content = fetchCount === 1
        ? JSON.stringify({
          thought: "先读取已有事项再提交计划。",
          tool_calls: [{ name: "matters.query", arguments: { limit: 12 } }],
        })
        : fetchCount === 2
          ? matterPlanSubmit({
            thought: "首次提交遗漏了一个候选会话。",
            matter_plan: {
              matters: [{
                title: "Runmark：Matter Archive 规划工具修复",
                type: "Fix",
                topic: "Matter Archive 规划协议",
                session_ids: ["s-plan-tool-1"],
              }],
            },
          })
          : fetchCount === 3
            ? matterPlanSubmit({
              thought: "补齐全部候选的 disposition 后重新提交。",
              matter_plan: {
                matters: [{
                  title: "Runmark：Matter Archive 规划工具修复",
                  type: "Fix",
                  topic: "Matter Archive 规划协议",
                  session_ids: ["s-plan-tool-1"],
                }],
              },
              session_dispositions: [
                { session_id: "s-plan-tool-1", action: "archive", reason: "形成规划协议修复交付。" },
                { session_id: "s-plan-tool-2", action: "skip_trivial", reason: "仅讨论概念，没有独立交付。" },
              ],
            })
            : fetchCount === 4
              ? JSON.stringify({
                thought: "按校验通过的计划写入事项。",
                tool_calls: [{
                  name: "matter.archive.write",
                  arguments: {
                    title: "Runmark：Matter Archive 规划工具修复",
                    type: "Fix",
                    topic: "Matter Archive 规划协议",
                    summary: "规划阶段真实执行 Tool，并校验全部候选 Session。",
                    result: "遗漏候选的计划会被拒绝并要求修正。",
                    markdown: "## 摘要\nMatter Archive 规划阶段执行读取 Tool，并通过 disposition 校验阻止候选静默丢失。",
                  },
                }],
              })
              : JSON.stringify({ thought: "事项写入完成。", final: { summary: "已完成。" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-plan-tool-1", "s-plan-tool-2"], force: true }),
      });
      const body = await res.json();
      const submitCalls = db.query(`
        SELECT state FROM agent_tool_calls
        WHERE job_id = $job_id AND tool_name = 'matter.plan.submit'
        ORDER BY created_at
      `).all({ $job_id: body.id }).map((row: any) => row.state);
      const linkedSessions = db.query("SELECT session_id FROM matter_sessions ORDER BY session_id").all().map((row: any) => row.session_id);

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.summary).toContain("候选 2 个会话");
      expect(body.summary).toContain("实际关联 1 个");
      expect(body.summary).toContain("跳过 1 个");
      expect(body.summary).toContain("覆盖率 100%");
      expect(submitCalls).toEqual(["error", "ok"]);
      expect(linkedSessions).toEqual(["s-plan-tool-1"]);
      expect(fetchCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses recovery-only ReAct steps to self-correct a missing matter.plan.submit call", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-plan-recovery-1', 'cursor', 'VoIP 文档与时序图整理', 'cursor', 'grok-4.5-high', '2026-07-10T09:45:17.937Z', '完成 VoIP 文档、Mermaid 与 ASCII 时序图整理。', 4158392);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-plan-recovery-1', 's-plan-recovery-1', 'user', '补充 VoIP 背景知识、客户端与服务端关系及时序图。', '2026-07-10T09:45:17.937Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages?.map((message: any) => message.content).join("\n") || "";
      if (fetchCount === 2) {
        expect(prompt).toContain("required_tool_pending");
        expect(prompt).toContain("matter.plan.submit");
      }
      if (fetchCount === 8) {
        expect(prompt).toContain('"recovery":true');
        expect(prompt).toContain("Recovery step only allows required tool: matter.plan.submit");
      }
      const content = fetchCount === 1
        ? JSON.stringify({
          thought: "先读取候选会话完整上下文。",
          tool_calls: [{ name: "session.context.read", arguments: { session_id: "s-plan-recovery-1" } }],
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "再读取已有事项后规划。",
            tool_calls: [{ name: "matters.query", arguments: { limit: 10 } }],
          })
          : fetchCount === 3
            ? JSON.stringify({
              thought: "错误地输出裸计划。",
              matter_plan: {
                matters: [{
                  title: "wxaaiagentnodelogicsvr：VoIP 背景文档与时序图",
                  type: "Feature",
                  topic: "VoIP 文档建设",
                  session_ids: ["s-plan-recovery-1"],
                }],
              },
            })
            : fetchCount === 4 || fetchCount === 6
              ? JSON.stringify({ thought: "错误地提前结束。", final: { summary: "计划已形成。" } })
              : fetchCount === 5
                ? "not-json"
                : fetchCount === 7
                  ? JSON.stringify({
                    thought: "恢复阶段仍尝试读取，服务端应拒绝并要求立即提交。",
                    tool_calls: [{ name: "sessions.query", arguments: { session_ids: ["s-plan-recovery-1"] } }],
                  })
                  : fetchCount === 8
                    ? matterPlanSubmit({
                      thought: "根据恢复 observation 调用必需提交工具。",
                      matter_plan: {
                        matters: [{
                          project: "wxaaiagentnodelogicsvr",
                          user_intent: "完善 VoIP 背景知识与时序说明。",
                          classification_reason: {
                            matter_type_reason: "新增完整技术文档，属于 Feature。",
                            title_reason: "标题先声明项目，再说明 VoIP 文档能力。",
                          },
                          title: "wxaaiagentnodelogicsvr：VoIP 背景文档与时序图",
                          type: "Feature",
                          topic: "VoIP 文档建设",
                          session_ids: ["s-plan-recovery-1"],
                        }],
                      },
                    })
                    : fetchCount === 9
                      ? JSON.stringify({
                        thought: "按恢复后的合法计划写入事项。",
                        tool_calls: [{
                          name: "matter.archive.write",
                          arguments: {
                            title: "wxaaiagentnodelogicsvr：VoIP 背景文档与时序图",
                            type: "Feature",
                            topic: "VoIP 文档建设",
                            summary: "完成 VoIP 背景、关系说明与时序图文档。",
                            result: "技术文档已形成可交接事项。",
                            markdown: "## 归类\n项目为 wxaaiagentnodelogicsvr，事项属于 Feature。\n\n## 摘要\n完成 VoIP 背景、客户端与服务端关系以及时序图说明。\n\n## 展开\n补充技术背景并以 Mermaid 和 ASCII 表达交互过程。\n\n## 依赖与细节\n依赖 docs/voip-background.md。\n\n## 交接 Brief\n后续维护该文档即可。",
                            dependency_refs: ["docs/voip-background.md"],
                            timeline_points: ["2026-07-10 17:45 北京时间: 开始整理 VoIP 文档"],
                          },
                        }],
                      })
                      : JSON.stringify({ thought: "事项写入完成。", final: { summary: "已完成。" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-plan-recovery-1"], force: true }),
      });
      const body = await res.json();
      const matter = db.query("SELECT title FROM matter_archives WHERE title = 'wxaaiagentnodelogicsvr：VoIP 背景文档与时序图'").get() as any;
      const retries = db.query(`
        SELECT state, detail, args
        FROM agent_tool_calls
        WHERE job_id = $job_id AND tool_name = 'matter.plan.retry'
        ORDER BY created_at
      `).all({ $job_id: body.id }) as any[];
      const blockedRetry = retries.find((retry) => retry.detail.includes("non_required_tool_blocked"));

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(matter.title).toBe("wxaaiagentnodelogicsvr：VoIP 背景文档与时序图");
      expect(retries.some((retry) => retry.detail.includes("required_tool_missing"))).toBe(true);
      expect(retries.some((retry) => retry.detail.includes("response_not_valid_json"))).toBe(true);
      expect(blockedRetry).toBeTruthy();
      expect(fetchCount).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers complete matter.plan.submit arguments when the outer ReAct JSON misses tool_calls closing bracket", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-plan-malformed-1', 'cursor', 'VoIP 文档整理', 'cursor', 'grok-4.5-high', '2026-07-10T09:45:17.937Z', '完成 VoIP 文档整理。', 1200);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-plan-malformed-1', 's-plan-malformed-1', 'user', '补充 VoIP 背景知识文档。', '2026-07-10T09:45:17.937Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    const argumentsJson = JSON.stringify({
      matters: [],
      session_dispositions: [{
        session_id: "s-plan-malformed-1",
        action: "skip_trivial",
        reason: "仅补充背景知识文档，不形成独立工程事项。",
      }],
    });
    const malformed = `{"thought":"输出跳过计划。","tool_calls":[{"name":"matter.plan.submit","arguments":${argumentsJson}}}`;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: malformed } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-plan-malformed-1"], force: true }),
      });
      const body = await res.json();
      const submit = db.query("SELECT state FROM agent_tool_calls WHERE job_id = $job_id AND tool_name = 'matter.plan.submit'").get({ $job_id: body.id }) as any;
      const recovery = db.query("SELECT state, detail FROM agent_tool_calls WHERE job_id = $job_id AND tool_name = 'matter.plan.retry'").get({ $job_id: body.id }) as any;

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.summary).toContain("跳过 1 个");
      expect(submit.state).toBe("ok");
      expect(recovery.detail).toContain("malformed_required_tool_recovered");
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("updates an existing open matter when Matter Archive returns its id", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-1', 'codex', '继续实现事项归档', 'astra', 'deepseek-chat', '2026-07-08T02:00:00.000Z', '已有会话摘要', 1200);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-1', 's-matter-1', 'user', '继续调整事项归档，要求命中已有事项时更新。', '2026-07-08T02:01:00.000Z');
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-2', 'codex', '事项归档触发变更', 'astra', 'deepseek-chat', '2026-07-08T02:05:00.000Z', '同一事项的后续会话', 800);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-2', 's-matter-2', 'user', '用户继续说明 A/B Session 都需要作为本轮变化被 Matter Archive 关注。', '2026-07-08T02:06:00.000Z');
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, updated_at)
      VALUES ('matter-existing-1', 'M-0001', 'Feature', 'done', '旧事项归档', '事项归档整合', '旧摘要', '旧结果', '# 旧正文', '2026-07-08T02:10:00.000Z');
      INSERT INTO matter_sessions (matter_id, session_id) VALUES ('matter-existing-1', 's-matter-1');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
	      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
	      const prompt = payload.messages?.map((m: any) => m.content).join("\n") || "";
	      expect(prompt).toContain("existing_open_matters");
	      expect(prompt).toContain("matter-existing-1");
	      expect(prompt).toContain("s-matter-1");
	      expect(prompt).toContain("s-matter-2");
	      expect(prompt).toContain("北京时间");
	      expect(prompt).toContain("started_at_beijing");
	      if (fetchCount === 1) {
	        expect(prompt).toContain("trigger_session_changes");
	      }
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "命中既有事项，规划更新 matter-existing-1。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "事项归档整合更新",
              type: "Feature",
              topic: "事项归档整合",
              session_ids: ["s-matter-1", "s-matter-2"],
              existing_matter_id: "matter-existing-1",
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按当前 plan 写入单个事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                id: "matter-existing-1",
                title: "事项归档整合更新",
                type: "Feature",
                topic: "事项归档整合",
                summary: "Agent 更新既有事项而不是新增重复事项。",
                result: "既有事项已被整合更新。",
                markdown: "## 摘要\nAgent 根据 existing_open_matters 命中 matter-existing-1，并整合更新事项正文。",
                dependency_refs: ["packages/server/src/services/agents.ts"],
                timeline_points: ["2026-07-08T02:01:00.000Z: 用户要求更新既有事项"],
              },
            }],
          })
          : JSON.stringify({
            thought: "事项写入工具已完成。",
            final: { summary: "已更新 matter-existing-1。" },
          });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_ids: ["s-matter-1", "s-matter-2"],
          trigger: "chat_event",
          run_reason: "throttled_matter_archive",
          force: true,
        }),
      });
      const body = await res.json();
      const matters = db.query("SELECT id, title, markdown FROM matter_archives ORDER BY id").all() as any[];
      const toolNames = db.query("SELECT tool_name FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at").all({ $job_id: body.id }).map((row: any) => row.tool_name);
      const linkedSessions = db.query("SELECT session_id FROM matter_sessions WHERE matter_id = 'matter-existing-1' ORDER BY session_id").all().map((row: any) => row.session_id);

      expect(res.status).toBe(200);
      expect(matters.length).toBe(1);
      expect(matters[0].id).toBe("matter-existing-1");
      expect(matters[0].title).toBe("事项归档整合更新");
      expect(matters[0].markdown).toContain("existing_open_matters");
      expect(toolNames).toContain("matters.query");
      expect(toolNames).toContain("matter.detail.read");
      expect(toolNames).toContain("matter.archive.plan");
      expect(toolNames).toContain("matter.archive.write");
      expect(toolNames).toContain("trigger.session_changes");
      expect(linkedSessions).toEqual(["s-matter-1", "s-matter-2"]);
      expect(fetchCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps updated_at when Matter Archive rewrites identical content", async () => {
    const frozenUpdatedAt = "2026-07-08T02:10:00.000Z";
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-unchanged-1', 'codex', '无变化重写', 'astra', 'deepseek-chat', '2026-07-08T02:00:00.000Z', '已有会话摘要', 1200);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-unchanged-1', 's-matter-unchanged-1', 'user', '用户要求验证无实质变化时不刷新 updated_at。', '2026-07-08T02:01:00.000Z');
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, effort_level, word_target, source_session_count, dependency_refs, timeline_points, updated_at)
      VALUES (
        'matter-unchanged-1',
        'M-0099',
        'Feature',
        'done',
        '事项归档无变化',
        '事项归档整合',
        'Agent 更新既有事项而不是新增重复事项。',
        '既有事项已被整合更新。',
        '## 摘要\nAgent 根据 existing_open_matters 命中 matter-unchanged-1，并整合更新事项正文。',
        'Small',
        300,
        1,
        '["packages/server/src/services/agents.ts"]',
        '["2026-07-08T02:01:00.000Z: 用户要求更新既有事项"]',
        '${frozenUpdatedAt}'
      );
      INSERT INTO matter_sessions (matter_id, session_id) VALUES ('matter-unchanged-1', 's-matter-unchanged-1');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "命中既有事项，规划更新 matter-unchanged-1。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "事项归档无变化",
              type: "Feature",
              topic: "事项归档整合",
              session_ids: ["s-matter-unchanged-1"],
              existing_matter_id: "matter-unchanged-1",
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按当前 plan 写入单个事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                id: "matter-unchanged-1",
                title: "事项归档无变化",
                type: "Feature",
                topic: "事项归档整合",
                summary: "Agent 更新既有事项而不是新增重复事项。",
                result: "既有事项已被整合更新。",
                markdown: "## 摘要\nAgent 根据 existing_open_matters 命中 matter-unchanged-1，并整合更新事项正文。",
                dependency_refs: ["packages/server/src/services/agents.ts"],
                timeline_points: ["2026-07-08T02:01:00.000Z: 用户要求更新既有事项"],
              },
            }],
          })
          : JSON.stringify({
            thought: "事项写入工具已完成。",
            final: { summary: "已更新 matter-unchanged-1。" },
          });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_ids: ["s-matter-unchanged-1"],
          trigger: "chat_event",
          run_reason: "throttled_matter_archive",
          force: true,
        }),
      });
      const body = await res.json();
      const matter = db.query("SELECT id, title, updated_at FROM matter_archives WHERE id = 'matter-unchanged-1'").get() as any;

      expect(res.status).toBe(200);
      expect(matter.updated_at).toBe(frozenUpdatedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bumps updated_at when Matter Archive changes matter content", async () => {
    const frozenUpdatedAt = "2026-07-08T02:10:00.000Z";
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-changed-1', 'codex', '有变化重写', 'astra', 'deepseek-chat', '2026-07-08T02:00:00.000Z', '已有会话摘要', 1200);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-changed-1', 's-matter-changed-1', 'user', '用户要求验证有实质变化时刷新 updated_at。', '2026-07-08T02:01:00.000Z');
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, effort_level, word_target, source_session_count, dependency_refs, timeline_points, updated_at)
      VALUES (
        'matter-changed-1',
        'M-0100',
        'Feature',
        'done',
        '事项归档旧标题',
        '事项归档整合',
        '旧摘要',
        '旧结果',
        '## 摘要\n旧正文',
        'Medium',
        300,
        1,
        '["packages/server/src/services/agents.ts"]',
        '["2026-07-08T02:01:00.000Z: 旧时间线"]',
        '${frozenUpdatedAt}'
      );
      INSERT INTO matter_sessions (matter_id, session_id) VALUES ('matter-changed-1', 's-matter-changed-1');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "命中既有事项，规划更新 matter-changed-1。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "事项归档新标题",
              type: "Feature",
              topic: "事项归档整合",
              session_ids: ["s-matter-changed-1"],
              existing_matter_id: "matter-changed-1",
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按当前 plan 写入单个事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                id: "matter-changed-1",
                title: "事项归档新标题",
                type: "Feature",
                topic: "事项归档整合",
                summary: "新摘要",
                result: "新结果",
                markdown: "## 摘要\n新正文",
                dependency_refs: ["packages/server/src/services/agents.ts"],
                timeline_points: ["2026-07-08T02:01:00.000Z: 新时间线"],
              },
            }],
          })
          : JSON.stringify({
            thought: "事项写入工具已完成。",
            final: { summary: "已更新 matter-changed-1。" },
          });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_ids: ["s-matter-changed-1"],
          trigger: "chat_event",
          run_reason: "throttled_matter_archive",
          force: true,
        }),
      });
      const body = await res.json();
      const matter = db.query("SELECT id, title, updated_at FROM matter_archives WHERE id = 'matter-changed-1'").get() as any;

      expect(res.status).toBe(200);
      expect(matter.title).toBe("事项归档新标题");
      expect(matter.updated_at).not.toBe(frozenUpdatedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs Matter Archive without a selected matter", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-standalone-1', 'codex', '新增事项归档', 'astra', 'deepseek-chat', '2026-07-08T03:00:00.000Z', '需要按 Session 范围归档', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-standalone-1', 's-matter-standalone-1', 'user', '用户要求在没有选中事项时也允许重新归档。', '2026-07-08T03:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "规划一个独立事项。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "无选中事项重新归档",
              type: "Feature",
              topic: "Matter Archive 独立运行",
              session_ids: ["s-matter-standalone-1"],
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按计划写入单个事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "无选中事项重新归档",
                type: "Feature",
                topic: "Matter Archive 独立运行",
                summary: "服务端允许不传 matter_id，直接按 Session 范围运行事项归档。",
                result: "生成新事项。",
                markdown: "## 摘要\n服务端在没有选中事项时按 Session 范围运行 Matter Archive Agent。",
                dependency_refs: ["packages/server/src/routes/agents.ts"],
                timeline_points: ["2026-07-08T03:01:00.000Z: 用户要求无选中事项重新归档"],
              },
            }],
          })
          : JSON.stringify({
            thought: "事项写入工具已完成。",
            final: { summary: "生成新事项。" },
          });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/matters/resummarize?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-matter-standalone-1"], append_matters: true }),
      });
      const body = await res.json();
      const matter = db.query("SELECT id, title FROM matter_archives WHERE title = '无选中事项重新归档'").get() as any;

      expect(res.status).toBe(200);
      expect(body.agent_id).toBe("agent-matter-archive");
      expect(body.matter_id).toBeNull();
      expect(body.run_reason).toBe("matter_resummarize");
      expect(String(matter.id).startsWith("matter-")).toBe(true);
      expect(fetchCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("filters routine GitHub trend report sessions before Matter Archive writes", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-routine-github-1', 'opencode', 'GitHub 技术趋势午报生成', 'astra', 'glm-5.1', '2026-07-08T04:00:00.000Z', '用户要求生成 GitHub/科技趋势午报，并通过 GitHub API、Twitter 搜索和配图生成完成内容产物。', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-routine-github-1', 's-routine-github-1', 'user', '生成一份 GitHub 技术趋势午报，包含项目、Twitter 讨论和配图。', '2026-07-08T04:01:00.000Z');
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-engineering-backup-1', 'opencode', '备份 SQLite 数据库到远程 ITFS 路径', 'astra', 'deepseek-chat', '2026-07-08T04:41:00.000Z', '用户请求将远程服务器 SQLite 数据库备份到 ITFS 路径，Agent 通过 SSH 查找数据库文件。', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-engineering-backup-1', 's-engineering-backup-1', 'user', '把远程服务器 SQLite 数据库备份到 ITFS 路径。', '2026-07-08T04:42:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const allContent = payload.messages?.map((m: any) => m.content).join("\n") || "";
      expect(allContent).not.toContain("GitHub 技术趋势午报生成");
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "例行内容会话已过滤，规划一个工程备份事项。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "远程 SQLite 数据库备份到 ITFS 路径",
              type: "Feature",
              topic: "远程数据库备份",
              session_ids: ["s-engineering-backup-1"],
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "按计划写入工程备份事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "远程 SQLite 数据库备份到 ITFS 路径",
                type: "Feature",
                topic: "远程数据库备份",
                summary: "Agent 归档远程 SQLite 数据库备份事项。",
                result: "事项已写入。",
                markdown: "## 摘要\nAgent 根据工程会话归档远程 SQLite 数据库备份事项。",
                dependency_refs: ["sqlite", "ssh"],
                timeline_points: ["2026-07-08T04:42:00.000Z: 用户要求备份远程 SQLite 数据库"],
              },
            }],
          })
          : JSON.stringify({
            thought: "事项写入工具已完成。",
            final: { summary: "事项已写入。" },
          });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-routine-github-1", "s-engineering-backup-1"], force: true }),
      });
      const body = await res.json();
      const linkedSessions = db.query("SELECT DISTINCT session_id FROM matter_sessions WHERE session_id IN ('s-routine-github-1', 's-engineering-backup-1') ORDER BY session_id").all().map((row: any) => row.session_id);

      expect(res.status).toBe(200);
      expect(linkedSessions).toEqual(["s-engineering-backup-1"]);
      expect(fetchCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("succeeds with empty matter_plan when no engineering matters are planned", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-empty-plan-1', 'codex', '概念讨论未落地', 'astra', 'deepseek-chat', '2026-07-08T04:00:00.000Z', '用户只是讨论概念，没有明确工程改动。', 200);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-empty-plan-1', 's-empty-plan-1', 'user', '先聊聊这个想法，暂时不改代码。', '2026-07-08T04:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: matterPlanSubmit({
              thought: "候选会话没有可归档的工程事项。",
              matter_plan: { planned_matter_count: 0, matters: [] },
              session_dispositions: [{
                session_id: "s-empty-plan-1",
                action: "skip_trivial",
                reason: "仅讨论概念，没有形成可交接工程成果。",
              }],
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-empty-plan-1"], force: true }),
      });
      const body = await res.json();
      const planTool = db.query("SELECT state, detail FROM agent_tool_calls WHERE job_id = $job_id AND tool_name = 'matter.archive.plan'").get({ $job_id: body.id }) as any;
      const matterCount = (db.query("SELECT COUNT(*) as count FROM matter_archives").get() as any).count;

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.error).toBeFalsy();
      expect(body.summary).toContain("实际关联 0 个");
      expect(body.summary).toContain("跳过 1 个");
      expect(body.summary).toContain("覆盖率 100%");
      expect(planTool.state).toBe("ok");
      expect(planTool.detail).toContain("规划 0 个事项");
      expect(matterCount).toBe(0);
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("succeeds when all candidate sessions are routine content", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-all-routine-1', 'opencode', 'GitHub 技术趋势午报生成', 'astra', 'glm-5.1', '2026-07-08T04:00:00.000Z', '用户要求生成 GitHub/科技趋势午报。', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-all-routine-1', 's-all-routine-1', 'user', '生成一份 GitHub 技术趋势午报。', '2026-07-08T04:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-all-routine-1"], force: true }),
      });
      const body = await res.json();
      const matterCount = (db.query("SELECT COUNT(*) as count FROM matter_archives").get() as any).count;

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.error).toBeFalsy();
      expect(body.summary).toContain("候选会话均被判定为定时内容产物");
      expect(matterCount).toBe(0);
      expect(fetchCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("raises word target and passes quantified scope when matter granularity is broad", async () => {
    const sessionIds = Array.from({ length: 10 }, (_, index) => `s-aggregate-${index + 1}`);
    for (const [index, sessionId] of sessionIds.entries()) {
      db.query(`
        INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
        VALUES ($id, 'codex', $title, 'astra', 'deepseek-chat', $started_at, $summary, 9000)
      `).run({
        $id: sessionId,
        $title: `Runmark 归档能力实现 ${index + 1}`,
        $started_at: `2026-07-08T05:${String(index).padStart(2, "0")}:00.000Z`,
        $summary: "用户要求实现 Runmark Matter Archive 归档能力，包括计划、写入、轮询、提示词和验证。",
      });
      db.query(`
        INSERT INTO messages (id, session_id, role, content, created_at)
        VALUES ($id, $session_id, 'user', '继续实现 Runmark Matter Archive 归档能力。', $created_at)
      `).run({
        $id: `m-${sessionId}`,
        $session_id: sessionId,
        $created_at: `2026-07-08T05:${String(index).padStart(2, "0")}:30.000Z`,
      });
    }

    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const allContent = payload.messages?.map((m: any) => m.content).join("\n") || "";
      if (fetchCount === 1) {
        expect(allContent).toContain("archive_scope_metrics");
        expect(allContent).toContain("engineering_candidate_sessions");
      }
      if (fetchCount === 2) {
        expect(allContent).toContain("\"scope_pressure_level\":\"aggregated\"");
        expect(allContent).toContain("\"min_word_target\":1200");
        expect(allContent).toContain("进展量化");
      }
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "10 个工程会话只拆成 2 个事项，颗粒度较大，需要高层级标题。",
          matter_plan: {
            planned_matter_count: 2,
            matters: [{
              project: "Runmark",
              user_intent: "用户希望实现 Matter Archive 的稳定归档与总结能力。",
              classification_reason: {
                matter_type_reason: "该事项实现新的归档能力，属于 Feature。",
                title_reason: "标题先声明 Runmark 项目，再声明 Matter Archive 能力实现。",
              },
              title: "Runmark：Feature，Matter Archive 归档能力实现",
              type: "Feature",
              topic: "Matter Archive 归档能力",
              session_ids: sessionIds.slice(0, 6),
            }, {
              project: "Runmark",
              user_intent: "用户希望完善 Agent 运行状态与前端轮询反馈。",
              classification_reason: {
                matter_type_reason: "该事项实现异步 job 与轮询能力，属于 Feature。",
                title_reason: "标题先声明 Runmark 项目，再声明 Agent Run 轮询能力。",
              },
              title: "Runmark：Feature，Agent Run 异步轮询能力实现",
              type: "Feature",
              topic: "Agent Run 异步轮询",
              session_ids: sessionIds.slice(6),
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "写入第一个高颗粒度事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "Runmark：Feature，Matter Archive 归档能力实现",
                type: "Feature",
                topic: "Matter Archive 归档能力",
                summary: "Runmark 实现 Matter Archive 归档能力，覆盖多个工程会话。",
                result: "事项已按高颗粒度要求写入。",
                markdown: "## 归类\n项目：Runmark。\n用户意图：用户希望实现 Matter Archive 的稳定归档与总结能力。\n事项类型依据：该事项实现新的归档能力，属于 Feature。\n标题依据：标题先声明 Runmark 项目，再声明 Matter Archive 能力实现。\n\n## 摘要\nRunmark Matter Archive 归档能力已形成高层级事项。\n\n## 进展量化\n已完成 6 个工程会话归并，未完成 0 个会话归并，下一步 Loop 需要继续检查正文质量。",
                dependency_refs: ["packages/server/src/services/agents.ts"],
                timeline_points: ["2026-07-08T05:00:00.000Z: 开始聚合 Matter Archive 归档能力"],
              },
            }],
          })
          : fetchCount === 3
            ? JSON.stringify({
              thought: "第一个事项写入完成。",
              final: { summary: "已写入第一个高颗粒度事项。" },
            })
            : fetchCount === 4
              ? JSON.stringify({
                thought: "写入第二个高颗粒度事项。",
                tool_calls: [{
                  name: "matter.archive.write",
                  arguments: {
                    title: "Runmark：Feature，Agent Run 异步轮询能力实现",
                    type: "Feature",
                    topic: "Agent Run 异步轮询",
                    summary: "Runmark 实现 Agent Run 异步 job 与前端轮询反馈能力。",
                    result: "第二个事项已按高颗粒度要求写入。",
                    markdown: "## 归类\n项目：Runmark。\n用户意图：用户希望完善 Agent 运行状态与前端轮询反馈。\n事项类型依据：该事项实现异步 job 与轮询能力，属于 Feature。\n标题依据：标题先声明 Runmark 项目，再声明 Agent Run 轮询能力。\n\n## 摘要\nRunmark Agent Run 异步轮询能力已形成高层级事项。\n\n## 进展量化\n已完成 4 个工程会话归并，未完成 0 个会话归并，下一步 Loop 需要继续检查状态展示。",
                    dependency_refs: ["packages/server/src/routes/agents.ts"],
                    timeline_points: ["2026-07-08T05:06:00.000Z: 开始聚合 Agent Run 轮询能力"],
                  },
                }],
              })
              : JSON.stringify({
                thought: "第二个事项写入完成。",
                final: { summary: "已写入第二个高颗粒度事项。" },
              });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: sessionIds, force: true }),
      });
      const body = await res.json();
      const matter = db.query("SELECT title, word_target, source_session_count FROM matter_archives WHERE title = 'Runmark：Feature，Matter Archive 归档能力实现'").get() as any;

      expect(res.status).toBe(200);
      expect(matter.word_target).toBeGreaterThanOrEqual(1000);
      expect(matter.source_session_count).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not write a matter when ReAct stops before matter.archive.write", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-incomplete-1', 'codex', '未完成 ReAct 事项归档', 'astra', 'deepseek-chat', '2026-07-08T04:00:00.000Z', '需要归档', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-incomplete-1', 's-matter-incomplete-1', 'user', '用户要求验证 ReAct 未写入时不能生成脏 matter。', '2026-07-08T04:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "规划一个事项但后续不写入。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "未完成 ReAct 事项归档",
              type: "Fix",
              topic: "Matter Archive ReAct 写入协议",
              session_ids: ["s-matter-incomplete-1"],
            }],
          },
        })
        : JSON.stringify({
            thought: "需要继续读取上下文，还没有生成事项。",
            tool_calls: [{
              name: "session.context.read",
              arguments: { session_id: "s-matter-incomplete-1" },
            }],
          });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-matter-incomplete-1"], force: true }),
      });
      const body = await res.json();
      const matterCount = (db.query("SELECT COUNT(*) as count FROM matter_archives").get() as any).count;

      expect(res.status).toBe(500);
      expect(body.status).toBe("failed");
      expect(body.error).toContain("did not call matter.archive.write");
      expect(matterCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reprompts Matter Archive when ReAct returns final before matter.archive.write", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-repair-1', 'codex', '修复事项归档写入', 'astra', 'deepseek-chat', '2026-07-08T04:30:00.000Z', '需要归档', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-repair-1', 's-matter-repair-1', 'user', '用户要求验证 ReAct final 不能替代 matter.archive.write。', '2026-07-08T04:31:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const allContent = payload.messages?.map((m: any) => m.content).join("\n") || "";
      if (fetchCount === 3) {
        expect(allContent).toContain("required_write_tool_missing");
        expect(allContent).toContain("matter.archive.write");
      }
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "规划一个需要写入的修复事项。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "事项归档写入纠偏",
              type: "Fix",
              topic: "Matter Archive ReAct 写入协议",
              session_ids: ["s-matter-repair-1"],
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "已经形成事项结论，但错误地只输出 final。",
            final: { summary: "准备生成事项归档。" },
          })
          : fetchCount === 3
            ? JSON.stringify({
            thought: "服务端要求必须调用写入工具，现写入事项。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "事项归档写入纠偏",
                type: "Fix",
                topic: "Matter Archive ReAct 写入协议",
                summary: "服务端在 final 早停时要求模型补调 matter.archive.write。",
                result: "事项通过写入工具落库。",
                markdown: "## 摘要\n服务端检测到 Matter Archive Agent 未调用 matter.archive.write 后，追加协议纠偏消息，并要求 Agent 通过写入工具落库。",
                dependency_refs: ["packages/server/src/services/agents.ts"],
                timeline_points: ["2026-07-08T04:31:00.000Z: 用户要求验证 final 不能替代 matter.archive.write"],
              },
            }],
          })
            : JSON.stringify({
              thought: "写入工具已完成。",
              final: { summary: "已写入事项归档。" },
            });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-matter-repair-1"], force: true }),
      });
      const body = await res.json();
      const matter = db.query("SELECT title FROM matter_archives WHERE title = '事项归档写入纠偏'").get() as any;
      const toolNames = db.query("SELECT tool_name FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at").all({ $job_id: body.id }).map((row: any) => row.tool_name);

      expect(res.status).toBe(200);
      expect(matter.title).toBe("事项归档写入纠偏");
      expect(toolNames).toContain("matter.archive.write");
      expect(fetchCount).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps Matter Archive in the ReAct loop when write schema validation fails", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, provider, model, started_at, AISummary, total_tokens)
      VALUES ('s-matter-schema-1', 'codex', '校验事项归档参数', 'astra', 'deepseek-chat', '2026-07-08T04:45:00.000Z', '需要归档', 900);
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('m-matter-schema-1', 's-matter-schema-1', 'user', '用户要求验证 matter.archive.write 参数错误后可以继续 ReAct loop。', '2026-07-08T04:46:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async (_url, init) => {
      fetchCount++;
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const allContent = payload.messages?.map((m: any) => m.content).join("\n") || "";
      if (fetchCount === 3) {
        expect(allContent).toContain("arguments failed validation");
        expect(allContent).toContain("retry_instruction");
        expect(allContent).toContain("session_ids is service-managed");
      }
      const content = fetchCount === 1
        ? matterPlanSubmit({
          thought: "规划一个参数校验事项。",
          matter_plan: {
            planned_matter_count: 1,
            matters: [{
              title: "事项归档参数校验",
              type: "Fix",
              topic: "Matter Archive 参数校验",
              session_ids: ["s-matter-schema-1"],
            }],
          },
        })
        : fetchCount === 2
          ? JSON.stringify({
            thought: "首次写入误传服务端管理字段。",
            tool_calls: [{
              name: "matter.archive.write",
              arguments: {
                title: "事项归档参数校验",
                type: "Fix",
                topic: "Matter Archive 参数校验",
                summary: "服务端需要将参数错误作为 observation 返回。",
                result: "等待修正参数。",
                markdown: "## 摘要\n服务端校验 matter.archive.write 参数。",
                session_ids: ["s-matter-schema-1"],
              },
            }],
          })
          : fetchCount === 3
            ? JSON.stringify({
              thought: "根据 observation 移除服务端管理字段后重新写入。",
              tool_calls: [{
                name: "matter.archive.write",
                arguments: {
                  title: "事项归档参数校验",
                  type: "Fix",
                  topic: "Matter Archive 参数校验",
                  summary: "服务端将参数错误作为 observation 返回，并允许 Agent 修正后继续写入。",
                  result: "事项通过第二次写入工具调用落库。",
                  markdown: "## 摘要\n服务端检测到 matter.archive.write 参数包含 session_ids 后，没有终止任务，而是把校验错误作为 observation 返回给 Matter Archive Agent。",
                  dependency_refs: ["packages/server/src/services/agents.ts"],
                  timeline_points: ["2026-07-08T04:46:00.000Z: 用户要求验证写入参数错误后的 ReAct 续跑"],
                },
              }],
            })
            : JSON.stringify({
              thought: "写入工具已完成。",
              final: { summary: "已写入事项归档。" },
            });
      return new Response(JSON.stringify({
        choices: [{
          message: { content },
        }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/agents/agent-matter-archive/runs?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: ["s-matter-schema-1"], force: true }),
      });
      const body = await res.json();
      const matter = db.query("SELECT title FROM matter_archives WHERE title = '事项归档参数校验'").get() as any;
      const writeCalls = db.query("SELECT state, args, result FROM agent_tool_calls WHERE job_id = $job_id AND tool_name = 'matter.archive.write' ORDER BY created_at").all({ $job_id: body.id }) as any[];

      expect(res.status).toBe(200);
      expect(matter.title).toBe("事项归档参数校验");
      expect(writeCalls.length).toBe(1);
      expect(fetchCount).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps agent run list lightweight and loads large fields from detail endpoint", async () => {
    const largePrompt = "p".repeat(20_000);
    const largeOutput = JSON.stringify({ text: "o".repeat(10_000) });
    const largeToolResult = "r".repeat(20_000);
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at)
      VALUES ('session-large-1', 'codex', '事项归档调试会话', '2026-07-08T04:59:00.000Z');
    `);
    db.query(`
      INSERT INTO agent_jobs (
        id, agent_id, status, trigger, run_reason, target_session_id, started_at, finished_at, duration_ms,
        provider_id, model, input_tokens, output_tokens, total_tokens, cost_usd,
        summary, error, prompt, output_json
      )
      VALUES (
        'job-large-1', 'agent-matter-archive', 'success', 'chat_event', 'throttled_chat_event', 'session-large-1',
        '2026-07-08T05:00:00.000Z', '2026-07-08T05:00:02.000Z', 2000,
        'provider-deepseek-default', 'deepseek-chat', 10, 20, 30, 0,
        '完成事项归档', NULL, $prompt, $output_json
      )
    `).run({ $prompt: largePrompt, $output_json: largeOutput });
    db.query(`
      INSERT INTO agent_tool_calls (id, job_id, tool_name, state, detail, args, result, created_at)
      VALUES ('tool-large-1', 'job-large-1', 'matter.archive.write', 'ok', '写入事项', $args, $result, '2026-07-08T05:00:01.000Z')
    `).run({ $args: JSON.stringify({ matters: [] }), $result: largeToolResult });

    const listRes = await app.request("/v1/agent-runs?limit=80");
    const list = await listRes.json();
    const row = list.items.find((item: any) => item.id === "job-large-1");
    const detailRes = await app.request("/v1/agent-runs/job-large-1");
    const detail = await detailRes.json();

    expect(listRes.status).toBe(200);
    expect(list.total).toBe(1);
    expect(list.limit).toBe(80);
    expect(list.offset).toBe(0);
    expect(list.has_more).toBe(false);
    expect(row.prompt).toBeUndefined();
    expect(row.output_json).toBeUndefined();
    expect(row.target_session_name).toBe("事项归档调试会话");
    expect(row.tool_count).toBe(1);
    expect(row.tools[0].result).toBeUndefined();
    expect(row.tools[0].args).toBeUndefined();
    expect(detailRes.status).toBe(200);
    expect(detail.prompt.length).toBe(20_000);
    expect(detail.output_json).toBe(largeOutput);
    expect(detail.target_session_name).toBe("事项归档调试会话");
    expect(detail.tools[0].result.length).toBe(20_000);
  });

  it("paginates agent run list", async () => {
    const stmt = db.query(`
      INSERT INTO agent_jobs (id, agent_id, status, started_at, duration_ms)
      VALUES ($id, 'agent-session-summary', 'success', $started_at, 1)
    `);
    for (let i = 0; i < 35; i++) {
      stmt.run({
        $id: `job-page-${i}`,
        $started_at: `2026-07-08T06:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }

    const firstRes = await app.request("/v1/agent-runs?limit=30&offset=0");
    const first = await firstRes.json();
    const secondRes = await app.request("/v1/agent-runs?limit=30&offset=30");
    const second = await secondRes.json();

    expect(firstRes.status).toBe(200);
    expect(first.items.length).toBe(30);
    expect(first.total).toBe(35);
    expect(first.has_more).toBe(true);
    expect(secondRes.status).toBe(200);
    expect(second.items.length).toBe(5);
    expect(second.offset).toBe(30);
    expect(second.has_more).toBe(false);
  });

  it("creates provider and model config", async () => {
    const res = await app.request("/v1/system-config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Local OpenAI",
        type: "openai",
        base_url: "http://localhost:9999/v1/chat/completions",
        api_key: "sk-test",
        model: "local-model",
        purpose: "测试",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.config.providers.some((p: any) => p.name === "Local OpenAI")).toBe(true);
    expect(body.config.models.some((m: any) => m.model === "local-model")).toBe(true);
  });

  it("updates an existing provider without replacing api_key when omitted", async () => {
    const createRes = await app.request("/v1/system-config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Editable Provider",
        type: "openai",
        base_url: "http://localhost:9998/v1/chat/completions",
        api_key: "sk-original",
        model: "editable-model",
        purpose: "测试",
      }),
    });
    const created = await createRes.json();
    expect(createRes.status).toBe(201);

    const updateRes = await app.request(`/v1/system-config/providers/${created.providerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Editable Provider Updated",
        type: "openai",
        base_url: "http://localhost:9997/v1/chat/completions",
      }),
    });
    const updated = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updated.config.providers.some((p: any) => p.id === created.providerId && p.name === "Editable Provider Updated" && p.base_url === "http://localhost:9997/v1/chat/completions")).toBe(true);

    const row = db.query("SELECT api_key FROM agent_providers WHERE id = $id").get({ $id: created.providerId }) as any;
    expect(row.api_key).toBe("sk-original");

    const keyUpdateRes = await app.request(`/v1/system-config/providers/${created.providerId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Editable Provider Updated",
        type: "openai",
        base_url: "http://localhost:9997/v1/chat/completions",
        api_key: "sk-rotated",
      }),
    });
    expect(keyUpdateRes.status).toBe(200);
    const rotated = db.query("SELECT api_key FROM agent_providers WHERE id = $id").get({ $id: created.providerId }) as any;
    expect(rotated.api_key).toBe("sk-rotated");
  });

  it("provider test sends X-API-Key when base URL matches AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS", async () => {
    const captured: Array<Record<string, string>> = [];
    const originalFetch = globalThis.fetch;
    const envKey = "AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS";
    const prevMarkers = process.env[envKey];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.push({ ...(init?.headers as Record<string, string> || {}) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      delete process.env[envKey];
      const defaultRes = await app.request("/v1/system-config/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: "http://127.0.0.1:15721/tencent/v1/chat/completions",
          api_key: "ttsw-test",
          model: "hy3-ioa",
        }),
      });
      expect(defaultRes.status).toBe(200);
      expect(captured[0].Authorization).toBe("Bearer ttsw-test");
      expect(captured[0]["X-API-Key"]).toBeUndefined();

      process.env[envKey] = "api.example.com";
      const markedRes = await app.request("/v1/system-config/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: "https://api.example.com/v1/chat/completions",
          api_key: "ac:test",
          model: "deepseek-chat",
        }),
      });
      expect(markedRes.status).toBe(200);
      expect(captured[1].Authorization).toBe("Bearer ac:test");
      expect(captured[1]["X-API-Key"]).toBe("ac:test");
    } finally {
      if (prevMarkers === undefined) delete process.env[envKey];
      else process.env[envKey] = prevMarkers;
      globalThis.fetch = originalFetch;
    }
  });

  it("creates and deletes standalone models under an existing provider", async () => {
    const configRes = await app.request("/v1/system-config");
    const systemConfig = await configRes.json();
    const providerId = systemConfig.providers[0].id;
    const defaultModelId = systemConfig.models[0].id;

    const createRes = await app.request("/v1/system-config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: providerId,
        model: "gpt-4.1-mini",
        purpose: "测试模型",
      }),
    });
    const created = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(created.config.models.some((m: any) => m.model === "gpt-4.1-mini" && m.provider_id === providerId)).toBe(true);

    const deleteUsedRes = await app.request(`/v1/system-config/models/${defaultModelId}`, { method: "DELETE" });
    expect(deleteUsedRes.status).toBe(409);

    const deleteRes = await app.request(`/v1/system-config/models/${created.modelId}`, { method: "DELETE" });
    const deleted = await deleteRes.json();
    expect(deleteRes.status).toBe(200);
    expect(deleted.config.models.some((m: any) => m.id === created.modelId)).toBe(false);
  });

  it("lists and archives matters", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at) VALUES ('s-1', 'codex', '实现 Agent', '2026-07-08T01:00:00.000Z');
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, updated_at)
      VALUES ('matter-1', 'M-0001', 'Feature', 'active', 'Agent 接口实现', '实现 Agent API', '完成 API', '接口可用', '# 摘要', '2026-07-08T01:30:00.000Z');
      INSERT INTO matter_sessions (matter_id, session_id) VALUES ('matter-1', 's-1');
    `);

    const listRes = await app.request("/v1/matters");
    const matters = await listRes.json();
    expect(matters.length).toBe(1);
    expect(matters[0].relatedSessionIds).toEqual(["s-1"]);
    expect(matters[0].relatedSessions).toEqual([{ id: "s-1", title: "实现 Agent" }]);

    const archiveRes = await app.request("/v1/matters/matter-1/archive", { method: "POST" });
    const archived = await archiveRes.json();
    expect(archiveRes.status).toBe(200);
    expect(archived.status).toBe("archived");

    const summaryRes = await app.request("/v1/matters?tab=summary");
    const summaryMatters = await summaryRes.json();
    expect(summaryMatters.some((m: any) => m.id === "matter-1")).toBe(false);

    const archivedListRes = await app.request("/v1/matters?tab=archive");
    const archivedMatters = await archivedListRes.json();
    expect(archivedMatters.some((m: any) => m.id === "matter-1")).toBe(true);
  });

  it("searches and paginates matters", async () => {
    db.exec(`
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, updated_at)
      VALUES
        ('matter-search-1', 'M-0001', 'Feature', 'active', 'Remote session search', '搜索', '支持关键词', '完成', '# Remote session', '2026-07-08T03:00:00.000Z'),
        ('matter-search-2', 'M-0002', 'Fix', 'active', 'Pagination', '翻页', '支持分页', '完成', '# Pagination', '2026-07-08T02:00:00.000Z'),
        ('matter-search-3', 'M-0003', 'API', 'archived', 'Archived remote session', '归档', '搜索关键词', '完成', '# Archive', '2026-07-08T01:00:00.000Z');
    `);

    const searchRes = await app.request("/v1/matters?tab=summary&q=remote%20session");
    const searched = await searchRes.json();
    expect(searched.map((m: any) => m.id)).toEqual(["matter-search-1"]);

    const firstPageRes = await app.request("/v1/matters?tab=summary&limit=1&offset=0");
    const firstPage = await firstPageRes.json();
    const secondPageRes = await app.request("/v1/matters?tab=summary&limit=1&offset=1");
    const secondPage = await secondPageRes.json();
    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(firstPage[0].id).toBe("matter-search-1");
    expect(secondPage[0].id).toBe("matter-search-2");

    const archiveSearchRes = await app.request("/v1/matters?tab=archive&q=remote%20session");
    const archiveSearch = await archiveSearchRes.json();
    expect(archiveSearch.map((m: any) => m.id)).toEqual(["matter-search-3"]);
  });

  it("runs the dedicated Matter Search Agent against read-only archive candidates", async () => {
    db.exec(`
      INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, updated_at)
      VALUES
        ('matter-ai-search', 'M-0101', 'Feature', 'active', 'AI Matter Search', '语义搜索', '为事项归档提供 AI 搜索', '已完成', '# AI Matter Search', '2026-07-20T03:00:00.000Z'),
        ('matter-other', 'M-0102', 'Fix', 'archived', 'Other Matter', '其他', '无关事项', '已完成', '# Other', '2026-07-17T03:00:00.000Z');
      INSERT INTO sessions (id, agent, title, started_at) VALUES ('session-private', 'codex', 'private session', '2026-07-18T01:00:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('message-private', 'session-private', 'user', 'private message content', '2026-07-18T01:00:00.000Z');
    `);
    for (let index = 0; index < 61; index++) {
      db.query(`
        INSERT INTO matter_archives (id, no, type, status, title, topic, summary, result, markdown, updated_at)
        VALUES ($id, $no, 'Feature', 'active', $title, 'noise', 'noise', 'complete', '# Noise', $updated_at)
      `).run({
        $id: `matter-noise-${index}`,
        $no: `M-${String(1100 + index)}`,
        $title: `Noise ${index}`,
        $updated_at: `2026-07-19T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];
    let systemPrompt = "";
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages.find((message: any) => message.role === "user").content;
      prompts.push(prompt);
      systemPrompt = payload.messages.find((message: any) => message.role === "system").content;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ final: { result: { matter_ids: prompt.includes("matter-ai-search") ? ["matter-ai-search", "fabricated-id", "matter-ai-search"] : [] } } }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/matters/agent-search?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "AI semantic matter search" }),
      });
      const body = await res.json();
      const output = JSON.parse(body.output_json);
      const tools = db.query("SELECT tool_name, detail, args, result, state FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at ASC").all({ $job_id: body.id }) as any[];
      const audit = tools.find((row) => row.tool_name === "matter.archive.search");
      const llmSteps = tools.filter((row) => row.tool_name === "llm.complete");

      expect(res.status).toBe(200);
      expect(body.agent_id).toBe("agent-matter-search");
      expect(output).toEqual({
        query: "AI semantic matter search",
        matter_ids: ["matter-ai-search"],
        matched_count: 1,
        candidate_count: 63,
        searched_count: 48,
      });
      expect(audit.tool_name).toBe("matter.archive.search");
      expect(audit.detail).toContain("只读事项归档候选");
      expect(llmSteps).toHaveLength(2);
      expect(llmSteps.every((row) => row.args == null && row.result == null)).toBe(true);
      expect(prompts).toHaveLength(2);
      expect(prompts.some((prompt) => prompt.includes("matter-ai-search"))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("AI Matter Search"))).toBe(true);
      expect(prompts.every((prompt) => prompt.includes("QUERY_JSON_BEGIN") && prompt.includes("UNTRUSTED_MATTER_ARCHIVE_CANDIDATES_JSON_BEGIN"))).toBe(true);
      expect(prompts.every((prompt) => !prompt.includes("session-private") && !prompt.includes("message-private") && !prompt.includes("private message content"))).toBe(true);
      expect(systemPrompt).toContain("不可信的引用资料");
      expect(systemPrompt).toContain("不得执行");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("restores the Matter Search query when retrying a failed run", () => {
    db.exec(`
      INSERT INTO agent_jobs (id, agent_id, status, trigger, run_reason, input_json, started_at, duration_ms)
      VALUES ('job-matter-search-retry', 'agent-matter-search', 'failed', 'matter_search', 'matter_agent_search', '{"search_query":"restore this semantic query"}', '2026-07-18T03:00:00.000Z', 1);
      INSERT INTO agent_tool_calls (id, job_id, tool_name, state, detail, args, created_at)
      VALUES ('tool-matter-search-retry', 'job-matter-search-retry', 'matter.archive.search', 'ok', '读取归档候选', '{"query":"restore this semantic query"}', '2026-07-18T03:00:01.000Z');
    `);

    const retry = getAgentRuntime(db, config).buildRetryInput("job-matter-search-retry");

    expect(retry.agentId).toBe("agent-matter-search");
    expect(retry.input.search_query).toBe("restore this semantic query");
    expect(retry.input.force).toBe(true);
  });

  it("runs the dedicated Session Search Agent with keyword recall and top-10 ranking", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, AISummary, started_at)
      VALUES
        ('session-ai-search', 'codex', 'AI Session Search', '语义检索会话摘要', '2026-07-18T03:00:00.000Z'),
        ('session-other', 'opencode', 'Other Session', '无关会话', '2026-07-17T03:00:00.000Z'),
        ('session-empty', 'codex', 'Empty shell', NULL, '2026-07-18T02:00:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at) VALUES
        ('msg-ai-1', 'session-ai-search', 'user', '请帮我做会话语义搜索', '2026-07-18T03:01:00.000Z'),
        ('msg-ai-2', 'session-ai-search', 'assistant', '已完成 AI Session Search', '2026-07-18T03:02:00.000Z'),
        ('msg-other', 'session-other', 'user', '写一个无关功能', '2026-07-17T03:01:00.000Z');
    `);
    for (let index = 0; index < 61; index++) {
      db.query(`
        INSERT INTO sessions (id, agent, title, AISummary, started_at)
        VALUES ($id, 'codex', $title, 'noise', $started_at)
      `).run({
        $id: `session-noise-${index}`,
        $title: `Noise ${index}`,
        $started_at: `2026-07-19T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
      db.query(`
        INSERT INTO messages (id, session_id, role, content, created_at)
        VALUES ($id, $session_id, 'user', 'noise content', $created_at)
      `).run({
        $id: `msg-noise-${index}`,
        $session_id: `session-noise-${index}`,
        $created_at: `2026-07-19T00:01:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    const originalFetch = globalThis.fetch;
    const prompts: string[] = [];
    let rankSystemPrompt = "";
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages.find((message: any) => message.role === "user").content;
      const system = payload.messages.find((message: any) => message.role === "system").content;
      prompts.push(prompt);
      if (String(prompt).includes("UNTRUSTED_SESSION_CANDIDATES_JSON_BEGIN")) {
        rankSystemPrompt = system;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ final: { result: { session_ids: ["session-ai-search", "fabricated-id", "session-ai-search", "a", "b", "c", "d"] } } }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ final: { result: { keywords: ["AI", "session", "search", "语义"] } } }) } }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/agent-search?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "AI semantic session search" }),
      });
      const body = await res.json();
      const output = JSON.parse(body.output_json);
      const tools = db.query("SELECT tool_name, detail, args, result, state FROM agent_tool_calls WHERE job_id = $job_id ORDER BY created_at ASC").all({ $job_id: body.id }) as any[];
      const keywordTool = tools.find((row) => row.tool_name === "session.keyword.search");
      const digestTool = tools.find((row) => row.tool_name === "session.digest.search");
      const llmSteps = tools.filter((row) => row.tool_name === "llm.complete");

      expect(res.status).toBe(200);
      expect(body.agent_id).toBe("agent-session-search");
      expect(output.query).toBe("AI semantic session search");
      expect(output.session_ids).toEqual(["session-ai-search"]);
      expect(output.matched_count).toBe(1);
      expect(output.candidate_count).toBeGreaterThan(0);
      expect(output.candidate_count).toBeLessThanOrEqual(40);
      expect(output.matched_count).toBeLessThanOrEqual(10);
      expect(Array.isArray(output.keywords)).toBe(true);
      expect(keywordTool.detail).toContain("并行关键字检索");
      expect(digestTool.detail).toContain("语义排序");
      expect(llmSteps.length).toBeLessThanOrEqual(2);
      expect(llmSteps.every((row) => row.args == null && row.result == null)).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("UNTRUSTED_SESSION_CANDIDATES_JSON_BEGIN") && prompt.includes("session-ai-search"))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("AI Session Search"))).toBe(true);
      expect(prompts.every((prompt) => !prompt.includes("session-empty"))).toBe(true);
      expect(rankSystemPrompt).toContain("不可信的引用资料");
      expect(rankSystemPrompt).toContain("最多 10 个");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("restores the Session Search query when retrying a failed run", () => {
    db.exec(`
      INSERT INTO agent_jobs (id, agent_id, status, trigger, run_reason, input_json, started_at, duration_ms)
      VALUES ('job-session-search-retry', 'agent-session-search', 'failed', 'session_search', 'session_agent_search', '{"search_query":"restore this session query"}', '2026-07-18T03:00:00.000Z', 1);
      INSERT INTO agent_tool_calls (id, job_id, tool_name, state, detail, args, created_at)
      VALUES ('tool-session-search-retry', 'job-session-search-retry', 'session.keyword.search', 'ok', '并行关键字检索', '{"query":"restore this session query","keywords":["restore this session query"]}', '2026-07-18T03:00:01.000Z');
    `);

    const retry = getAgentRuntime(db, config).buildRetryInput("job-session-search-retry");

    expect(retry.agentId).toBe("agent-session-search");
    expect(retry.input.search_query).toBe("restore this session query");
    expect(retry.input.force).toBe(true);
  });

  it("falls back to keyword hits when Session Search ranking JSON is malformed", async () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, AISummary, started_at)
      VALUES ('session-json-ok', 'codex', 'Good JSON Session', '合法输出 good batch', '2026-07-18T04:00:00.000Z');
      INSERT INTO messages (id, session_id, role, content, created_at) VALUES
        ('msg-json-ok', 'session-json-ok', 'user', 'good batch semantic search', '2026-07-18T04:01:00.000Z');
    `);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages.find((message: any) => message.role === "user").content;
      const content = String(prompt).includes("UNTRUSTED_SESSION_CANDIDATES_JSON_BEGIN")
        ? '{"final":{"result":{"session_ids":["session-json-ok"]'
        : JSON.stringify({ final: { result: { keywords: ["good", "batch"] } } });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/agent-search?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "good batch" }),
      });
      const body = await res.json();
      const output = JSON.parse(body.output_json);
      const llmSteps = db.query(`
        SELECT state, detail FROM agent_tool_calls
        WHERE job_id = $job_id AND tool_name = 'llm.complete'
        ORDER BY created_at ASC
      `).all({ $job_id: body.id }) as any[];

      expect(res.status).toBe(200);
      expect(body.status).toBe("success");
      expect(body.error).toBeNull();
      expect(output.session_ids).toEqual(["session-json-ok"]);
      expect(output.matched_count).toBeLessThanOrEqual(10);
      expect(llmSteps.some((row) => row.state === "error" && String(row.detail || "").includes("非合法 JSON"))).toBe(true);
      expect(llmSteps.some((row) => row.state === "ok")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("limits vague yesterday searches to sessions inside yesterday's time window", async () => {
    const { year, month, day } = beijingParts();
    const today = new Date(beijingDateStart(year, month, day).getTime() + 10 * 60 * 60 * 1000);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    db.query(`
      INSERT INTO sessions (id, agent, title, AISummary, started_at)
      VALUES
        ('session-menu-yesterday', 'codex', '菜单样式修改', '调整菜单样式和交互状态', $yesterday),
        ('session-menu-today', 'codex', '今日菜单样式', '今天的菜单样式修改', $today)
    `).run({ $yesterday: yesterday.toISOString(), $today: today.toISOString() });
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES
        ('msg-menu-yesterday', 'session-menu-yesterday', 'user', '修改菜单样式', $yesterday),
        ('msg-menu-today', 'session-menu-today', 'user', '修改菜单样式', $today)
    `).run({ $yesterday: yesterday.toISOString(), $today: today.toISOString() });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const prompt = payload.messages.find((message: any) => message.role === "user").content;
      const content = String(prompt).includes("UNTRUSTED_SESSION_CANDIDATES_JSON_BEGIN")
        ? JSON.stringify({ final: { result: { session_ids: ["session-menu-yesterday", "session-menu-today"] } } })
        : JSON.stringify({ final: { result: { keywords: ["菜单", "样式"], time_range: "yesterday" } } });
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await app.request("/v1/sessions/agent-search?sync=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "我可能在昨天提交过一个关于菜单样式的修改，你帮我找一下" }),
      });
      const body = await res.json();
      const output = JSON.parse(body.output_json);

      expect(res.status).toBe(200);
      expect(output.time_range).toBe("yesterday");
      expect(output.session_ids).toEqual(["session-menu-yesterday"]);
      expect(output.matched_count).toBeLessThanOrEqual(10);
      expect(output.candidate_count).toBeLessThanOrEqual(40);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
