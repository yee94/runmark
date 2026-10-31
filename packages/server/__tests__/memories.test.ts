import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { SCHEMA_SQL } from "../src/db/schema";
import { createMemoriesRoute } from "../src/routes/memories";
import { MemoryService } from "../src/services/memory";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { initializeDatabase, resetDatabase } from "../src/db";
import { ingestService } from "../src/services/ingest";
import { repairReviewed } from "../../../scripts/memory/repair-reviewed";

describe("Project memory API", () => {
  let db: Database;
  let app: Hono;
  let service: MemoryService;
  const context = { session_id: "s1" };
  const source = { session_id: "s1", message_id: "m1", explicit: true };
  function session(id: string, repo: string | null, hostname = "mac", directory = "/code/repo") {
    db.query("INSERT INTO sessions(id,agent,repo_url,hostname,directory,started_at) VALUES (?,'opencode',?,?,?,?)").run(id,repo,hostname,directory,"2026-10-01T00:00:00Z");
  }
  function message(id: string, sid = "s1", time = "2026-10-01T00:00:00Z", role = "user") {
    db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES (?,?,?,'请记住优先使用中文',?)").run(id,sid,role,time);
  }
  const write = (operation_id = "op1", name = "language") => ({ operation_id, source, name, description: "开始协作时读取语言偏好", type: "user", body: "优先中文。[[missing-reference]]" });
  async function request(method: string, path = "", body?: unknown, query = "session_id=s1") {
    const response = await app.request(`/v1/memories${path}?${query}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  beforeEach(() => {
    db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(SCHEMA_SQL);
    app = new Hono().route("/", createMemoriesRoute(db)); service = new MemoryService(db);
    session("s1", "git@github.com:Org/Repo.git");
    session("s2", "https://github.com/Org/Repo/", "other", "/worktrees/branch");
    session("foreign", "https://github.com/fork/Repo");
    message("m1"); message("m2","s2"); message("mf","foreign");
  });
  afterEach(() => db.close());

  it("repairs reviewed identities atomically and invalidates over-extracted facts without losing source history", async () => {
    const a=(await request("POST","",write())).data;
    const b=(await request("POST","",write("second","temporary"))).data;
    const plan={sessions:[{id:"s1",directory:"/code/repo",old_repo:"git@github.com:Org/Repo.git",repo:"https://github.com/Org/Correct"}],memories:[
      {id:a.id,revision:1,project_id:a.project_id,action:"relocate" as const,quote:"请记住优先使用中文",reason:"已核对真实工作目录 remote"},
      {id:b.id,revision:1,project_id:b.project_id,action:"invalidate" as const,quote:"请记住优先使用中文",reason:"撤销测试中模拟的过度提取"},
    ]};
    repairReviewed(db,plan);
    expect(service.read(context,a.id).revision).toBe(1);
    expect(()=>repairReviewed(db,{...plan,memories:[plan.memories[0]!,{...plan.memories[1]!,revision:99}]},true)).toThrow("Memory changed");
    expect(service.read(context,a.id).revision).toBe(1);
    repairReviewed(db,plan,true);
    const moved=service.read(context,a.id);
    expect(moved.body).toBe(write().body);expect(moved.revision).toBe(2);expect(moved.sources).toHaveLength(2);
    expect(moved.sources[1].action).toBe("relocate");
    expect(()=>service.read({session_id:"s2"},a.id)).toThrow("applicable scope");
    expect((db.query("SELECT status,body,revision FROM memories WHERE id=?").get(b.id))).toEqual({status:"forgotten",body:"",revision:2});
    expect(()=>repairReviewed(db,plan,true)).toThrow("Session changed");
  });

  it("clears stale repository identity after a verified non-Git session update", () => {
    const result=ingestService.ingestBatch(db,[{type:"session.updated",session_id:"s1",directory:"/notes",repo_url:"",branch:""}]);
    expect(result.errors).toHaveLength(0);
    expect(()=>service.resolveProject(context)).toThrow("repository identity");
    expect(service.index({...context,view:"effective"}).namespaces.map(n=>n.scope)).toEqual(["global"]);
  });

  it("keeps effective index links readable when the remote is a local filesystem path", async () => {
    expect((await request("POST", "", {...write("global","global"),scope:"global"})).status).toBe(201);
    const query = new URLSearchParams({view:"effective",repo_url:"/git/remotes/repo.git",hostname:"mac",directory:"/code/repo"}).toString();
    const index = await request("GET", "/index", undefined, query);
    expect(index.status).toBe(200);
    expect(index.data.markdown).toContain("global / shared");
    const links = [...index.data.markdown.matchAll(/\]\(([^)]+)\)/g)].map((match:any)=>match[1]);
    expect(links).toHaveLength(1);
    for (const link of links) {
      expect(link).not.toContain("repo_url");
      const response = await app.request(link);
      expect(response.status).toBe(200);
      expect((await response.json() as any).body).toContain("优先中文");
    }
  });

  it("uses message IDs for named Agent requests, preserves legacy hook deduplication and permits identical new restore requests", () => {
    const event = {type:"message" as const,session_id:"s1",message_id:"repeat-first",role:"user" as const,content:"请记住优先中文",agent_key:"opencode/build",created_at:"2026-10-29T00:00:00Z"};
    expect(ingestService.ingestBatch(db,[event]).errors).toHaveLength(0);
    const input = {...write(),type:"user" as const,scope:"global" as const,agent_key:event.agent_key,source:{session_id:"s1",message_id:event.message_id,explicit:true}};
    const memory = service.create(context,input);
    service.forget({scope:"global",agent_key:event.agent_key},memory.id,{operation_id:"forget-repeat",source:input.source,expected_revision:1});
    const repeated = {...event,message_id:"repeat-second"};
    expect(ingestService.ingestBatch(db,[repeated,repeated,event]).errors).toHaveLength(0);
    expect(db.query("SELECT id FROM messages WHERE id LIKE 'repeat-%' ORDER BY id").all()).toEqual([{id:"repeat-first"},{id:"repeat-second"}]);
    const restored = service.update(context,memory.id,{...input,operation_id:"restore-repeat",expected_revision:2,restore:true,source:{...input.source,message_id:repeated.message_id}});
    expect(restored.revision).toBe(3); expect(restored.status).toBe("active");
    const legacy = {...event,agent_key:undefined,message_id:"legacy-hook",content:"旧hook同一请求"};
    expect(ingestService.ingestBatch(db,[legacy,{...legacy,message_id:"legacy-transcript"},legacy]).errors).toHaveLength(0);
    expect(db.query("SELECT id FROM messages WHERE id LIKE 'legacy-%'").all()).toEqual([{id:"legacy-hook"}]);
  });

  it("persists named Agent evidence without treating the client product or identical other-Agent text as identity", () => {
    const events = ["opencode/build", "opencode/plan"].map((agent_key, index) => ({ type: "message" as const, session_id: "s1", message_id: `named-${index}`, role: "user" as const, content: "记住这个长期偏好", agent_key, created_at: "2026-10-29T00:00:00Z" }));
    expect(ingestService.ingestBatch(db, events).errors).toHaveLength(0);
    expect(db.query("SELECT agent_key FROM messages WHERE id LIKE 'named-%' ORDER BY id").all()).toEqual([{agent_key:"opencode/build"},{agent_key:"opencode/plan"}]);
    const input = {...write(), type:"user" as const, scope:"global" as const, agent_key:"opencode/build", source:{session_id:"s1",message_id:"named-0"}};
    expect(service.create(context,input).agent_key).toBe("opencode/build");
    expect(()=>service.create(context,{...input,operation_id:"wrong",name:"wrong",source:{session_id:"s1",message_id:"named-1"}})).toThrow("another named Agent");
  });

  it("shares all applicable namespaces across machines and isolates named Agents", async () => {
    db.query("UPDATE sessions SET directory='/foreign/repo' WHERE id='foreign'").run();
    db.query("UPDATE messages SET agent_key='opencode/build' WHERE id='m1'").run();
    const ids: Record<string, string> = {};
    for (const scope of ["global", "project"]) for (const agent_key of ["", "opencode/build"]) {
      const result = await request("POST", "", { ...write(`${scope}-${agent_key}`), scope, agent_key });
      expect(result.status).toBe(201); ids[`${scope}-${agent_key}`] = result.data.id;
      expect(result.data.type).toBe("user"); expect(result.data.scope).toBe(scope);
      expect((await request("POST", "", { ...write(`duplicate-${scope}-${agent_key}`), scope, agent_key })).status).toBe(409);
    }
    const effective = "session_id=s1&view=effective&agent_key=opencode/build";
    expect((await request("GET", "", undefined, effective)).data.items).toHaveLength(4);
    expect((await request("GET", "", undefined, effective)).data.items.map((item:any)=>`${item.scope}/${item.agent_key}`)).toEqual(["project/opencode/build","project/","global/opencode/build","global/"]);
    const index = (await request("GET", "/index", undefined, effective)).data;
    for (const id of Object.values(ids)) expect(index.markdown).toContain(id);
    for (const scope of ["global", "project"]) expect(index.markdown).toContain(`[${scope} / opencode/build]`);
    expect((await request("GET", "", undefined, "session_id=s1&view=effective")).data.items).toHaveLength(2);
    expect((await request("GET", "", undefined, "session_id=s2&view=effective&agent_key=opencode/build")).data.items).toHaveLength(4);
    expect((await request("GET", "", undefined, "session_id=foreign&view=effective")).data.items).toHaveLength(1);
    expect((await request("GET", "", undefined, "view=effective")).data.items).toHaveLength(1);
    expect((await request("GET", "/index", undefined, "view=effective")).status).toBe(200);
    const projectId = (await request("GET", "", undefined, "session_id=s1")).data.project.id;
    expect((await request("GET", "", undefined, `session_id=foreign&view=effective&project_id=${projectId}`)).data.items).toHaveLength(1);
    expect((await request("GET", `/${ids['project-']}`, undefined, "session_id=s2&view=effective")).status).toBe(200);
    expect((await request("GET", `/${ids['global-opencode/build']}`, undefined, "session_id=s1&view=effective&agent_key=opencode/plan")).status).toBe(404);
    expect((await request("GET", `/${ids['global-']}`, undefined, "project_id=global")).status).toBe(404);
    expect((await request("PATCH", `/${ids['project-']}`, { operation_id:"move",source,expected_revision:1,scope:"global",body:"move" })).status).toBe(404);
    expect((await request("POST", "", {...write("wrong-agent","other"),scope:"global",agent_key:"opencode/plan"})).status).toBe(422);
    expect((await request("POST", "", {...write("wrong-local","other"),scope:"local",source:{session_id:"s2",message_id:"m2"}})).status).toBe(400);
    expect((await request("POST", "", {...write("foreign-global","other"),scope:"global",source:{session_id:"foreign",message_id:"mf"}})).status).toBe(201);
    expect((await request("DELETE", `/${ids['global-']}`, {operation_id:"forget-global",source,expected_revision:1,scope:"global"})).status).toBe(200);
    expect((await request("GET", "", undefined, effective + "&status=forgotten")).data.items).toHaveLength(1);
    expect((await request("GET", "", undefined, "session_id=s1&scope=project&status=forgotten")).data.items).toHaveLength(0);
  });

  it("catalogs empty shared scopes and reusable Agent contexts, filters content type before pagination", async () => {
    const empty = (await request("GET", "/scopes")).data.items;
    expect(empty.filter((item:any)=>item.scope==='global' && !item.agent_key)).toHaveLength(1);
    expect(empty.filter((item:any)=>item.scope==='project')).toHaveLength(2);
    expect(empty.filter((item:any)=>item.scope==='local')).toHaveLength(0);
    db.query("UPDATE messages SET agent_key='opencode/build' WHERE id='m1'").run();
    for (let i=0;i<4;i++) {
      await request("POST", "", {...write(`ref-${i}`,`ref-${i}`),scope:"global",agent_key:"opencode/build",type:"reference"});
      await request("POST", "", {...write(`user-${i}`,`user-${i}`),scope:"global",agent_key:"opencode/build"});
    }
    const scopes = (await request("GET", "/scopes")).data.items;
    for (const item of scopes) expect((await request("GET", "", undefined, new URLSearchParams(item.context).toString())).status).toBe(200);
    const agent = scopes.find((item:any)=>item.agent_key==='opencode/build');
    expect(agent.active_count).toBe(8);
    const query = new URLSearchParams({...agent.context,type:"reference",limit:"2"}).toString();
    const page = (await request("GET", "", undefined, query)).data;
    expect(page.items).toHaveLength(2); expect(page.items.every((item:any)=>item.type==='reference')).toBe(true);
    const next = (await request("GET", "", undefined, query + `&cursor=${page.next_cursor}`)).data;
    expect(next.items).toHaveLength(2); expect(next.has_more).toBe(false);
    expect(new Set([...page.items,...next.items].map(item=>item.id)).size).toBe(4);
  });

  it("browses all projects with filtering and pagination without changing effective recall", async () => {
    const first = (await request("POST", "", write())).data;
    const second = (await request("POST", "", {...write("foreign-memory"),source:{session_id:"foreign",message_id:"mf"}}, "session_id=foreign")).data;
    await request("POST", "", {...write("global-memory"),scope:"global"});
    db.query("UPDATE messages SET agent_key='opencode/build' WHERE id='m1'").run();
    await request("POST", "", {...write("agent-memory"),agent_key:"opencode/build"});
    const query = "view=projects&type=user&query=中文&limit=1";
    const page = (await request("GET", "", undefined, query)).data;
    expect(page.items).toHaveLength(1); expect(page.has_more).toBe(true);
    const next = (await request("GET", "", undefined, query + '&cursor=' + page.next_cursor)).data;
    expect(next.items).toHaveLength(1); expect(next.has_more).toBe(false);
    expect(new Set([page.items[0].id,next.items[0].id])).toEqual(new Set([first.id,second.id]));
    expect((await request("GET", `/${second.id}`, undefined, "view=projects")).status).toBe(200);
    expect((await request("GET", `/${second.id}`, undefined, "session_id=s1&view=effective")).status).toBe(404);
    expect((await request("GET", "", undefined, "view=projects&agent_key=opencode/build")).data.items).toHaveLength(1);
    expect((await request("GET", "/index", undefined, "view=projects&agent_key=opencode/missing")).data.markdown).toBe("");
    const index = (await request("GET", "/index", undefined, "view=projects")).data;
    expect(index.markdown).toContain(first.id); expect(index.markdown).toContain(second.id);
    expect(index.markdown).toContain("view=projects");
    expect((await request("GET", "", undefined, "view=projects&scope=global")).status).toBe(400);
    expect((await request("POST", "", write("invalid-view"), "view=projects")).status).toBe(400);
  });

  it("migrates legacy namespaces without changing identities, revisions, provenance or tombstones", async () => {
    const created = (await request("POST", "", write())).data;
    await request("DELETE", `/${created.id}`, {operation_id:"forget",source,expected_revision:1});
    const before = db.query("SELECT * FROM memories").get() as any;
    const sources = db.query("SELECT * FROM memory_sources").all();
    const operations = db.query("SELECT * FROM memory_operations").all();
    for (const column of ["scope","agent_key","context_json"]) db.exec(`ALTER TABLE memories DROP COLUMN ${column}`);
    db.exec("ALTER TABLE messages DROP COLUMN agent_key");
    initializeDatabase(db);
    const after = db.query("SELECT * FROM memories").get() as any;
    expect(after).toEqual({...before,context_json:"{}"}); expect(after.id).toBe(created.id); expect(after.revision).toBe(2);
    expect(db.query("SELECT * FROM memory_sources").all()).toEqual(sources);
    expect(db.query("SELECT * FROM memory_operations").all()).toEqual(operations);
    expect((await request("GET", "", undefined, "session_id=s1&view=effective&status=forgotten")).data.items[0].id).toBe(created.id);
    const scopes = (await request("GET", "/scopes")).data.items;
    expect(scopes.find((item:any)=>item.id===created.project_id).forgotten_count).toBe(1);
  });

  it("budgets the entire effective snapshot and paginates every layer together", async () => {
    for (const scope of ["global","project"]) for (let i=0;i<120;i++) {
      expect((await request("POST", "", {...write(`${scope}-${i}`,`fact-${i}`),scope,description:"读取相关事实。".repeat(100)})).status).toBe(201);
    }
    const index = (await request("GET", "/index", undefined, "session_id=s1&view=effective")).data;
    expect(index.markdown.length).toBeLessThanOrEqual(25000);
    expect(index.markdown.split("\n").length).toBeLessThanOrEqual(200);
    const ids = new Set(index.markdown.split("\n").map((line:string)=>line.match(/memories\/([^?]+)/)![1]));
    let cursor = index.next_cursor;
    while (cursor) {
      const page = (await request("GET", "", undefined, `session_id=s1&view=effective&cursor=${cursor}`)).data;
      for (const item of page.items) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
      cursor = page.next_cursor;
    }
    expect(ids.size).toBe(240);
  });

  it("migrates retired local records without losing facts, sources or forgotten state", async () => {
    const shared = (await request("POST", "", write())).data;
    const old = (await request("POST", "", write("old-local", "machine-fact"))).data;
    const orphan = (await request("POST", "", write("orphan-local", "orphan-fact"))).data;
    await request("DELETE", `/${orphan.id}`, {operation_id:"forget-orphan", source, expected_revision:1});
    db.query("UPDATE memories SET scope='local',project_id='legacy-local',name=? WHERE id=?").run(shared.name, old.id);
    db.query("UPDATE memories SET scope='local',project_id='orphan-local',origin_session_id='removed' WHERE id=?").run(orphan.id);
    const sources = db.query("SELECT * FROM memory_sources ORDER BY memory_id,revision").all();
    const operations = db.query("SELECT * FROM memory_operations ORDER BY project_id,operation_id").all();
    initializeDatabase(db);
    initializeDatabase(db);
    const moved = service.read({session_id:"s2"}, old.id);
    expect(moved).toMatchObject({id:old.id,scope:"project",body:write().body,revision:1,origin_session_id:"s1"});
    expect(moved.name).not.toBe(shared.name);
    expect(service.list({scope:"global"},{status:"forgotten"}).items[0]).toMatchObject({id:orphan.id,revision:2,status:"forgotten"});
    expect(db.query("SELECT * FROM memory_sources ORDER BY memory_id,revision").all()).toEqual(sources);
    expect(db.query("SELECT * FROM memory_operations ORDER BY project_id,operation_id").all()).toEqual(operations);
    expect(service.scopes().items.every(item=>item.scope==='global'||item.scope==='project')).toBe(true);
  });

  it("creates stable structured memory, projects a short index and checks real revision sources", async () => {
    const created = await request("POST", "", write()); expect(created.status).toBe(201);
    const id = created.data.id;
    const read = await request("GET", `/${id}`, undefined, "session_id=s2");
    expect(read.data.markdown).toContain("node_type: memory");
    expect(read.data.markdown).toContain('originSessionId: "s1"');
    expect(read.data.sources[0].available).toBe(1);
    const update = await request("PATCH", `/${id}`, { operation_id:"edit", source: {session_id:"s2",message_id:"m2"}, expected_revision:1, name:"chinese-language", body:"中文回答，术语保留英文。" });
    expect(update.status).toBe(200); expect(update.data.revision).toBe(2); expect(update.data.id).toBe(id);
    const detail = (await request("GET", `/${id}`)).data;
    expect(detail.sources).toHaveLength(2); expect(detail.origin_session_id).toBe("s1");
    const index = (await request("GET", "/index")).data;
    expect(index.markdown).toContain(id); expect(index.markdown).not.toContain("术语保留英文");
    const list = (await request("GET", "", undefined, "session_id=s1&query=术语")).data;
    expect(list.items).toHaveLength(1); expect(list.items[0].body).toBeUndefined();
    db.query("DELETE FROM sessions WHERE id='s1'").run();
    const missingSource = (await request("GET", `/${id}`, undefined, "session_id=s2")).data;
    expect(missingSource.sources[0].available).toBe(0); expect(missingSource.sources[1].available).toBe(1);
  });

  it("isolates projects, resolves worktrees/credentials and rejects insufficient identity", async () => {
    const created = await request("POST", "", write()); const id = created.data.id;
    expect((await request("GET", `/${id}`, undefined, "session_id=foreign")).status).toBe(404);
    expect((await request("GET", `/${id}`, undefined, "repo_url=https%3A%2F%2Fuser%3Asecret%40github.com%2FOrg%2FRepo.git")).status).toBe(200);
    expect((await request("GET", "/index", undefined, "session_id=foreign&repo_url=https://github.com/Org/Repo")).data.markdown).toBe("");
    expect((await request("GET", "/index", undefined, "directory=/code/repo")).status).toBe(422);
    expect((await request("GET", "/index", undefined, "session_id=missing&repo_url=https://github.com/Org/Repo")).status).toBe(404);
    expect(()=>service.resolveProject({hostname:"MAC",directory:"/code/repo"})).toThrow("Project requires repository identity");
    expect(service.resolveProject(context)).toEqual(service.resolveProject({session_id:"s2"}));
    expect(service.resolveProject({repo_url:"https://github.com/org/repo"}).id).not.toBe(service.resolveProject(context).id);
    const badSource = await request("POST", "", {...write("foreign-source","other"),source:{session_id:"foreign",message_id:"mf"}});
    expect(badSource.status).toBe(422);
    const index = (await request("GET", "/index", undefined, "repo_url=https%3A%2F%2Fuser%3Asecret%40github.com%2FOrg%2FRepo")).data;
    expect(index.markdown).not.toContain("secret");
  });

  it("discovers project counts without duplicating worktrees and keeps orphaned memories readable", async () => {
    const created = (await request("POST", "", write())).data;
    session("credentialed", "https://user:secret@github.com/Org/Repo.git");
    const catalog = await request("GET", "/projects", undefined, "");
    expect(catalog.status).toBe(200);
    expect(catalog.data.items.filter((item: any) => item.active_count === 1)).toHaveLength(1);
    expect(JSON.stringify(catalog.data)).not.toContain("secret");
    const project = catalog.data.items.find((item: any) => item.active_count === 1);
    expect((await request("GET", `/${created.id}`, undefined, new URLSearchParams(project.context).toString())).status).toBe(200);
    db.query("DELETE FROM sessions WHERE id != 'foreign'").run();
    const orphan = (await request("GET", "/projects", undefined, "")).data.items.find((item: any) => item.active_count === 1);
    expect(orphan.context.project_id).toBe(created.project_id);
    const detail = await request("GET", `/${created.id}`, undefined, new URLSearchParams(orphan.context).toString());
    expect(detail.status).toBe(200);
    expect(detail.data.sources[0].available).toBe(0);
    expect((await request("GET", "", undefined, "project_id=missing")).status).toBe(404);
  });

  it("enforces idempotency, unique names and revision CAS", async () => {
    const first = await request("POST", "", write());
    const second = await request("POST", "", write());
    expect(second.status).toBe(200); expect(second.data.id).toBe(first.data.id); expect(second.data.replayed).toBe(true);
    expect((await request("POST", "", {...write(), body:"changed"})).status).toBe(409);
    expect((await request("POST", "", write("other-operation"))).status).toBe(409);
    expect((await request("PATCH", `/${first.data.id}`, {operation_id:"bad-rev",source,expected_revision:0,body:"new"})).status).toBe(409);
    expect((await request("PATCH", `/${first.data.id}`, {operation_id:"missing-rev",source,body:"new"})).status).toBe(409);
  });

  it("validates source jobs including sessions in a real batch job", async () => {
    initializeDatabase(db);
    db.query(`INSERT INTO agent_jobs(id,agent_id,status,target_session_id,started_at,input_json)
      VALUES ('job','agent-session-summary','running','s1',?,?)`).run(new Date().toISOString(),JSON.stringify({session_ids:["s1","s2"]}));
    const created = await request("POST", "", {...write(),source:{session_id:"s2",message_id:"m2",job_id:"job"}});
    expect(created.status).toBe(201);
    expect((await request("GET",`/${created.data.id}`)).data.sources[0].job_id).toBe("job");
    expect((await request("POST", "", {...write("wrong-job"),source:{session_id:"foreign",message_id:"mf",job_id:"job"}},"session_id=foreign")).status).toBe(422);
  });

  it("forgets without recall, rejects old-source restore, permits new explicit user restoration", async () => {
    const first = (await request("POST", "", write())).data;
    const oldVersion = (await request("GET", "/index")).data.version;
    const forgotten = await request("DELETE", `/${first.id}`, {operation_id:"forget", source, expected_revision:1});
    expect(forgotten.status).toBe(200); expect(forgotten.data.status).toBe("forgotten");
    expect((await request("GET", `/${first.id}`)).status).toBe(410);
    expect((await request("GET", "/index")).data.markdown).toBe("");
    expect((await request("GET", "/index")).data.version).not.toBe(oldVersion);
    expect((await request("POST", "", write())).data.status).toBe("forgotten");
    expect((await request("POST", "", write("retry-new-op"))).status).toBe(409);
    expect((await request("POST", "", write("renamed-replay","renamed-fact"))).status).toBe(409);
    const restore = {...write("restore"),expected_revision:2,restore:true};
    expect((await request("PATCH", `/${first.id}`, restore)).status).toBe(410);
    message("new-user","s1","2099-01-01T00:00:00Z");
    const restored = await request("PATCH", `/${first.id}`, {...restore,source:{...source,message_id:"new-user"}});
    expect(restored.status).toBe(200); expect(restored.data.revision).toBe(3);
    expect((await request("GET", `/${first.id}`)).data.sources).toHaveLength(3);
    const additional = await request("POST", "", {
      ...write("additional-preference", "concise-replies"),
      source: { ...source, message_id: "new-user" },
      description: "回答问题时读取", body: "回复简短。",
    });
    expect(additional.status).toBe(201);
  });

  it("validates four types, structured fields and source evidence", async () => {
    for (const type of ["user","reference","feedback","project"]) {
      const body = type === "user" || type === "reference" ? "事实" : "事实\nWhy: 未知（来源未说明）\nHow to apply: 开发时遵守";
      expect((await request("POST", "", {...write(type,type),type,body})).status).toBe(201);
    }
    for (const invalid of [{type:"other"},{description:"one\ntwo"},{body:"---\nname: spoof\n---\ntext"},{type:"feedback",body:"No reason"},{scope:"invalid"},{originSessionId:"spoof"},{name:"BAD NAME"},{source:{session_id:"s1",message_id:"missing"}}]) {
      const result = await request("POST", "", {...write("invalid","invalid"),...invalid});
      expect([400,422]).toContain(result.status);
    }
    message("assistant","s1",undefined,"assistant");
    expect((await request("POST", "", {...write("assistant"),source:{...source,message_id:"assistant"}})).status).toBe(422);
  });

  it("discovers forgotten metadata across sessions and restores from a new explicit user request", async () => {
    const created = (await request("POST", "", write())).data;
    expect((await request("DELETE", `/${created.id}`, {operation_id:"forget",source,expected_revision:1})).status).toBe(200);
    expect((await request("GET", "", undefined, "session_id=s2")).data.items).toEqual([]);
    expect((await request("GET", "/index", undefined, "session_id=s2&status=forgotten")).data.markdown).toBe("");
    const forgotten = await request("GET", "", undefined, "session_id=s2&status=forgotten&query=language");
    expect(forgotten.status).toBe(200); expect(forgotten.data.items).toHaveLength(1);
    const item = forgotten.data.items[0];
    expect(item.id).toBe(created.id); expect(item.revision).toBe(2);
    expect(item.status).toBe("forgotten"); expect(item.description).toBe("");
    expect(item.body).toBeUndefined(); expect(item.markdown).toBeUndefined();
    expect((await request("GET", `/${item.id}`, undefined, "session_id=s2")).status).toBe(410);
    expect((await request("GET", "", undefined, "session_id=foreign&status=forgotten")).data.items).toEqual([]);
    expect((await request("GET", "", undefined, "session_id=s2&status=all")).status).toBe(400);
    message("remember-again", "s2", "1970-01-01T00:00:00Z");
    const restored = await request("PATCH", `/${item.id}`, {
      operation_id:"restore-other-session",source:{session_id:"s2",message_id:"remember-again",explicit:true},
      expected_revision:item.revision,restore:true,description:"下一次协作时读取语言偏好",body:"请重新记住：中文回答，术语保留英文。",
    }, "session_id=s2");
    expect(restored.status).toBe(200); expect(restored.data.revision).toBe(3);
    expect((await request("GET", "", undefined, "session_id=s2&status=forgotten")).data.items).toEqual([]);
    const detail = (await request("GET", `/${item.id}`, undefined, "session_id=s2")).data;
    expect(detail.body).toBe("请重新记住：中文回答，术语保留英文。");
    expect(detail.origin_session_id).toBe("s1");
    expect(detail.sources.at(-1).session_id).toBe("s2");
    expect((await request("GET", "/index", undefined, "session_id=s2")).data.markdown).toContain(item.id);
  });

  it("cuts only complete index lines and exposes all remaining entries through project-bound pagination", async () => {
    for (let i=0;i<210;i++) await request("POST", "", {...write(`op-${i}`,`fact-${i}`),description:"处理相关开发任务时读取。".repeat(60)});
    const index = (await request("GET", "/index")).data;
    expect(index.has_more).toBe(true); expect(index.markdown.length).toBeLessThanOrEqual(25000);
    const lines = index.markdown.split("\n").filter((line:string)=>line.startsWith("- "));
    expect(lines.length).toBeLessThan(200); expect(lines.every((line:string)=>/\]\(.+\) — .+/.test(line))).toBe(true);
    const ids = new Set(lines.map((line:string)=>line.match(/memories\/([^?]+)/)![1]));
    let cursor = index.next_cursor;
    while (cursor) {
      const page = (await request("GET", "", undefined, `session_id=s1&limit=40&cursor=${cursor}`)).data;
      for (const item of page.items) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); }
      cursor = page.next_cursor;
    }
    expect(ids.size).toBe(210);
    expect((await request("GET", "", undefined, `session_id=foreign&cursor=${index.next_cursor}`)).status).toBe(400);
    db.query("UPDATE memories SET description='修改配置时读取'").run();
    const shortIndex = (await request("GET", "/index")).data;
    expect(shortIndex.markdown.split("\n").filter((line:string)=>line.startsWith("- "))).toHaveLength(200);
    expect(shortIndex.has_more).toBe(true);
  });

  it("initializes without backfill, atomically commits changes + progress and rolls back failed batches", async () => {
    service.initializeExtraction();
    const baseline = service.getExtractionCursor("s1");
    expect(service.getExtractionMessages("s1", baseline)).toHaveLength(0);
    message("fresh");
    const fresh = service.getExtractionMessages("s1",baseline)[0]!;
    const input = {...write("extract"),type:"user" as const,source:{session_id:"s1",message_id:"fresh"}};
    expect(() => service.commitExtraction({session_id:"s1",expected_cursor:baseline,cursor:fresh.cursor,changes:[{action:"create",input},{action:"create",input:{...input,operation_id:"conflict"}}]})).toThrow("name already exists");
    expect(service.getExtractionCursor("s1")).toBe(baseline);
    expect((await request("GET")).data.items).toHaveLength(0);
    service.commitExtraction({session_id:"s1",expected_cursor:baseline,cursor:fresh.cursor,changes:[{action:"create",input}]});
    expect((await request("GET")).data.items).toHaveLength(1);
    expect(service.getExtractionCursor("s1")).toBe(fresh.cursor);
    expect(() => service.commitExtraction({session_id:"s1",expected_cursor:baseline,cursor:fresh.cursor,changes:[]})).toThrow("cursor conflict");
    message("nothing-new-to-save");
    const next = service.getExtractionMessages("s1",fresh.cursor)[0]!;
    service.commitExtraction({session_id:"s1",expected_cursor:fresh.cursor,cursor:next.cursor,changes:[]});
    expect(service.getExtractionCursor("s1")).toBe(next.cursor);
    session("brand-new","https://github.com/new/repo"); message("brand-new-message","brand-new");
    expect(service.getExtractionCursor("brand-new")).toBe(0);
    expect(service.getExtractionMessages("brand-new",0)).toHaveLength(1);
  });

  it("keeps arrival cursors monotonic after tail deletion, clearing messages and VACUUM", () => {
    service.initializeExtraction();
    let cursor = service.getExtractionCursor("s1");
    message("tail");
    let next = service.getExtractionMessages("s1",cursor)[0]!;
    service.commitExtraction({session_id:"s1",expected_cursor:cursor,cursor:next.cursor,changes:[]});
    cursor = next.cursor;
    db.query("DELETE FROM messages WHERE id='tail'").run();
    message("replacement", "s1", "1990-01-01T00:00:00Z");
    next = service.getExtractionMessages("s1",cursor)[0]!;
    expect(next.id).toBe("replacement"); expect(next.cursor).toBeGreaterThan(cursor);
    service.commitExtraction({session_id:"s1",expected_cursor:cursor,cursor:next.cursor,changes:[]});
    cursor = next.cursor;
    db.query("DELETE FROM messages").run();
    db.exec("VACUUM");
    message("after-clear", "s1", "1980-01-01T00:00:00Z");
    next = service.getExtractionMessages("s1",cursor)[0]!;
    expect(next.id).toBe("after-clear"); expect(next.cursor).toBeGreaterThan(cursor);
    expect(next.created_at).toBe("1980-01-01T00:00:00Z");
    service.commitExtraction({session_id:"s1",expected_cursor:cursor,cursor:next.cursor,changes:[]});
    cursor = next.cursor;
    message("tail");
    expect(service.getExtractionMessages("s1",cursor)).toEqual([]);
    db.exec("VACUUM");
    message("after-vacuum");
    expect(service.getExtractionMessages("s1",cursor).map(m=>m.id)).toEqual(["after-vacuum"]);
  });

  it("restores only from arrivals after forgetting regardless of client timestamps or old-source reinsertion", async () => {
    message("old-future", "s1", "2099-01-01T00:00:00Z");
    const first = (await request("POST", "", write())).data;
    expect((await request("DELETE", `/${first.id}`, {operation_id:"forget",source,expected_revision:1})).status).toBe(200);
    const restore = {...write("restore-future"),expected_revision:2,restore:true,source:{...source,message_id:"old-future"}};
    expect((await request("PATCH", `/${first.id}`, restore)).status).toBe(410);
    db.query("DELETE FROM messages WHERE id='old-future'").run();
    message("old-future", "s1", "2100-01-01T00:00:00Z");
    expect((await request("PATCH", `/${first.id}`, restore)).status).toBe(410);
    message("new-clock-behind", "s1", "1970-01-01T00:00:00Z");
    const restored = await request("PATCH", `/${first.id}`, {...restore,operation_id:"restore-new",source:{...source,message_id:"new-clock-behind"}});
    expect(restored.status).toBe(200); expect(restored.data.revision).toBe(3);
    expect((db.query("SELECT created_at FROM messages WHERE id='new-clock-behind'").get() as any).created_at).toBe("1970-01-01T00:00:00Z");
    expect((await request("PATCH", `/${first.id}`, {...restore,operation_id:"old-after-restore",expected_revision:3})).status).toBe(410);
  });

  it("migrates existing rowid progress and forgotten records to arrival watermarks without backfill", async () => {
    const first = (await request("POST", "", write())).data;
    await request("DELETE", `/${first.id}`, {operation_id:"forget",source,expected_revision:1});
    db.exec("DROP TRIGGER memory_message_arrival_insert");
    db.exec("DROP TABLE memory_message_arrivals");
    db.exec("ALTER TABLE memories DROP COLUMN forgotten_sequence");
    db.query("INSERT INTO memory_extraction_progress VALUES ('s1',999)").run();
    initializeDatabase(db);
    const cursor = service.getExtractionCursor("s1");
    expect(service.getExtractionMessages("s1",cursor)).toEqual([]);
    const restore = {...write("restore-migrated"),expected_revision:2,restore:true};
    expect((await request("PATCH", `/${first.id}`, restore)).status).toBe(410);
    message("new-after-migration", "s1", "1970-01-01T00:00:00Z");
    const next = service.getExtractionMessages("s1",cursor)[0]!;
    expect(next.id).toBe("new-after-migration"); expect(next.cursor).toBeGreaterThan(cursor);
    expect((await request("PATCH", `/${first.id}`, {...restore,source:{...source,message_id:next.id}})).status).toBe(200);
    service.commitExtraction({session_id:"s1",expected_cursor:cursor,cursor:next.cursor,changes:[]});
    initializeDatabase(db);
    expect(service.getExtractionCursor("s1")).toBe(next.cursor);
    expect(service.getExtractionMessages("s1",next.cursor)).toEqual([]);
  });
});

it("memory uses the existing Dashboard login and public access policy", async () => {
  for (const publicDashboard of [false, true]) {
    resetDatabase(":memory:");
    const { app } = createApp({...loadConfig(),dbPath:":memory:",apiKey:"memory-test",extraApiKeys:[],publicDashboard,cursorSyncEnabled:false,agentAutoRunEnabled:false,debug:false});
    const login = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "memory-test" }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
    if (!publicDashboard) expect(cookie).toContain("at_session=");
    for (const path of ["/v1/memories","/v1/memories/index","/v1/memories/projects","/v1/memories/scopes","/v1/memories/unknown"]) {
      const url = `${path}?repo_url=https://github.com/org/repo`;
      const success = path.endsWith("unknown") ? 404 : 200;
      expect((await app.request(url)).status).toBe(publicDashboard ? success : 401);
      expect((await app.request(url,{headers:{Cookie:cookie}})).status).toBe(success);
      expect((await app.request(url,{headers:{"X-API-Key":"memory-test"}})).status).toBe(success);
    }
  }
});
