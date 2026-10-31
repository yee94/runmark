import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { SCHEMA_SQL } from "../../server/src/db/schema";
import { createMemoriesRoute } from "../../server/src/routes/memories";
import { createIngestRoute } from "../../server/src/routes/ingest";
import { MemoryService } from "../../server/src/services/memory";
import { MEMORY_MARKER } from "../src/memory";

// 真正的独立二进制宿主，不依赖本机 OpenCode 源码或连接当前服务。
test.skipIf(process.env.RUNMARK_HOST_TEST !== "1")("standalone host sends short index to HTTP provider and real read tool result on continuation", async () => {
  const binary = process.env.OPENCODE_TEST_BINARY ?? Bun.which("opencode");
  if (!binary) throw new Error("Install OpenCode V2 or set OPENCODE_TEST_BINARY");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runmark-memory-host-")));
  const project = join(directory, "project");
  await mkdir(project);
  const repo_url = "https://git.test/memory-host";
  for (const args of [["init"], ["remote", "add", "origin", repo_url]]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: project }).exitCode).toBe(0);
  }
  const db = new Database(":memory:"); db.exec(SCHEMA_SQL);
  db.query("INSERT INTO sessions(id,agent,hostname,directory,started_at) VALUES ('source','codex',?,?,?)").run(hostname(), project, "2026-10-29T00:00:00Z");
  db.query("UPDATE sessions SET repo_url=? WHERE id='source'").run(repo_url);
  db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES ('source-user','source','user','记住发布约定','2026-10-29T00:00:00Z')").run();
  const created = new MemoryService(db).create({ session_id: "source" }, {
    operation_id: "seed", source: { session_id: "source", message_id: "source-user", explicit: true },
    name: "deploy", description: "发布前读取", type: "user", body: "READ_DETAIL_SENTINEL",
  });
  const service = new MemoryService(db);
  const seed = (scope: "global" | "project", name: string, agent_key = "") => {
    db.query("UPDATE messages SET agent_key=? WHERE id='source-user'").run(agent_key);
    return service.create({ session_id: "source", scope, agent_key }, {
      operation_id: name, source: { session_id: "source", message_id: "source-user", explicit: true },
      name, description: name, type: "user", body: `BODY_${name}`,
    });
  };
  const global = seed("global", "global-shared");
  const buildOnly = seed("global", "build-only", "opencode/build");
  const planOnly = seed("global", "plan-only", "opencode/plan");
  const companion = join(directory, "switch-plugin");
  await mkdir(companion);
  await writeFile(join(companion, "package.json"), JSON.stringify({ name: "memory-test-switch", type: "module", exports: "./index.mjs" }));
  await writeFile(join(companion, "index.mjs"), `export default { id: "memory-test-switch", async setup(ctx) {
    await ctx.tool.transform(editor => editor.add({ name: "test_switch_agent", description: "test switch", options: { codemode: false },
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      async execute(input, context) { await ctx.session.switchAgent({ sessionID: context.sessionID, agent: "plan" }); return { content: "switched" }; }
    }));
  }};`);
  const memory = createMemoriesRoute(db);
  const ingest = createIngestRoute(db);
  const requests: any[] = [];
  let indexes = 0;
  let slowIndex = false;
  let indexStarted = 0;
  let providerStarted = 0;
  let switchAt = -1;
  const indexQueries: URL[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1/memories")) {
      if (url.pathname.endsWith("/index")) {
        indexQueries.push(url);
        indexes++; indexStarted = Date.now();
        if (slowIndex) { await Bun.sleep(3000); return Response.json({ markdown: "late index" }); }
      }
      return memory.fetch(req);
    }
    if (url.pathname === "/v1/ingest") return ingest.fetch(req);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    const body = await req.json() as any;
    providerStarted = Date.now();
    requests.push(body);
    const switching = requests.length === switchAt;
    const hasResult = !switching && requests.length >= 3;
    const action = requests.length === 1 ? "read" : "write";
    const args = action === "read" ? { id: created.id } : {
      operation_id: "host-write", scope: "project", agent_key: "opencode/build", name: "new-preference", description: "开始协作时读取", type: "user", body: "请用中文回答",
    };
    const delta = hasResult ? { content: "done" } : { tool_calls: [{ index: 0, id: `call_${action}`, type: "function", function: { name: switching ? "test_switch_agent" : `runmark_memory_${action}`, arguments: JSON.stringify(switching ? {} : args) } }] };
    const chunk = (value: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "memory-test", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, hasResult ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }});
  const config = {
    plugins: [resolve(import.meta.dir, ".."), companion],
    model: "memory-provider/memory-test",
    providers: { "memory-provider": {
      name: "Memory test", package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${server.url}v1`, apiKey: "test", encoding: "none" },
      models: { "memory-test": { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128000, output: 4096 } } },
    } },
  };
  async function run(enabled = true, sessionID?: string, cwd = project) {
    const proc = Bun.spawn([binary!, "run", "--standalone", "--print-logs", "--auto", "--format", "json", "--title", "Memory integration", ...(sessionID ? ["--session", sessionID] : []), "Recall the deploy memory using runmark_memory_read. 另请记住本项目用中文回答。"], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH, TMPDIR: directory, HOME: directory, OPENCODE_TEST_HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_CONFIG_DIR: join(directory, "opencode-config"), OPENCODE_DB: join(directory, "test.db"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
      AGENT_TRACKER_ENDPOINT: server.url.href, AGENT_TRACKER_API_KEY: "test", AGENT_TRACKER_MEMORY_ENABLED: String(enabled),
      AGENT_TRACKER_DEBUG: "true", AGENT_TRACKER_LOG_FILE: join(directory, "tracker.log"),
    },
  });
    const timer = setTimeout(() => proc.kill(), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`host exit=${code}\n${stdout.slice(-5000)}\n${stderr}`);
      return stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.sessionID)?.sessionID as string;
    } finally { clearTimeout(timer); proc.kill(); }
  }
  try {
    const sessionID = await run();
    expect(requests).toHaveLength(3);
    expect(indexes).toBe(1);
    for (const request of requests) expect(JSON.stringify(request).split(MEMORY_MARKER).length - 1).toBe(1);
    expect(JSON.stringify(requests[0])).not.toContain("READ_DETAIL_SENTINEL");
    expect(JSON.stringify(requests.at(-1))).toContain("READ_DETAIL_SENTINEL");
    const saved = new MemoryService(db).list({ repo_url, agent_key: "opencode/build" }).items.find(item => item.name === "new-preference");
    if (!saved) throw new Error(`write failed: ${JSON.stringify(requests.at(-1).messages.filter((m: any) => m.role === "tool"))}\n${await Bun.file(join(directory, "tracker.log")).text().catch(() => "")}`);
    const detail = new MemoryService(db).read({ repo_url, agent_key: "opencode/build" }, saved.id);
    expect(detail.body).toBe("请用中文回答");
    const source = detail.sources[0] as any;
    expect(db.query("SELECT agent, hostname, directory FROM sessions WHERE id=?").get(source.session_id)).toMatchObject({ agent: "opencode", hostname: hostname(), directory: project });
    expect(db.query("SELECT role,content,agent_key FROM messages WHERE id=?").get(source.message_id)).toMatchObject({ role: "user", agent_key: "opencode/build", content: "\"Recall the deploy memory using runmark_memory_read. 另请记住本项目用中文回答。\"" });
    const system = (request: any) => request.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
    expect(system(requests[0])).toContain("查询 Runmark 历史会话与工作记录");
    expect(system(requests.at(-1))).not.toContain(saved.id);
    await run(true, sessionID);
    expect(indexes).toBe(2);
    expect(system(requests.at(-1))).toContain(saved.id);
    expect(system(requests.at(-1)).split(MEMORY_MARKER).length - 1).toBe(1);
    await run();
    expect(indexes).toBe(3);
    expect(system(requests.at(-1))).toContain(saved.id);
    await run(false);
    expect(indexes).toBe(3);
    expect(system(requests.at(-1))).not.toContain(MEMORY_MARKER);
    expect(system(requests.at(-1))).toContain("查询 Runmark 历史会话与工作记录");
    expect(requests.at(-1).tools.some((item: any) => item.function.name.startsWith("runmark_memory_"))).toBe(false);
    slowIndex = true;
    await run();
    expect(indexes).toBe(4);
    expect(system(requests.at(-1))).not.toContain(MEMORY_MARKER);
    expect(providerStarted - indexStarted).toBeGreaterThanOrEqual(900);
    expect(providerStarted - indexStarted).toBeLessThan(2500);
    slowIndex = false;
    switchAt = requests.length + 1;
    const beforeSwitch = indexes;
    await run();
    const switchedRequests = requests.slice(switchAt - 1);
    expect(switchedRequests.length).toBeGreaterThanOrEqual(2);
    expect(system(switchedRequests[0])).toContain(buildOnly.id);
    expect(system(switchedRequests[0])).not.toContain(planOnly.id);
    for (const request of switchedRequests.slice(1)) {
      expect(system(request)).toContain(planOnly.id);
      expect(system(request)).not.toContain(buildOnly.id);
      expect(system(request).split(MEMORY_MARKER).length - 1).toBe(1);
    }
    expect(indexes - beforeSwitch).toBe(2);
    expect(indexQueries.slice(-2).map(url => url.searchParams.get("agent_key"))).toEqual(["opencode/build", "opencode/plan"]);
    const otherProject = join(directory, "other-project");
    await mkdir(otherProject);
    await run(true, undefined, otherProject);
    expect(system(requests.at(-1))).toContain(global.id);
    expect(system(requests.at(-1))).not.toContain(created.id);
    expect(indexQueries.every(url => url.searchParams.get("view") === "effective")).toBe(true);
  } finally {
    server.stop(true); db.close(); await rm(directory, { recursive: true, force: true });
  }
}, 50_000);
