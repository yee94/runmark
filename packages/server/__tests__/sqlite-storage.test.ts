import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db/schema";
import { createIngestRoute } from "../src/routes/ingest";
import { createSessionsRoute, createStatsRoute } from "../src/routes/sessions";
import { createPublicSessionSharesRoute, createSessionSharesRoute } from "../src/routes/session-shares";
import { createAgentsRoute } from "../src/routes/agents";
import { loadConfig } from "../src/config";

const cli = resolve(import.meta.dir, "../../../scripts/sqlite-storage.ts");
const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
  it("backs up historical foreign key violations without masking them", () => {
    const { root, path, db } = fixture();
    db.query("INSERT INTO agent_jobs (id,agent_id,status,started_at,target_session_id) VALUES ('orphan',(SELECT id FROM agents LIMIT 1),'failed','2026-01-01T00:00:00Z','missing')").run();
    expect(command("verify", "--db", path).code).toBe(1);
    const backup = command("backup", "--db", path, "--out", join(root, "backup"));
    expect(backup.code, backup.error).toBe(0);
    expect(JSON.parse(backup.out).foreignKeyViolations).toBe(1);
    const restored = command("restore", "--manifest", JSON.parse(backup.out).manifest, "--out", join(root, "restored"));
    expect(restored.code, restored.error).toBe(0);
    expect(JSON.parse(restored.out).foreignKeyViolations).toBe(1);
    expect(command("verify", "--db", JSON.parse(restored.out).db).code).toBe(1);
    expect(command("verify", "--db", JSON.parse(restored.out).db, "--baseline-manifest", JSON.parse(backup.out).manifest).code).toBe(0);
    db.query("INSERT INTO agent_jobs (id,agent_id,status,started_at,target_session_id) VALUES ('orphan2',(SELECT id FROM agents LIMIT 1),'failed','2026-01-01T00:00:00Z','missing')").run();
    expect(command("verify", "--db", path, "--baseline-manifest", JSON.parse(backup.out).manifest).code).toBe(1);
  });

  it("backs up an existing WAL database to a long path", () => {
    const { root, path, db } = fixture();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const backup = command("backup", "--db", path, "--out", join(root, "a".repeat(90), "b".repeat(90), "backup"));
    expect(backup.code, backup.error).toBe(0);
  });
  it("backs up a closed WAL database with no sidecar files", () => {
    const { root, path, db } = fixture();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const copy = join(root, "closed.db");
    copyFileSync(path, copy);
    expect(existsSync(`${copy}-wal`)).toBe(false);
    const backup = command("backup", "--db", copy, "--out", join(root, "closed-backup"));
    expect(backup.code, backup.error).toBe(0);
  });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runmark-storage-"));
  roots.push(root);
  const path = join(root, "main.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec(SCHEMA_SQL);
  databases.push(db);
  const app = new Hono();
  app.onError((error, c) => c.text(error.message, 500));
  app.route("/", createIngestRoute(db));
  app.route("/", createSessionsRoute(db));
  app.route("/", createStatsRoute(db));
  app.route("/", createSessionSharesRoute(db, "test"));
  app.route("/", createPublicSessionSharesRoute(db, "test"));
  app.route("/", createAgentsRoute(db, { ...loadConfig(), dbPath: path, agentAutoRunEnabled: false }));
  return { root, path, db, app };
}
function command(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, cli, ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), error: result.stderr.toString() };
}
async function ingest(app: Hono, events: unknown[]) {
  const response = await app.request("/v1/ingest", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.errors).toEqual([]);
}

describe("monthly SQLite storage public interfaces", () => {
  it("automatically migrates on upgrade once, skips later releases and re-enables after inline", async () => {
    const { path, app } = fixture();
    await ingest(app, [{ type: "tool.result", session_id: "auto", call_id: "c", tool_name: "read", output_text: "自动升级正文".repeat(3000), duration_ms: 1, created_at: "2026-06-01T00:00:00Z" }]);
    const before = await (await app.request("/v1/sessions/auto/tool-calls")).json();
    const first = command("upgrade", "--db", path);
    expect(first.code, first.error).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ complete: true, externalized: 2 });
    const second = command("upgrade", "--db", path);
    expect(second.code, second.error).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ complete: true, skipped: true, processed: 0 });
    expect(command("inline", "--db", path).code).toBe(0);
    const again = command("upgrade", "--db", path);
    expect(again.code, again.error).toBe(0);
    expect(JSON.parse(again.out).externalized).toBe(2);
    expect(await (await app.request("/v1/sessions/auto/tool-calls")).json()).toEqual(before);
  });
  it("round-trips large tool output through HTTP and verifies durable monthly payloads", async () => {
    const { path, app } = fixture();
    const enabled = command("enable", "--db", path);
    expect(enabled.code, enabled.error).toBe(0);
    const output = "中文输出🙂\n".repeat(2000);
    await ingest(app, [
      { type: "session.created", session_id: "s", agent: "opencode" },
      { type: "tool.result", session_id: "s", call_id: "c", tool_name: "shell", output_text: output, duration_ms: 10, created_at: "2026-10-01T00:00:00Z" },
    ]);
    const response = await app.request("/v1/sessions/s/tool-calls");
    expect(response.status).toBe(200);
    expect((await response.json())[0].output_text).toBe(output);
    const verified = command("verify", "--db", path);
    expect(verified.code, verified.error).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({ valid: true, months: ["2026-10"], references: 2 });
  });

  it("resumes legacy migration and rolls back both old and post-upgrade writes without changing HTTP data", async () => {
    const { path, app } = fixture();
    const oldOutput = "旧库内容".repeat(2000);
    await ingest(app, [{ type: "tool.result", session_id: "legacy", call_id: "old", tool_name: "read", output_text: oldOutput, duration_ms: 1, created_at: "2026-09-30T15:59:59Z" }]);
    const before = await (await app.request("/v1/sessions/legacy/tool-calls")).json();
    const partial = command("migrate", "--db", path, "--batch-size", "1", "--max-batches", "1");
    expect(partial.code, partial.error).toBe(0);
    expect(JSON.parse(partial.out).complete).toBe(false);
    const migrated = command("migrate", "--db", path, "--batch-size", "1");
    expect(migrated.code, migrated.error).toBe(0);
    expect(JSON.parse(migrated.out).complete).toBe(true);
    expect(await (await app.request("/v1/sessions/legacy/tool-calls")).json()).toEqual(before);
    const newOutput = "升级后新内容".repeat(2000);
    await ingest(app, [{ type: "tool.result", session_id: "legacy", call_id: "new", tool_name: "read", output_text: newOutput, duration_ms: 1, created_at: "2026-10-01T00:00:00Z" }]);
    const all = await (await app.request("/v1/sessions/legacy/tool-calls")).json();
    expect(all.map((row: any) => row.output_text)).toEqual([oldOutput, newOutput]);
    const verified = command("verify", "--db", path);
    expect(JSON.parse(verified.out).months).toEqual(["2026-09", "2026-10"]);
    const rollback = command("inline", "--db", path, "--batch-size", "1");
    expect(rollback.code, rollback.error).toBe(0);
    expect(JSON.parse(command("verify", "--db", path).out)).toMatchObject({ enabled: false, references: 0 });
    expect(await (await app.request("/v1/sessions/legacy/tool-calls")).json()).toEqual(all);
  });

  it("keeps shared tool pages, focus and escaped LIKE output searches identical after migration", async () => {
    const { path, app } = fixture();
    await ingest(app, [{ type: "tool.result", session_id: "shared", call_id: "call", tool_name: "read", args: { long: "参数".repeat(3000) }, output_text: "needle_100% " + "内容".repeat(3000), duration_ms: 1, created_at: "2026-08-01T00:00:00Z" }]);
    const share = await (await app.request("/v1/sessions/shared/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: "1h" }) })).json();
    const base = new URL(share.api_url).pathname;
    const tools = await (await app.request(`${base}/tool-calls`)).json();
    const search = await (await app.request(`${base}/search?q=needle_100%25&kind=tool`)).json();
    expect(search.items.length).toBe(1);
    const focusUrl = `${base}/focus?node=tool:${tools.items[0].id}`;
    const focus = await (await app.request(focusUrl)).json();
    expect(command("migrate", "--db", path).code).toBe(0);
    expect(await (await app.request(`${base}/tool-calls`)).json()).toEqual(tools);
    expect(await (await app.request(`${base}/search?q=needle_100%25&kind=tool`)).json()).toEqual(search);
    expect(await (await app.request(focusUrl)).json()).toEqual(focus);
  });

  it("preserves job prompts, retry inputs and tool results in job detail after migration", async () => {
    const { path, db, app } = fixture();
    const agent = (db.query("SELECT id FROM agents LIMIT 1").get() as { id: string }).id;
    db.query("INSERT INTO agent_jobs (id,agent_id,status,started_at,input_json,prompt,output_json) VALUES ('j',?,'failed','2026-07-01T00:00:00Z',?,?,?)")
      .run(agent, JSON.stringify({ search_query: "检索".repeat(3000) }), "提示".repeat(4000), JSON.stringify({ text: "结果".repeat(3000) }));
    db.query("INSERT INTO agent_tool_calls (id,job_id,tool_name,state,created_at,args,result) VALUES ('jt','j','test','success','2026-07-01T00:00:00Z',?,?)")
      .run("参数".repeat(3000), "工具结果".repeat(3000));
    const before = await (await app.request("/v1/agent-runs/j")).json();
    expect(before.prompt).toBe("提示".repeat(4000));
    expect(command("migrate", "--db", path).code).toBe(0);
    expect(await (await app.request("/v1/agent-runs/j")).json()).toEqual(before);
  });

  it("reuses unchanged month backups, includes late writes and restores an independent complete snapshot", async () => {
    const { path, root, app } = fixture();
    expect(command("enable", "--db", path).code).toBe(0);
    await ingest(app, [{ type: "tool.result", session_id: "backup", call_id: "oct", tool_name: "read", output_text: "十月".repeat(4000), duration_ms: 1, created_at: "2026-10-01T00:00:00Z" }]);
    const out = join(root, "backups");
    const first = command("backup", "--db", path, "--out", out);
    expect(first.code, first.error).toBe(0);
    const second = command("backup", "--db", path, "--out", out);
    expect(second.code, second.error).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ copiedMonths: [], reusedMonths: ["2026-10"] });
    await ingest(app, [{ type: "tool.result", session_id: "backup", call_id: "late", tool_name: "read", output_text: "历史月补写".repeat(4000), duration_ms: 1, created_at: "2026-10-02T00:00:00Z" }]);
    const third = command("backup", "--db", path, "--out", out);
    expect(third.code, third.error).toBe(0);
    expect(JSON.parse(third.out).copiedMonths).toEqual(["2026-10"]);
    const restoredDir = join(root, "restored");
    const restored = command("restore", "--manifest", JSON.parse(third.out).manifest, "--out", restoredDir);
    expect(restored.code, restored.error).toBe(0);
    const restoredPath = JSON.parse(restored.out).db;
    expect(command("verify", "--db", restoredPath).code).toBe(0);
    const restoredDb = new Database(restoredPath);
    databases.push(restoredDb);
    const reader = createSessionsRoute(restoredDb);
    expect(await (await reader.request("/v1/sessions/backup/tool-calls")).json()).toEqual(await (await app.request("/v1/sessions/backup/tool-calls")).json());
    const original = command("restore", "--manifest", JSON.parse(first.out).manifest, "--out", join(root, "original"));
    expect(original.code, original.error).toBe(0);
    const originalDb = new Database(JSON.parse(original.out).db);
    databases.push(originalDb);
    expect((await (await createSessionsRoute(originalDb).request("/v1/sessions/backup/tool-calls")).json()).length).toBe(1);
    expect(command("restore", "--manifest", JSON.parse(third.out).manifest, "--out", restoredDir).code).toBe(1);
  });

  it.each(["missing", "corrupt"])("fails closed on a %s shard and can resume rollback after repairing it", async failure => {
    const { path, app } = fixture();
    expect(command("enable", "--db", path).code).toBe(0);
    const output = "不能丢失".repeat(3000);
    await ingest(app, [{ type: "tool.result", session_id: "broken", call_id: "c", tool_name: "read", output_text: output, duration_ms: 1, created_at: "2026-06-01T00:00:00Z" }]);
    const shard = `${path}.payloads/2026-06.db`;
    const original = readFileSync(shard);
    if (failure === "missing") renameSync(shard, `${shard}.saved`);
    else {
      const bad = new Database(shard);
      bad.exec("UPDATE payloads SET body=x'00'");
      bad.close();
    }
    expect(command("verify", "--db", path).code).toBe(1);
    expect((await app.request("/v1/sessions/broken/tool-calls")).status).toBe(500);
    expect(command("inline", "--db", path).code).toBe(1);
    writeFileSync(shard, original);
    expect(command("verify", "--db", path).code).toBe(0);
    expect(command("inline", "--db", path).code).toBe(0);
    expect((await (await app.request("/v1/sessions/broken/tool-calls")).json())[0].output_text).toBe(output);
  });

  it("rejects a tampered backup without publishing a restore directory", async () => {
    const { path, root, app } = fixture();
    await ingest(app, [{ type: "tool.result", session_id: "s", call_id: "c", tool_name: "read", output_text: "校验".repeat(3000), duration_ms: 1, created_at: "2026-06-01T00:00:00Z" }]);
    expect(command("migrate", "--db", path).code).toBe(0);
    const out = join(root, "backups");
    const backedUp = command("backup", "--db", path, "--out", out);
    expect(backedUp.code, backedUp.error).toBe(0);
    const manifestPath = JSON.parse(backedUp.out).manifest;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const object = join(out, "objects", `${manifest.shards[0].hash}.db`);
    const bytes = readFileSync(object);
    bytes[100] ^= 1;
    writeFileSync(object, bytes);
    const target = join(root, "must-not-exist");
    expect(command("restore", "--manifest", manifestPath, "--out", target).code).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(command("backup", "--db", path, "--out", out).code).toBe(1);
  });

  it("does not commit references or visible tools when the main transaction fails after writing a payload", async () => {
    const { path, db, app } = fixture();
    expect(command("enable", "--db", path).code).toBe(0);
    db.exec("CREATE TRIGGER reject_tool BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'injected main failure'); END");
    const event = { type: "tool.result", session_id: "retry", call_id: "c", tool_name: "read", output_text: "事务正文".repeat(3000), duration_ms: 1, created_at: "2026-06-01T00:00:00Z" };
    const failed = await app.request("/v1/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: [event] }) });
    expect((await failed.json()).errors.length).toBe(1);
    expect(JSON.parse(command("verify", "--db", path).out)).toMatchObject({ valid: true, references: 0 });
    expect(await (await app.request("/v1/sessions/retry/tool-calls")).json()).toEqual([]);
    db.exec("DROP TRIGGER reject_tool");
    await ingest(app, [event, event]);
    expect((await (await app.request("/v1/sessions/retry/tool-calls")).json()).length).toBe(1);
    expect(JSON.parse(command("verify", "--db", path).out).references).toBe(2);
  });

  it("preserves cross-month token/cost statistics and original user messages during migration and rollback", async () => {
    const { path, app } = fixture();
    const content = "用户原文".repeat(3000);
    await ingest(app, [
      { type: "session.created", session_id: "stats", agent: "opencode", created_at: "2026-09-01T00:00:00Z" },
      { type: "message", session_id: "stats", message_id: "m", role: "user", content, created_at: "2026-09-01T00:00:00Z" },
      { type: "turn.completed", session_id: "stats", turn_id: "t1", model: "test-model", provider: "test", input_tokens: 100, output_tokens: 20, total_tokens: 120, cost_usd: 0.01, duration_ms: 10, created_at: "2026-09-01T00:00:00Z" },
      { type: "turn.completed", session_id: "stats", turn_id: "t2", model: "test-model", provider: "test", input_tokens: 300, output_tokens: 40, total_tokens: 340, cost_usd: 0.02, duration_ms: 10, created_at: "2026-10-01T00:00:00Z" },
    ]);
    const urls = ["/v1/stats/summary?range=all", "/v1/stats/by-model?range=all", "/v1/sessions/stats/messages", "/v1/sessions/stats/turns"];
    const before = await Promise.all(urls.map(async url => (await app.request(url)).json()));
    expect(before[0].tokens.total).toBe(460);
    expect(before[2][0].content).toBe(content);
    for (const action of ["migrate", "inline"]) {
      expect(command(action, "--db", path).code).toBe(0);
      expect(await Promise.all(urls.map(async url => (await app.request(url)).json()))).toEqual(before);
    }
  });

  it("rolls back a failed migration batch and retries without skipping legacy rows", async () => {
    const { path, db, app } = fixture();
    await ingest(app, [{ type: "tool.result", session_id: "upgrade", call_id: "c", tool_name: "read", output_text: "历史原文".repeat(3000), duration_ms: 1, created_at: "2026-06-01T00:00:00Z" }]);
    const before = await (await app.request("/v1/sessions/upgrade/tool-calls")).json();
    db.exec("CREATE TRIGGER reject_migration BEFORE UPDATE ON tool_calls BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END");
    const failed = command("migrate", "--db", path, "--batch-size", "1");
    expect(failed.code).toBe(1);
    expect(failed.error).toContain("injected migration failure");
    expect(await (await app.request("/v1/sessions/upgrade/tool-calls")).json()).toEqual(before);
    expect(JSON.parse(command("verify", "--db", path).out).references).toBe(0);
    db.exec("DROP TRIGGER reject_migration");
    expect(command("migrate", "--db", path, "--batch-size", "1").code).toBe(0);
    expect(JSON.parse(command("verify", "--db", path).out).references).toBe(2);
    expect(await (await app.request("/v1/sessions/upgrade/tool-calls")).json()).toEqual(before);
  });

});
