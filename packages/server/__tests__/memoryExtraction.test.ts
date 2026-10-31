import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_SQL } from "../src/db/schema";
import { createAgentsRoute } from "../src/routes/agents";
import { createMemoriesRoute } from "../src/routes/memories";
import { getAgentRuntime, MEMORY_EXTRACTION_AGENT_ID, seedBuiltinAgentConfig } from "../src/services/agents";
import { AgentThrottleScheduler } from "../src/services/agentScheduler";
import { costService } from "../src/services/cost";
import type { ServerConfig } from "../src/config";

describe("Memory extraction through Agent and Memory APIs", () => {
  let db: Database;
  let app: Hono;
  let config: ServerConfig;
  const originalFetch = globalThis.fetch;
  let requests: any[];
  let changes: any[];
  let toolSteps: any[][];
  let previousPricing: ReturnType<typeof costService.getPricing>;
  const write = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const configPath = `/v1/agents/${MEMORY_EXTRACTION_AGENT_ID}/config`;
  const message = (id: string, content: string, role = "user", session = "source") => {
    db.query("INSERT OR IGNORE INTO messages(id,session_id,role,content,created_at) VALUES (?,?,?,?,?)")
      .run(id, session, role, content, "2020-01-01T00:00:00Z");
  };
  const run = () => getAgentRuntime(db, config).runAgent(MEMORY_EXTRACTION_AGENT_ID, { session_id: "source" });
  const list = async () => (await (await app.request("/v1/memories?session_id=source")).json()).items;
  const createChange = (id = "new-user", name = "keep-comments") => ({
    action: "create", message_id: id, name, type: "feedback",
    description: "修改现有代码及注释时读取", body: "保留无关注释。\nWhy: 未知。\nHow to apply: 修改功能时只改相关注释。",
  });

  beforeEach(() => {
    previousPricing = costService.getPricing();
    costService.setPricing([{ provider: "Astra AI Coding", model: "gpt-4o", input_price: 2, output_price: 10 }]);
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    config = { llmApiKey: "test", agentAutoRunEnabled: true, agentThrottleMs: 10 } as ServerConfig;
    app = new Hono();
    app.route("/", createAgentsRoute(db, config));
    app.route("/", createMemoriesRoute(db));
    db.query("UPDATE agent_models SET model='gpt-4o'").run();
    db.query("INSERT INTO sessions(id,agent,repo_url,started_at) VALUES (?,?,?,?)")
      .run("source", "codex", "git@github.com:example/project.git", "2020-01-01T00:00:00Z");
    requests = [];
    toolSteps = [];
    changes = [createChange()];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const calls = toolSteps.shift() ?? [{ name: "memory.extraction.write", arguments: { changes } }];
      for (const call of calls) if (call.name === "memory.extraction.write" && Array.isArray(call.arguments.changes)) {
        call.arguments.changes = call.arguments.changes.map((change: any) => ({scope:"project",assessment:{quote:(db.query("SELECT content FROM messages WHERE id=?").get(change.message_id) as any)?.content ?? "missing",retention_reason:"明确的持续协作约束",scope_reason:"限定当前来源仓库"},...change}));
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ tool_calls: calls }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    costService.setPricing(previousPricing);
    db.close();
  });

  it("defaults off, skips history at enable, and extracts the first new Chinese correction with assistant context", async () => {
    expect((await (await app.request(configPath)).json()).enabled).toBe(false);
    message("old-user", "历史内容不应自动回填");
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "请保留无关注释不要删除");
    message("new-assistant", "明白，只修改与功能有关的注释", "assistant");
    db.query("UPDATE sessions SET AISummary='错误摘要：应该删除所有注释' WHERE id='source'").run();
    const job = await run();
    expect(job.status).toBe("success");
    expect(job.total_tokens).toBe(120);
    expect(job.cost_usd).toBeGreaterThan(0);
    expect(job.cost_usd).toBeCloseTo(0.0004, 9);
    const prompt = requests[0].messages[1].content;
    const context = JSON.parse(prompt.split("context_package:\n")[1]);
    expect(context.messages.map((m: any) => m.id)).toEqual(["new-user", "new-assistant"]);
    expect(prompt).toContain("请保留无关注释不要删除");
    expect(prompt).toContain("明白，只修改与功能有关的注释");
    expect(prompt).not.toContain("错误摘要");
    const items = await list();
    expect(items).toHaveLength(1);
    const detail = await (await app.request(`/v1/memories/${items[0].id}?session_id=source`)).json();
    expect(detail.sources[0].message_id).toBe("new-user");
    expect(detail.sources[0].job_id).toBe(job.id);
    expect(detail.body).toContain("保留无关注释");
    const replay = await run();
    expect(replay.status).toBe("success");
    expect(requests).toHaveLength(1);
    expect(await list()).toHaveLength(1);
  });

  it("upgrades only the Memory prompt protocol while retaining its enabled state and extraction cursor", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "保留无关注释");
    expect((await run()).status).toBe("success");
    db.query("UPDATE agents SET system_prompt='agent-tracker-react-tools-v10 old project prompt', label='项目记忆提取' WHERE id=?")
      .run(MEMORY_EXTRACTION_AGENT_ID);
    seedBuiltinAgentConfig(db);
    const updated = await (await app.request(configPath)).json();
    expect(updated.enabled).toBe(true);
    expect(updated.system_prompt).toContain("memory-scopes-v3");
    expect((await run()).status).toBe("success");
    expect(requests).toHaveLength(1);
    expect(await list()).toHaveLength(1);
  });

  it("rolls back every write and progress on a bad batch, then retries the original source", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "请保留无关注释");
    changes = [{ ...createChange(), scope: "global" }, { ...createChange("new-user", "bad"), type: "invalid", scope: "project" }];
    const failed = await run();
    expect(failed.status).toBe("failed");
    expect(failed.total_tokens).toBeGreaterThan(0);
    expect(failed.cost_usd).toBeGreaterThan(0);
    expect(failed.cost_usd).toBeCloseTo(failed.input_tokens * 2 / 1_000_000 + failed.output_tokens * 10 / 1_000_000, 9);
    expect(await list()).toEqual([]);
    expect((await (await app.request("/v1/memories?scope=global")).json()).items).toEqual([]);
    changes = [createChange()];
    const succeeded = await run();
    expect(succeeded.status).toBe("success");
    expect(await list()).toHaveLength(1);
  });

  it("requires source-backed decisions, stores reasons and records deliberate skips", async () => {
    await app.request(configPath, write({enabled:true}));
    message("new-user", "以后所有项目都用中文解释");
    changes = [{...createChange(),scope:"global",assessment:{quote:"编造原文",retention_reason:"长期偏好",scope_reason:"所有项目"}}];
    expect((await run()).status).toBe("failed");
    changes[0].assessment.quote="以后所有项目都用中文解释";
    const job=await run();
    expect(job.status).toBe("success");
    const items=(await (await app.request('/v1/memories?scope=global')).json()).items;
    const detail=await (await app.request(`/v1/memories/${items[0].id}?scope=global`)).json();
    expect(detail.sources[0].assessment).toEqual(changes[0].assessment);
    message("one-off","这次用图解释一下画幅");
    toolSteps=[[{name:"memory.extraction.write",arguments:{changes:[],skipped:[{message_id:"one-off",reason:"单次任务，未表达长期偏好"}]}}]];
    const skipped=await run();
    expect(skipped.status).toBe("success");
    expect(JSON.parse(skipped.output_json!).batches[0].skipped[0].reason).toContain("单次任务");
    const context=JSON.parse(requests.at(-1).messages[1].content.split('context_package:\n')[1]);
    expect(context.source_identity.repo_url).toBe("git://github.com/example/project");
  });

  it("commits global and project facts with the same name together and preserves scoped updates", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "所有项目保留无关注释；本项目还要求新注释遵循现有风格");
    changes = [{ ...createChange(), scope: "global" }, { ...createChange(), scope: "project" }];
    expect((await run()).status).toBe("success");
    const effective = await (await app.request("/v1/memories?session_id=source&view=effective")).json();
    expect(effective.items).toHaveLength(2);
    expect(effective.items.map((item: any) => item.scope).sort()).toEqual(["global", "project"]);
    const global = effective.items.find((item: any) => item.scope === "global");
    const project = effective.items.find((item: any) => item.scope === "project");
    message("correction", "补充所有项目的约定：注释要说明原因");
    changes = [{ action: "update", id: global.id, scope: "global", message_id: "correction", expected_revision: 1,
      body: "保留无关注释，新注释解释原因。\nWhy: 便于理解。\nHow to apply: 所有项目编码时。" }];
    toolSteps = [[{ name: "memory.read", arguments: { id: global.id } }]];
    expect((await run()).status).toBe("success");
    const context = JSON.parse(requests[1].messages[1].content.split("context_package:\n")[1]);
    expect(context.existing_memories.items.map((item: any) => item.id).sort()).toEqual([global.id, project.id].sort());
    expect(requests[2].messages.at(-1).content).toContain(global.id);
    expect((await (await app.request(`/v1/memories/${global.id}?scope=global`)).json()).revision).toBe(2);
    expect((await list())[0]).toMatchObject({ id: project.id, revision: 1, scope: "project" });
  });

  it("extracts global without repository or workspace identity and never treats client as named Agent", async () => {
    db.query("UPDATE sessions SET repo_url=NULL, hostname=NULL, directory=NULL WHERE id='source'").run();
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "今后所有项目都使用中文解释");
    changes = [{ ...createChange(), scope: "global", type: "user", body: "所有项目使用中文解释。" }];
    expect((await run()).status).toBe("success");
    const context = JSON.parse(requests[0].messages[1].content.split("context_package:\n")[1]);
    expect(context.available_scopes).toEqual(["global"]);
    expect(context.source_identity.agent_keys).toEqual([]);
    expect((await (await app.request("/v1/memories?scope=global")).json()).items).toHaveLength(1);
    message("bad-local", "这台机器使用特定路径");
    changes = [{ ...createChange("bad-local", "local-path"), scope: "local" }];
    expect((await run()).status).toBe("failed");
    changes = [];
    expect((await run()).status).toBe("success");
    message("bad-agent", "请记住约定");
    changes = [{ ...createChange("bad-agent", "client-name"), scope: "global", agent_key: "codex" }];
    expect((await run()).status).toBe("failed");
    expect((await (await app.request("/v1/memories?scope=global")).json()).items).toHaveLength(1);
  });

  it("shares project facts across hosts while isolating named Agent facts", async () => {
    db.query("UPDATE sessions SET hostname='host-a', directory='/workspace/project', metadata=? WHERE id='source'")
      .run(JSON.stringify({ agent_key: "reviewer" }));
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "这台机器的项目目录有专用环境；reviewer 请使用严格审查约定");
    db.query("UPDATE messages SET agent_key='reviewer' WHERE id='new-user'").run();
    changes = [{ ...createChange("new-user", "machine-env"), scope: "project" },
      { ...createChange("new-user", "review-rules"), scope: "project", agent_key: "reviewer" }];
    expect((await run()).status).toBe("success");
    const context = JSON.parse(requests[0].messages[1].content.split("context_package:\n")[1]);
    expect(context.available_scopes).toEqual(["global", "project"]);
    expect(context.source_identity.agent_keys).toEqual(["reviewer"]);
    const all = await (await app.request("/v1/memories?session_id=source&view=effective&agent_key=reviewer")).json();
    expect(all.items).toHaveLength(2);
    db.query("INSERT INTO sessions(id,agent,repo_url,hostname,directory,started_at) VALUES (?,?,?,?,?,?)")
      .run("other", "codex", "https://github.com/example/project.git", "host-b", "/workspace/project", "2020-01-01T00:00:00Z");
    const isolated = await (await app.request("/v1/memories?session_id=other&view=effective")).json();
    expect(isolated.items).toHaveLength(1);
    message("other-user", "今天执行一次测试", "user", "other");
    changes = [];
    expect((await getAgentRuntime(db, config).runAgent(MEMORY_EXTRACTION_AGENT_ID, { session_id: "other" })).status).toBe("success");
    const otherContext = JSON.parse(requests[1].messages[1].content.split("context_package:\n")[1]);
    expect(otherContext.existing_memories.items).toHaveLength(1);
    const shared = all.items.find((item: any) => !item.agent_key);
    expect((await app.request(`/v1/memories/${shared.id}?session_id=other&view=effective`)).status).toBe(200);
  });

  it("finds forgotten global records through scoped tools and restores only that scope", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "所有项目保留注释，本项目也记录独立约定");
    changes = [{ ...createChange(), scope: "global" }, { ...createChange(), scope: "project" }];
    expect((await run()).status).toBe("success");
    const item = (await (await app.request("/v1/memories?scope=global")).json()).items[0];
    message("forget-global", "忘记全局注释约定");
    changes = [{ action: "forget", scope: "global", id: item.id, expected_revision: 1, message_id: "forget-global", explicit: true }];
    expect((await run()).status).toBe("success");
    message("restore-global", "重新保存全局注释约定：保留无关注释");
    toolSteps = [[{ name: "memory.list", arguments: { scope: "global", view: "scoped", status: "forgotten" } }]];
    changes = [{ ...createChange("restore-global"), action: "update", scope: "global", id: item.id,
      expected_revision: 2, restore: true, explicit: true }];
    expect((await run()).status).toBe("success");
    const observations = JSON.parse(requests[3].messages.at(-1).content.split("Tool observations JSON:\n")[1]);
    expect(observations.observations[0].result.items[0]).toMatchObject({ id: item.id, revision: 2, scope: "global" });
    expect(observations.observations[0].result.items[0].body).toBeUndefined();
    expect((await (await app.request(`/v1/memories/${item.id}?scope=global`)).json()).revision).toBe(3);
    expect((await list())[0].revision).toBe(1);
  });

  it("keeps named Agent memory bound to each source message when one session switches Agents", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "reviewer 专用的审查约定");
    db.query("UPDATE messages SET agent_key='reviewer' WHERE id='new-user'").run();
    changes = [{ ...createChange(), scope: "global", agent_key: "reviewer" }];
    expect((await run()).status).toBe("success");
    const reviewer = (await (await app.request("/v1/memories?scope=global&agent_key=reviewer")).json()).items[0];
    message("builder-user", "builder 专用的实现约定");
    db.query("UPDATE messages SET agent_key='builder' WHERE id='builder-user'").run();
    changes = [{ ...createChange("builder-user", "builder-rules"), scope: "global", agent_key: "reviewer" }];
    expect((await run()).status).toBe("failed");
    const context = JSON.parse(requests[1].messages[1].content.split("context_package:\n")[1]);
    expect(context.source_identity.agent_keys).toEqual(["builder"]);
    expect(context.existing_memories.items).toEqual([]);
    expect(context.named_agent_memories).toHaveLength(1);
    expect(context.named_agent_memories[0].items).toEqual([]);
    changes = [{ ...createChange("builder-user", "builder-rules"), scope: "global", agent_key: "builder" }];
    toolSteps = [[{ name: "memory.read", arguments: { id: reviewer.id, agent_key: "reviewer" } }]];
    const before = requests.length;
    expect((await run()).status).toBe("success");
    const observations = JSON.parse(requests[before + 1].messages.at(-1).content.split("Tool observations JSON:\n")[1]);
    expect(observations.observations[0].state).toBe("error");
    expect((await (await app.request("/v1/memories?scope=global&agent_key=builder")).json()).items).toHaveLength(1);
    expect((await (await app.request(`/v1/memories/${reviewer.id}?scope=global&agent_key=reviewer`)).json()).revision).toBe(1);
  });

  it("updates the same fact and cannot revive it through replay after forgetting", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "保留无关注释");
    await run();
    const item = (await list())[0];
    message("correction", "再补充：新注释也要遵循原风格");
    changes = [{ action: "update", id: item.id, message_id: "correction", expected_revision: 1,
      body: "保留无关注释，新注释遵循原风格。\nWhy: 未知。\nHow to apply: 修改代码时遵守。" }];
    expect((await run()).status).toBe("success");
    expect((await list())[0]).toMatchObject({ id: item.id, revision: 2 });
    message("forget", "忘记这条注释约定");
    changes = [{ action: "forget", id: item.id, message_id: "forget", expected_revision: 2, explicit: true }];
    expect((await run()).status).toBe("success");
    expect(await list()).toEqual([]);
    expect((await app.request(`/v1/memories/${item.id}?session_id=source`)).status).toBe(410);
    const count = requests.length;
    message("new-user", "保留无关注释");
    expect((await run()).status).toBe("success");
    expect(requests).toHaveLength(count);
    message("replayed-text", "保留无关注释", "assistant");
    expect((await run()).status).toBe("success");
    expect(await list()).toEqual([]);
    expect(requests).toHaveLength(count);
  });

  it("accepts an empty decision, skips assistant-only changes and background sources", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "今天先运行测试");
    changes = [];
    expect((await run()).status).toBe("success");
    expect(await list()).toEqual([]);
    message("assistant-only", "测试完成", "assistant");
    expect((await run()).status).toBe("success");
    expect(requests).toHaveLength(1);
    db.query("UPDATE sessions SET metadata=? WHERE id='source'").run(JSON.stringify({ agent_id: MEMORY_EXTRACTION_AGENT_ID }));
    message("background-user", "合成提取请求");
    expect((await run()).status).toBe("success");
    expect(requests).toHaveLength(1);
  });

  it("does not reset progress on ordinary config edits and rejects stale revisions atomically", async () => {
    await app.request(configPath, write({ enabled: true }));
    message("new-user", "保留无关注释");
    await app.request(configPath, write({ enabled: true, task_brief: "提取长期记忆" }));
    expect((await run()).status).toBe("success");
    const item = (await list())[0];
    message("correction", "新注释也遵循原风格");
    changes = [{ action: "update", id: item.id, message_id: "correction", expected_revision: 0,
      body: "新约定。\nWhy: 未知。\nHow to apply: 编码时。" }];
    expect((await run()).status).toBe("failed");
    expect((await list())[0].revision).toBe(1);
    changes[0].expected_revision = 1;
    expect((await run()).status).toBe("success");
    expect((await list())[0].revision).toBe(2);
    await app.request(configPath, write({ enabled: false }));
    message("while-disabled", "关闭期间的要求不自动回填");
    await app.request(configPath, write({ enabled: true }));
    const count = requests.length;
    expect((await run()).status).toBe("success");
    expect(requests).toHaveLength(count);
  });

  it("debounces raw message events without waiting for turn completion", async () => {
    await app.request(configPath, write({ enabled: true, triggers: [{ id: "chat_event", enabled: true, schedule: "session:debounce:10ms" }] }));
    db.query("UPDATE agents SET enabled=0 WHERE id != ?").run(MEMORY_EXTRACTION_AGENT_ID);
    message("new-user", "请保留无关注释");
    const scheduler = new AgentThrottleScheduler(getAgentRuntime(db, config), config);
    scheduler.scheduleAfterIngest([{ type: "message", session_id: "source", message_id: "new-user", role: "user", content: "请保留无关注释", created_at: "2020-01-01T00:00:00Z" }]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(await list()).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("keeps sources attributable when one debounced job processes several sessions", async () => {
    db.query("INSERT INTO sessions(id,agent,repo_url,started_at) VALUES (?,?,?,?)")
      .run("second", "claude", "https://github.com/example/project.git", "2020-01-01T00:00:00Z");
    await app.request(configPath, write({ enabled: true }));
    message("first-user", "保留无关注释");
    message("second-user", "长期使用中文回复", "user", "second");
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      const context = JSON.parse(payload.messages[1].content.split("context_package:\n")[1]);
      const change = createChange(context.messages[0].id, context.session_id === "source" ? "keep-comments" : "chinese-replies");
      Object.assign(change, {scope:"project",assessment:{quote:context.messages[0].content,retention_reason:"持续约束",scope_reason:"来源项目"}});
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "memory.extraction.write", arguments: { changes: [change] } }] }) } }] }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const job = await getAgentRuntime(db, config).runAgent(MEMORY_EXTRACTION_AGENT_ID, { session_ids: ["source", "second"] });
    expect(job.status).toBe("success");
    expect(await list()).toHaveLength(2);
    for (const item of await list()) {
      const detail = await (await app.request(`/v1/memories/${item.id}?session_id=source`)).json();
      expect(detail.sources[0].job_id).toBe(job.id);
    }
  });
});
