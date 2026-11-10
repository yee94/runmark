import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { MemoryService } from "../src/services/memory";
import { getAgentRuntime, MEMORY_CONSOLIDATION_AGENT_ID, MEMORY_RECALL_AGENT_ID } from "../src/services/agents";
import { createMemoriesRoute } from "../src/routes/memories";
import type { ServerConfig } from "../src/config";

let db: Database;
let memory: MemoryService;
const context = { session_id: "source" };
const originalFetch = globalThis.fetch;
const config = { llmApiKey: "test" } as ServerConfig;
function seed(name: string, scope: "global" | "project" = "project", agent_key = "") {
  db.query("UPDATE messages SET agent_key=? WHERE id='user'").run(agent_key);
  return memory.create({ ...context, scope, agent_key }, {
    operation_id: name, source: { session_id: "source", message_id: "user", explicit: true },
    name, type: "user", description: `摘要 ${name}`, body: `完整事实 ${name}`,
  });
}
beforeEach(() => {
  db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(SCHEMA_SQL);
  db.query("INSERT INTO sessions(id,agent,repo_url,started_at) VALUES ('source','opencode','https://git.test/project','2026-11-03')").run();
  db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES ('user','source','user','今后发布前核对分支','2026-11-03')").run();
  memory = new MemoryService(db);
});
afterEach(() => { globalThis.fetch = originalFetch; db.close(); });

test("full catalogs span every page without injecting bodies", () => {
  for (let i = 0; i < 230; i++) seed(`fact-${i}`);
  const catalog = memory.catalog(context);
  expect(catalog.items).toHaveLength(230);
  expect(catalog.has_more).toBe(false);
  expect(catalog.items.every(item => !("body" in item))).toBe(true);
});

test("curated groups retain every fact and source, and only change the selected index", () => {
  const a = seed("release-branch"), b = seed("release-target"), c = seed("temporary-detail");
  const before = memory.indexState(context);
  const oldIndexVersion = memory.index(context).version;
  const entries = [{ id: a.id, related_ids: [b.id], description: "发布前核对目标分支，完整边界见正文" }];
  const version = memory.version(context);
  expect(memory.consolidateIndex(context, version, entries, "job-index").changed).toBe(true);
  expect(memory.indexState(context)).not.toEqual(before);
  const state = memory.indexState(context);
  expect(memory.consolidateIndex(context, version, entries, "job-index-replay").changed).toBe(false);
  expect(memory.indexState(context)).toEqual(state);
  const index = memory.index(context);
  expect(index.version).not.toBe(oldIndexVersion);
  expect(index.markdown).toContain(a.id);
  expect(index.markdown).not.toContain(b.id);
  expect(index.markdown).not.toContain(c.id);
  expect(index.markdown).not.toContain("完整事实");
  expect(memory.catalog(context).items).toHaveLength(3);
  const detail = memory.read(context, a.id);
  expect(detail.related_memories[0]).toMatchObject({ id: b.id, body: "完整事实 release-target" });
  expect(detail.related_memories[0].sources[0].message_id).toBe("user");
  expect(memory.read(context, c.id).body).toBe("完整事实 temporary-detail");
  expect(db.query("SELECT status,revision FROM memories WHERE id=?").get(b.id)).toEqual({ status: "active", revision: 1 });
  expect(db.query("SELECT job_id FROM memory_index_snapshots").get()).toEqual({ job_id: "job-index" });
});

test("consolidation checks namespace, duplicates, budget and concurrent revisions atomically", () => {
  const a = seed("a"), foreign = seed("foreign", "global");
  const version = memory.version(context);
  const entry = { id: a.id, description: "发布分支约定" };
  expect(() => memory.consolidateIndex(context, version, [{ ...entry, related_ids: [foreign.id] }], "job")).toThrow("same namespace");
  expect(() => memory.consolidateIndex(context, version, [entry, entry], "job")).toThrow("unique");
  expect(() => memory.consolidateIndex(context, version, [{ ...entry, description: "x".repeat(151) }], "job")).toThrow("150");
  expect(() => memory.consolidateIndex({ ...context, view: "effective" }, version, [], "job")).toThrow("exact namespace");
  seed("later");
  expect(() => memory.consolidateIndex(context, version, [entry], "job")).toThrow("changed");
  expect(db.query("SELECT COUNT(*) AS n FROM memory_index_snapshots").get()).toEqual({ n: 0 });
});

test("forgetting invalidates grouped views immediately without resurrecting the forgotten body", () => {
  const a = seed("a"), b = seed("b");
  memory.consolidateIndex(context, memory.version(context), [{ id: a.id, related_ids: [b.id], description: "合并摘要" }], "job");
  const state = memory.indexState(context);
  memory.forget(context, b.id, { expected_revision: 1, operation_id: "forget-b", source: { session_id: "source", message_id: "user", explicit: true } });
  expect(memory.read(context, a.id).related_memories).toBeUndefined();
  expect(memory.index(context).markdown).not.toContain(b.id);
  expect(memory.list(context).items.every(item => item.recall_count === 0)).toBe(true);
  expect(() => memory.read(context, b.id)).toThrow("forgotten");
  expect(memory.indexState(context)).toEqual(state);
});

test("effective curated indexes keep shared and named Agent namespaces separate", () => {
  const shared = seed("shared"), named = seed("named", "project", "opencode/build");
  const namedContext = { ...context, agent_key: "opencode/build" };
  memory.consolidateIndex(namedContext, memory.version(namedContext), [{ id: named.id, description: "只对 build 生效" }], "job");
  const effective = memory.index({ ...namedContext, view: "effective" });
  expect(effective.markdown).toContain(shared.id);
  expect(effective.markdown).toContain(named.id);
  expect(memory.index({ ...context, view: "effective" }).markdown).not.toContain(named.id);
});

test("consolidation Agent reads grouped bodies and persists a versioned index through its write tool", async () => {
  const a = seed("branch"), b = seed("target");
  const runtime = getAgentRuntime(db, config);
  let calls = 0;
  let snapshot: any;
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (!calls++) snapshot = JSON.parse(request.messages[1].content.split("context_package:\n")[1]);
    const tool_calls = calls === 1
      ? [a, b].map(item => ({ name: "memory.read", arguments: { id: item.id } }))
      : [{ name: "memory.consolidation.write", arguments: { expected_version: snapshot.expected_version, entries: [{ id: a.id, related_ids: [b.id], description: "发布前核对目标分支" }] } }];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ tool_calls }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }) as typeof fetch;
  expect(runtime.listAgents().find(agent => agent.id === MEMORY_CONSOLIDATION_AGENT_ID)?.enabled).toBe(false);
  const job = await runtime.runAgent(MEMORY_CONSOLIDATION_AGENT_ID, { ...context, force: true });
  expect(job.status).toBe("success");
  expect(calls).toBe(2);
  expect(job.total_tokens).toBe(30);
  expect(memory.index(context).markdown).toContain("发布前核对目标分支");
  expect(memory.index(context).markdown).not.toContain(b.id);
});

test("recall API selects only applicable IDs with bounded output and records usage", async () => {
  const a = seed("release"), b = seed("exclude");
  const privateFact = seed("private", "project", "opencode/plan");
  const runtime = getAgentRuntime(db, config);
  db.query("UPDATE agents SET enabled=1 WHERE id=?").run(MEMORY_RECALL_AGENT_ID);
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    const manifest = JSON.parse(request.messages[1].content.split("context_package:\n")[1]).manifest;
    expect(manifest.map((item: any) => item.id)).toEqual([a.id]);
    expect(request.max_tokens).toBe(512);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ tool_calls: [{ name: "memory.recall.select", arguments: { ids: [a.id, a.id, b.id, privateFact.id, "invented"] } }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }) as typeof fetch;
  const app = createMemoriesRoute(db, config);
  const result = await app.request("/v1/memories/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "source", query: "发布前该核对哪个分支", exclude_ids: [b.id] }) });
  expect(result.status).toBe(200);
  const output: any = await result.json();
  expect(output.items.map((item: any) => item.id)).toEqual([a.id]);
  expect(output.items[0].body).toContain("完整事实");
  expect(output.items[0].recall_count).toBe(1);
  expect(memory.list(context).items.find(item => item.id === a.id)?.recall_count).toBe(1);
  expect(memory.list(context).items.find(item => item.id === b.id)?.recall_count).toBe(0);
  expect(calls).toBe(1);
  expect(runtime.listJobs().find(job => job.agent_id === MEMORY_RECALL_AGENT_ID).total_tokens).toBe(15);
});

test("disabled or failing recall never retries or falls back to keyword matching", async () => {
  seed("release");
  const runtime = getAgentRuntime(db, config);
  const app = createMemoriesRoute(db, config);
  const request = () => app.request("/v1/memories/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "source", query: "发布" }) });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }); }) as typeof fetch;
  expect(await (await request()).json()).toEqual({ items: [] });
  expect(calls).toBe(0);
  db.query("UPDATE agents SET enabled=1 WHERE id=?").run(MEMORY_RECALL_AGENT_ID);
  expect(await (await request()).json()).toEqual({ items: [] });
  expect(calls).toBe(1);
});
