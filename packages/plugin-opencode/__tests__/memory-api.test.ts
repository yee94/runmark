import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../../server/src/db/schema";
import { createMemoriesRoute } from "../../server/src/routes/memories";
import { createMemoryClient } from "../src/memory";

test("plugin tools integrate with actual memory routes and SQLite, including new-session race and forgotten read", async () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const app = createMemoriesRoute(db);
  const server = Bun.serve({ port: 0, fetch: request => app.fetch(request) });
  const memory = createMemoryClient({ endpoint: server.url.href, apiKey: "test" }, {
    repo_url: "git@git.test:Org/Repo.git", hostname: "mac", directory: "/repo",
  }, () => {}, async () => {
    // 模拟 flush 完成后的真实采集结果；此时才允许写 API 请求发出。
    db.query("INSERT OR IGNORE INTO sessions(id,agent,repo_url,started_at) VALUES ('ses_new','opencode','https://git.test/Org/Repo','2026-10-29T00:00:00Z')").run();
    db.query("INSERT OR IGNORE INTO messages(id,session_id,role,content,created_at) VALUES ('msg_user','ses_new','user','请记住发布前核对变更','2026-10-29T00:00:00Z')").run();
    return "msg_user";
  });
  const execute = async (action: string, args: Record<string, unknown>) => JSON.parse((await memory.tools.find(t => t.name.endsWith(action))!.execute(args, { sessionID: "ses_new" })).content);
  try {
    expect(await memory.snapshot("ses_new")).toContain("<runmark-project-memory>");
    const created = await execute("write", { operation_id: "op1", name: "release-check", description: "发布前读取", type: "user", body: "核对变更 ORIGINAL_BODY" });
    expect(created).toMatchObject({ success: true, revision: 1, replayed: false });
    expect(created.body).toBeUndefined();
    const detail = await execute("read", { id: created.id });
    expect(detail.markdown).toContain("ORIGINAL_BODY");
    expect(detail.sources[0]).toMatchObject({ session_id: "ses_new", message_id: "msg_user", available: 1 });
    expect(await memory.snapshot("ses_new")).not.toContain(created.id);
    const refreshed = await memory.tools.find(t => t.name.endsWith("refresh"))!.execute({}, { sessionID: "ses_new" });
    expect(refreshed.content).toContain(created.id);
    expect(refreshed.content).not.toContain("ORIGINAL_BODY");
    const updated = await execute("update", { id: created.id, operation_id: "op2", expected_revision: 1, body: "修订后的事实" });
    expect(updated.revision).toBe(2);
    await expect(execute("update", { id: created.id, operation_id: "op3", expected_revision: 1, body: "stale" })).rejects.toThrow("409");
    await execute("forget", { id: created.id, operation_id: "op4", expected_revision: 2 });
    await expect(execute("read", { id: created.id })).rejects.toThrow("410");
    expect((await execute("list", {})).items).toEqual([]);
    const forgotten = await execute("list", { status: "forgotten" });
    expect(forgotten.items[0]).toMatchObject({ id: created.id, revision: 3, status: "forgotten" });
    expect(forgotten.items[0].body).toBeUndefined();
  } finally {
    server.stop(true); db.close();
  }
});

test("six namespaces support source-checked write/read/update/forget and effective isolation", async () => {
  const db = new Database(":memory:"); db.exec(SCHEMA_SQL);
  const app = createMemoriesRoute(db);
  const server = Bun.serve({ port: 0, fetch: request => app.fetch(request) });
  const project = { repo_url: "https://git.test/a", hostname: "mac", directory: "/a" };
  db.query("INSERT INTO sessions(id,agent,repo_url,hostname,directory,started_at) VALUES ('source','opencode',?,?,?,'2026-10-29')").run(project.repo_url, project.hostname, project.directory);
  db.query("INSERT INTO messages(id,session_id,role,content,agent_key,created_at) VALUES ('user','source','user','请记住','opencode/build','2026-10-29')").run();
  const make = (identity: typeof project | {}) => createMemoryClient({ endpoint: server.url.href, apiKey: "test" }, identity, () => {}, async () => "user");
  const memory = make(project);
  const execute = async (action: string, args: Record<string, unknown>, agent = "build") => JSON.parse((await memory.tools.find(t => t.name.endsWith(action))!.execute(args, { sessionID: "source", agent })).content);
  try {
    const records: Array<{ id: string; scope: string; agent_key: string }> = [];
    for (const scope of ["global", "project"]) for (const agent_key of ["", "opencode/build"]) {
      const record = await execute("write", { scope, agent_key, operation_id: `write-${scope}-${agent_key}`, name: `${scope}-${agent_key ? "build" : "shared"}`, description: "读取约定", type: "user", body: "fact" });
      records.push(record);
      expect(await execute("read", { id: record.id })).toMatchObject({ scope, agent_key, body: "fact" });
    }
    expect((await execute("list", {})).items).toHaveLength(4);
    expect((await execute("list", {}, "plan")).items).toHaveLength(2);
    expect((await execute("list", { scope: "project" })).items).toHaveLength(1);
    expect((await execute("list", { scope: "project", agent_key: "opencode/build" })).items).toHaveLength(1);
    const other = await make({ repo_url: "https://git.test/b", hostname: "other", directory: "/b" }).snapshot("other", "build");
    const otherCheckout = await make({ ...project, hostname: "other", directory: "/checkout" }).snapshot("checkout", "build");
    const unknown = await make({}).snapshot("not-in-db", "build");
    for (const record of records) {
      if (record.scope === "global") { expect(other).toContain(record.id); expect(unknown).toContain(record.id); }
      else { expect(other).not.toContain(record.id); expect(unknown).not.toContain(record.id); }
      expect(otherCheckout).toContain(record.id);
      expect(await execute("update", { id: record.id, expected_revision: 1, operation_id: `update-${record.id}`, body: "changed" })).toMatchObject({ scope: record.scope, agent_key: record.agent_key, revision: 2 });
      expect((await execute("forget", { id: record.id, expected_revision: 2, operation_id: `forget-${record.id}` })).result).toMatchObject({ scope: record.scope, agent_key: record.agent_key, revision: 3 });
      expect((await execute("forget", { id: record.id, expected_revision: 2, operation_id: `forget-${record.id}` })).result.replayed).toBe(true);
    }
    expect((await execute("list", {})).items).toHaveLength(0);
  } finally { server.stop(true); db.close(); }
});
