import { afterEach, expect, test } from "bun:test";
import { createMemoryClient, setupMemory, memorySource, MEMORY_MARKER, type MemoryHost } from "../src/memory";
import { loadPluginConfig } from "../src/index";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { servers.splice(0).forEach(server => server.stop(true)); });

test("memory is opt-in independently of telemetry", () => {
  const previous = process.env.AGENT_TRACKER_MEMORY_ENABLED;
  try {
    delete process.env.AGENT_TRACKER_MEMORY_ENABLED;
    expect(loadPluginConfig("/nonexistent/runmark-memory-test-env").memoryEnabled).toBe(false);
    process.env.AGENT_TRACKER_MEMORY_ENABLED = "true";
    const config = loadPluginConfig("/nonexistent/runmark-memory-test-env");
    expect(config.memoryEnabled).toBe(true);
    expect(config.includeMessageContent).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TRACKER_MEMORY_ENABLED;
    else process.env.AGENT_TRACKER_MEMORY_ENABLED = previous;
  }
});

test("memory opt-in also reads opencode.jsonc plugin options", () => {
  const previous = process.env.RUNMARK_MEMORY_ENABLED;
  const previousLegacy = process.env.AGENT_TRACKER_MEMORY_ENABLED;
  try {
    delete process.env.RUNMARK_MEMORY_ENABLED;
    delete process.env.AGENT_TRACKER_MEMORY_ENABLED;
    const missing = "/nonexistent/runmark-memory-test-env";
    expect(loadPluginConfig(missing).memoryEnabled).toBe(false);
    expect(loadPluginConfig(missing, { memoryEnabled: true }).memoryEnabled).toBe(true);
    expect(loadPluginConfig(missing, { memoryEnabled: "true" }).memoryEnabled).toBe(true);
    expect(loadPluginConfig(missing, { memoryEnabled: false }).memoryEnabled).toBe(false);
    expect(loadPluginConfig(missing, { memoryEnabled: "yes" }).memoryEnabled).toBe(false);
    expect(loadPluginConfig(missing, "string-entry").memoryEnabled).toBe(false);
    process.env.RUNMARK_MEMORY_ENABLED = "true";
    expect(loadPluginConfig(missing, { memoryEnabled: false }).memoryEnabled).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.RUNMARK_MEMORY_ENABLED;
    else process.env.RUNMARK_MEMORY_ENABLED = previous;
    if (previousLegacy === undefined) delete process.env.AGENT_TRACKER_MEMORY_ENABLED;
    else process.env.AGENT_TRACKER_MEMORY_ENABLED = previousLegacy;
  }
});

test("write source is a real preceding user, never tool assistant or later prompt; flush precedes result", async () => {
  const host: MemoryHost = { session: {
    hook: async () => ({ dispose: async () => {} }),
    context: async () => [
      { id: "msg_user", type: "user", text: "请记住" },
      { id: "msg_synthetic", type: "synthetic", text: "不是用户" },
      { id: "msg_hidden", type: "user", text: "隐藏", visibility: "hidden" },
      { id: "msg_generated", type: "user", text: "合成", metadata: { synthetic: true } },
      { id: "msg_assistant", type: "assistant" },
      { id: "msg_later", type: "user", text: "未来" },
    ],
  } };
  let flushed = false;
  const flush = async () => { await Bun.sleep(5); flushed = true; };
  const ctx = { sessionID: "ses_1", messageID: "msg_assistant" };
  expect(await memorySource(host, ctx, undefined, flush)).toBe("msg_user");
  expect(flushed).toBe(true);
  await expect(memorySource(host, ctx, "msg_assistant", flush)).rejects.toThrow("unavailable");
  await expect(memorySource(host, ctx, "msg_later", flush)).rejects.toThrow("unavailable");
  await expect(memorySource(host, ctx, "invented", flush)).rejects.toThrow("unavailable");
  await expect(memorySource(host, ctx, "msg_hidden", flush)).rejects.toThrow("unavailable");
  await expect(memorySource(host, ctx, "msg_generated", flush)).rejects.toThrow("unavailable");
  await expect(memorySource(host, { sessionID: "ses_1" }, undefined, flush)).rejects.toThrow("boundary unavailable");
  await expect(memorySource(host, { ...ctx, messageID: "missing" }, undefined, flush)).rejects.toThrow("boundary unavailable");
});
function fixture() {
  let version = 1;
  let failed = false;
  const requests: Array<{ method: string; url: URL; body?: any }> = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    expect(req.headers.get("X-API-Key")).toBe("test-key");
    requests.push({ method: req.method, url, body: req.method === "GET" ? undefined : await req.json() });
    if (failed) return Response.json({ error: "unavailable" }, { status: 503 });
    if (url.pathname.endsWith("/index")) return Response.json({ markdown: `- [fact](memory:mem_1): read for deploy v${version}`, has_more: true });
    if (req.method === "PATCH") return Response.json({ error: "revision conflict" }, { status: 409 });
    return Response.json({ id: "mem_1", scope: "project", agent_key: "", revision: 1, markdown: "DETAIL_ONLY_ON_READ" });
  }});
  servers.push(server);
  const make = () => createMemoryClient({ endpoint: server.url.href, apiKey: "test-key" }, { repo_url: "https://git.test/repo" }, () => {}, async () => "msg_user");
  return { make, requests, next: () => version++, fail: () => { failed = true; } };
}

test("real HTTP index snapshot is session-scoped, refreshable, cold-reloaded and never stacks", async () => {
  const f = fixture();
  const memory = f.make();
  let hook!: Parameters<NonNullable<MemoryHost["session"]>["hook"]>[1];
  const dispose = await setupMemory({
    session: { hook: async (_, handler) => { hook = handler; return { dispose: async () => {} }; } },
    tool: { transform: async callback => { callback({ add() {} }); return { dispose: async () => {} }; } },
  }, memory);
  const event = { sessionID: "ses_1", system: [{ type: "text", text: "original" }] };
  await hook(event);
  f.next();
  await hook(event);
  expect(event.system.filter(p => p.text.startsWith(MEMORY_MARKER))).toHaveLength(1);
  expect(event.system[1].text).toContain("v1");
  expect(event.system[1].text).not.toContain("DETAIL_ONLY");
  expect(f.requests).toHaveLength(1);
  await memory.tools.find(t => t.name.endsWith("refresh"))!.execute({}, { sessionID: "ses_1" });
  await hook(event);
  expect(event.system[1].text).toContain("v2");
  expect(await memory.snapshot("ses_new")).toContain("v2");
  expect(await f.make().snapshot("ses_1")).toContain("v2");
  await dispose();
});

test("tools scope/auth requests, preserve revision conflict, never return cached details on failure", async () => {
  const f = fixture();
  const memory = f.make();
  const execute = (action: string, args: Record<string, unknown>) => memory.tools.find(t => t.name.endsWith(action))!.execute(args, { sessionID: "ses_1" });
  expect((await execute("read", { id: "mem_1" })).content).toContain("DETAIL_ONLY_ON_READ");
  await execute("list", { query: "deploy", cursor: "next", limit: 10 });
  await execute("write", { name: "a", description: "when deploy", type: "user", body: "fact", operation_id: "op1" });
  expect(f.requests[2].body).toMatchObject({ repo_url: "https://git.test/repo", source: { session_id: "ses_1", message_id: "msg_user", explicit: true }, operation_id: "op1" });
  await expect(execute("update", { id: "mem_1", expected_revision: 2, operation_id: "op2" })).rejects.toThrow("409");
  expect((await execute("forget", { id: "mem_1", expected_revision: 2, operation_id: "op3" })).content).toContain("旧内容无法抹除");
  f.fail();
  await expect(execute("read", { id: "mem_1" })).rejects.toThrow("503");
  expect(await memory.snapshot("ses_fail")).toBeUndefined();
  expect(await memory.snapshot("ses_fail")).toBeUndefined();
  expect(f.requests.filter(r => r.url.pathname.endsWith("/index"))).toHaveLength(1);
});

test("automatic index has a one-second deadline and does not retry on continuation", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() { calls++; await Bun.sleep(1600); return Response.json({ markdown: "late" }); } });
  servers.push(server);
  const memory = createMemoryClient({ endpoint: server.url.href, apiKey: "key" }, {}, () => {});
  const start = Date.now();
  expect(await memory.snapshot("ses_1")).toBeUndefined();
  expect(Date.now() - start).toBeLessThan(1300);
  expect(await memory.snapshot("ses_1")).toBeUndefined();
  expect(calls).toBe(1);
});

test("snapshots isolate named agents, including unknown identity, without extra continuation requests", async () => {
  const f = fixture();
  const memory = f.make();
  await memory.snapshot("same", "build");
  await memory.snapshot("same", "plan");
  await memory.snapshot("same");
  await memory.snapshot("same", "build");
  await memory.snapshot("same", "plan");
  expect(f.requests).toHaveLength(3);
  expect(f.requests.map(r => r.url.searchParams.get("agent_key"))).toEqual(["opencode/build", "opencode/plan", null]);
  expect(f.requests.every(r => r.url.searchParams.get("view") === "effective")).toBe(true);
  await expect(memory.tools.find(t => t.name.endsWith("write"))!.execute({ agent_key: "opencode/plan" }, { sessionID: "same", agent: "build" })).rejects.toThrow("current named Agent");
});

test("location-scoped hooks and tools ignore sessions belonging to another plugin location", async () => {
  const f = fixture();
  let directory = "/repo-a";
  let hook: any;
  const tools: any[] = [];
  const host = {
    location: { directory: "/repo-a" },
    session: {
      get: async () => ({ location: { directory } }),
      hook: async (_: string, handler: any) => { hook = handler; return { dispose: async () => {} }; },
    },
    tool: { transform: async (fn: any) => { fn({ add: (tool: any) => tools.push(tool) }); return { dispose: async () => {} }; } },
  };
  await setupMemory(host, f.make());
  const event = {sessionID:"session", system:[]};
  await hook(event);
  expect(f.requests).toHaveLength(1);
  directory = "/repo-b";
  const foreign = {sessionID:"session", system:[{type:"text",text:MEMORY_MARKER + "other location"}]};
  await hook(foreign);
  expect(foreign.system[0].text).toBe(MEMORY_MARKER + "other location");
  await expect(tools.find(t=>t.name.endsWith("write")).execute({scope:"global"},{sessionID:"session"})).rejects.toThrow("location");
  expect(f.requests).toHaveLength(1);
});
