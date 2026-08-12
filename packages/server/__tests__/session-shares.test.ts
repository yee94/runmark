import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash, createHmac } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../src/app";
import { resetDatabase } from "../src/db";
import type { ServerConfig } from "../src/config";
import type { Database } from "bun:sqlite";

const API_KEY = "test-share-secret";
const SHARE_LINK_HMAC_PREFIX = "agent-tracker-session-share-link-v1:";

function expectedShareAlias(tokenHash: string): string {
  const signature = createHmac("sha256", API_KEY)
    .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
    .digest("base64url");
  return `${tokenHash}.${signature}`;
}

function expectedAgentPrompt(apiUrl: string): string {
  return [
    "请先读取 Session 摘要（优先 AISummary）。需要详情时，从响应 resources 选择 search / messages / turns / tool_calls 链接，用 curl -o <file> 落盘后再分析。",
    "",
    "---",
    "",
    `curl -sS -o runmark-session-summary.json ${JSON.stringify(apiUrl)}`,
  ].join("\n");
}

function shareTestConfig(dbPath: string): ServerConfig {
  return {
    port: 3456,
    apiKey: API_KEY,
    dbPath,
    publicDir: "./public",
    publicDashboard: false,
    extraApiKeys: [],
    debug: false,
    logFile: "/tmp/agent-tracker-share-test.log",
    cursorSyncEnabled: false,
    cursorApiKey: API_KEY,
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
}

const DURATIONS = ["1h", "6h", "12h", "3d", "7d"] as const;

function seedSession(db: Database, id = "share-sess-1") {
  db.query(`
    INSERT INTO sessions (
      id, agent, title, provider, model, started_at,
      project_name, user_email, hostname, directory, worktree, repo_url, branch,
      parent_session_id, metadata, AISummary,
      request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd
    ) VALUES (
      $id, 'opencode', '分享测试会话', 'anthropic', 'claude-sonnet-4',
      $started_at,
      'secret-project', 'user@secret.example', 'secret-host', '/secret/dir', '/secret/worktree',
      'git@secret.example/repo.git', 'secret-branch',
      'parent-secret', '{"is_fork":true,"fork_parent_session_id":"parent-secret"}', '短摘要',
      1, 100, 50, 150, 0.01
    )
  `).run({ $id: id, $started_at: new Date().toISOString() });

  db.query(`
    INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES ($id, $session_id, 'user', 'hello share unique-needle-alpha', $created_at)
  `).run({
    $id: `msg-${id}`,
    $session_id: id,
    $created_at: new Date(Date.now() - 3000).toISOString(),
  });

  db.query(`
    INSERT INTO messages (id, session_id, role, content, model, provider, created_at)
    VALUES ($id, $session_id, 'assistant', 'assistant reply body', 'claude-sonnet-4', 'anthropic', $created_at)
  `).run({
    $id: `msg-asst-${id}`,
    $session_id: id,
    $created_at: new Date(Date.now() - 2000).toISOString(),
  });

  db.query(`
    INSERT INTO turns (
      id, session_id, model, provider,
      input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at
    ) VALUES (
      $id, $session_id, 'claude-sonnet-4', 'anthropic',
      100, 50, 150, 0.01, 200, $created_at
    )
  `).run({
    $id: `turn-${id}`,
    $session_id: id,
    $created_at: new Date(Date.now() - 1500).toISOString(),
  });

  db.query(`
    INSERT INTO turns (
      id, session_id, model, provider,
      input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at
    ) VALUES (
      $id, $session_id, 'claude-sonnet-4', 'anthropic',
      10, 5, 15, 0.001, 50, $created_at
    )
  `).run({
    $id: `turn-2-${id}`,
    $session_id: id,
    $created_at: new Date(Date.now() - 1000).toISOString(),
  });

  db.query(`
    INSERT INTO tool_calls (
      id, session_id, tool_name, call_id, args, output_title, output_text, duration_ms, created_at
    ) VALUES (
      $id, $session_id, 'Read', 'call-1', '{"path":"/tmp/a"}', 'read title',
      'tool output unique-needle-alpha full text for search', 10, $created_at
    )
  `).run({
    $id: `tool-${id}`,
    $session_id: id,
    $created_at: new Date(Date.now() - 500).toISOString(),
  });

  db.query(`
    INSERT INTO tool_calls (
      id, session_id, tool_name, call_id, duration_ms, created_at
    ) VALUES (
      $id, $session_id, 'Grep', 'call-2', 5, $created_at
    )
  `).run({
    $id: `tool-2-${id}`,
    $session_id: id,
    $created_at: new Date().toISOString(),
  });

  return id;
}

async function createShare(
  app: ReturnType<typeof createApp>["app"],
  duration = "6h",
) {
  const createRes = await app.request("/v1/sessions/share-sess-1/shares", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify({ duration }),
  });
  expect(createRes.status).toBe(201);
  return createRes.json() as Promise<{
    id: string;
    token: string;
    share_url: string;
    api_url: string;
    expires_at: string;
    agent_prompt: string;
  }>;
}

describe("session shares", () => {
  let app: ReturnType<typeof createApp>["app"];
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    // getDatabase 为单例；每次用系统临时目录独立 DB，避免仓库根目录落盘与串测
    tempDir = mkdtempSync(join(tmpdir(), "agent-tracker-share-"));
    const dbPath = join(tempDir, "test.db");
    resetDatabase(dbPath);
    ({ app, db } = createApp(shareTestConfig(dbPath)));
    seedSession(db);
  });

  afterEach(() => {
    resetDatabase(":memory:");
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("POST /v1/sessions/:id/shares requires auth", async () => {
    const res = await app.request("/v1/sessions/share-sess-1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration: "1h" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts every allowed duration", async () => {
    for (const duration of DURATIONS) {
      const res = await app.request("/v1/sessions/share-sess-1/shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({ duration }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(20);
      // 管理 id = token_hash（64 hex），不可逆标识
      expect(body.id).toMatch(/^[0-9a-f]{64}$/);
      expect(body.id).toBe(createHash("sha256").update(body.token).digest("hex"));
      // 人类 share_url 用签名 alias；api_url / agent_prompt 仍用原始 token
      const alias = expectedShareAlias(body.id);
      expect(body.share_url).toContain(`/#/share/${alias}`);
      expect(body.share_url).not.toContain(`/#/share/${body.token}`);
      expect(body.api_url).toContain(`/v1/public/session-shares/${body.token}`);
      expect(body.api_url).not.toContain(alias);
      expect(body.api_url).not.toContain("view=full");
      expect(body.expires_at).toBeTruthy();
      expect(body.agent_prompt).toContain("curl -sS");
      expect(body.agent_prompt).toContain(body.api_url);
      expect(body.agent_prompt).toContain("AISummary");
      expect(body.agent_prompt).toContain("resources");
      expect(body.agent_prompt).toContain("curl -o");
      expect(body.agent_prompt).not.toContain("?view=full");
      expect((body.agent_prompt.match(/curl -sS/g) ?? []).length).toBe(1);
      expect(body.agent_prompt).toBe(expectedAgentPrompt(body.api_url));
    }
  });

  it("rejects invalid duration with 400", async () => {
    const res = await app.request("/v1/sessions/share-sess-1/shares", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({ duration: "2h" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when session does not exist", async () => {
    const res = await app.request("/v1/sessions/missing-session/shares", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({ duration: "1h" }),
    });
    expect(res.status).toBe(404);
  });

  it("default public summary has counts/resources/AISummary without full arrays", async () => {
    const created = await createShare(app);
    const publicRes = await app.request(`/v1/public/session-shares/${created.token}`, {
      headers: { Accept: "application/json" },
    });
    expect(publicRes.status).toBe(200);
    const bundle = await publicRes.json();

    expect(bundle.share.expires_at).toBe(created.expires_at);
    expect(bundle.session.id).toBe("share-sess-1");
    expect(bundle.session.title).toBe("分享测试会话");
    expect(bundle.session.summary).toBe("分享测试会话");
    expect(bundle.session.AISummary).toBe("短摘要");
    expect(bundle.summary_markdown).toBe("短摘要");
    expect(bundle.session.total_cost_cny).toBeDefined();
    expect(bundle.session.total_tokens).toBe(150);
    expect(bundle.session.message_count).toBe(2);
    expect(bundle.session.turn_count).toBe(2);

    // 默认 body 禁止 messages/turns/tool_calls 全量数组
    expect(bundle).not.toHaveProperty("messages");
    expect(bundle).not.toHaveProperty("turns");
    expect(bundle).not.toHaveProperty("tool_calls");
    expect(bundle.counts).toEqual({ messages: 2, turns: 2, tool_calls: 2 });

    const base = created.api_url;
    expect(bundle.resources).toEqual({
      search: `${base}/search`,
      messages: `${base}/messages?format=jsonl&limit=50`,
      turns: `${base}/turns?format=jsonl&limit=50`,
      tool_calls: `${base}/tool-calls?format=jsonl&limit=50`,
    });

    // 公开 bundle 的 agent_prompt 与创建响应完全一致（raw API URL）
    expect(bundle.agent_prompt).toBe(created.agent_prompt);
    expect(bundle.agent_prompt).toBe(expectedAgentPrompt(created.api_url));
    expect(bundle).not.toHaveProperty("context");
    // 仅该 session，无 children / fork 父内容字段集合
    expect(bundle.children).toBeUndefined();

    // 公开 session 不得暴露环境/身份/导航敏感字段
    const sensitiveKeys = [
      "project_name",
      "user_email",
      "hostname",
      "directory",
      "worktree",
      "repo_url",
      "branch",
      "metadata",
      "parent_session_id",
      "is_fork",
      "fork_source_title",
      "fork_parent_session_id",
    ];
    for (const key of sensitiveKeys) {
      expect(bundle.session).not.toHaveProperty(key);
    }
    const sessionJson = JSON.stringify(bundle.session);
    expect(sessionJson).not.toContain("secret-project");
    expect(sessionJson).not.toContain("user@secret.example");
    expect(sessionJson).not.toContain("secret-host");
    expect(sessionJson).not.toContain("/secret/dir");
    expect(sessionJson).not.toContain("git@secret.example");
  });

  it("returns summary for valid signed alias without auth (JSON)", async () => {
    const created = await createShare(app);
    const alias = expectedShareAlias(created.id);

    const publicRes = await app.request(`/v1/public/session-shares/${alias}`, {
      headers: { Accept: "application/json" },
    });
    expect(publicRes.status).toBe(200);
    const bundle = await publicRes.json();
    expect(bundle.session.id).toBe("share-sess-1");
    expect(bundle.session.AISummary).toBe("短摘要");
    expect(bundle.summary_markdown).toBe("短摘要");
    expect(bundle.counts.messages).toBe(2);
    expect(bundle).not.toHaveProperty("messages");
    expect(bundle.share.expires_at).toBe(created.expires_at);
    expect(bundle.resources.search).toContain(`/v1/public/session-shares/${alias}/search`);
    expect(bundle.agent_prompt).toContain("curl -sS");
    expect(bundle.agent_prompt).toContain(alias);
  });

  it("raw token + Accept text/html redirects to exact raw /#/share token (not alias)", async () => {
    const created = await createShare(app, "1h");
    const alias = expectedShareAlias(created.id);

    const res = await app.request(`/v1/public/session-shares/${created.token}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBe(`http://localhost/#/share/${created.token}`);
    // 禁止把 raw token 重定向成 alias
    expect(location).not.toContain(alias);
    expect(location).not.toContain(created.id + ".");
  });

  it("alias + Accept text/html redirects to alias /#/share form", async () => {
    const created = await createShare(app, "1h");
    const alias = expectedShareAlias(created.id);

    const res = await app.request(`/v1/public/session-shares/${alias}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`http://localhost/#/share/${alias}`);
  });

  // wantsHtmlRedirect：Accept 同时含 text/html 与 application/json 时按出现顺序协商
  it("public root: Accept text/html before application/json → 302 redirect", async () => {
    const created = await createShare(app, "1h");

    const res = await app.request(`/v1/public/session-shares/${created.token}`, {
      headers: {
        Accept: "text/html,application/json",
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `http://localhost/#/share/${created.token}`,
    );
  });

  it("public root: Accept application/json before text/html → 200 JSON", async () => {
    const created = await createShare(app, "1h");

    const res = await app.request(`/v1/public/session-shares/${created.token}`, {
      headers: {
        Accept: "application/json,text/html",
      },
    });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(bundle.session.id).toBe("share-sess-1");
    expect(bundle.session.AISummary).toBe("短摘要");
    expect(bundle.counts).toEqual({ messages: 2, turns: 2, tool_calls: 2 });
    expect(bundle).not.toHaveProperty("messages");
  });

  it("returns 404 for invalid alias signature", async () => {
    const created = await createShare(app, "1h");
    const badAlias = `${created.id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

    const res = await app.request(`/v1/public/session-shares/${badAlias}`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for invalid token", async () => {
    const res = await app.request("/v1/public/session-shares/not-a-real-token");
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired token", async () => {
    const created = await createShare(app, "1h");
    const tokenHash = createHash("sha256").update(created.token).digest("hex");

    db.query(
      "UPDATE session_shares SET expires_at = $expires_at WHERE token_hash = $token_hash",
    ).run({
      $expires_at: new Date(Date.now() - 60_000).toISOString(),
      $token_hash: tokenHash,
    });

    const res = await app.request(`/v1/public/session-shares/${created.token}`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("Share expired");
  });

  it("expired share sub-resources return 410", async () => {
    const created = await createShare(app, "1h");
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    db.query(
      "UPDATE session_shares SET expires_at = $expires_at WHERE token_hash = $token_hash",
    ).run({
      $expires_at: new Date(Date.now() - 60_000).toISOString(),
      $token_hash: tokenHash,
    });

    for (const path of [
      `/v1/public/session-shares/${created.token}/search?q=hello`,
      `/v1/public/session-shares/${created.token}/messages`,
      `/v1/public/session-shares/${created.token}/turns`,
      `/v1/public/session-shares/${created.token}/tool-calls`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toBe("Share expired");
    }
  });

  it("search returns truncated snippets without full tool output", async () => {
    const created = await createShare(app);
    const res = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=unique-needle&kind=all&limit=20`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    const msg = body.items.find((i: { kind: string }) => i.kind === "message");
    const tool = body.items.find((i: { kind: string }) => i.kind === "tool");
    expect(msg).toBeTruthy();
    expect(tool).toBeTruthy();
    expect(msg.snippet).toContain("unique-needle");
    expect(msg.snippet.length).toBeLessThanOrEqual(500);
    expect(tool.snippet).toContain("unique-needle");
    expect(tool.snippet.length).toBeLessThanOrEqual(500);
    // search 不返回完整 content/output_text 字段
    expect(msg).not.toHaveProperty("content");
    expect(tool).not.toHaveProperty("output_text");
    expect(tool).not.toHaveProperty("args");
  });

  it("search rejects invalid q/kind/limit", async () => {
    const created = await createShare(app);
    const badQ = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=x`,
    );
    expect(badQ.status).toBe(400);

    const badKind = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=hello&kind=turn`,
    );
    expect(badKind.status).toBe(400);

    const badLimit = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=hello&limit=0`,
    );
    expect(badLimit.status).toBe(400);
  });

  it("search treats LIKE wildcards %/_/\\ as literals", async () => {
    const created = await createShare(app);
    const now = Date.now();

    // 含字面 % / _ / \ 的命中行
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ($id, $session_id, 'user', $content, $created_at)
    `).run({
      $id: "msg-like-literal",
      $session_id: "share-sess-1",
      $content: "progress 50% done path_a\\b",
      $created_at: new Date(now - 300).toISOString(),
    });
    db.query(`
      INSERT INTO tool_calls (
        id, session_id, tool_name, call_id, output_title, output_text, duration_ms, created_at
      ) VALUES (
        $id, $session_id, 'Shell', 'call-like', 'rate 50% ok',
        'matched_file_name and path_a\\b', 1, $created_at
      )
    `).run({
      $id: "tool-like-literal",
      $session_id: "share-sess-1",
      $created_at: new Date(now - 200).toISOString(),
    });

    // 负例：无转义时 %/_ 会误匹配（50X / pathXa）
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ($id, $session_id, 'user', $content, $created_at)
    `).run({
      $id: "msg-like-false-pct",
      $session_id: "share-sess-1",
      $content: "progress 50X done",
      $created_at: new Date(now - 100).toISOString(),
    });
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ($id, $session_id, 'user', $content, $created_at)
    `).run({
      $id: "msg-like-false-under",
      $session_id: "share-sess-1",
      $content: "pathXa without underscore",
      $created_at: new Date(now).toISOString(),
    });

    // q=50% 只匹配含字面 "50%" 的行，不会把 % 当任意通配去命中 50X
    const pct = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=${encodeURIComponent("50%")}&kind=all&limit=20`,
    );
    expect(pct.status).toBe(200);
    const pctBody = await pct.json();
    expect(pctBody.items.map((i: { id: string }) => i.id).sort()).toEqual(
      ["msg-like-literal", "tool-like-literal"].sort(),
    );
    expect(pctBody.items.every((i: { snippet: string }) => i.snippet.includes("50%"))).toBe(
      true,
    );

    // q=path_a 只匹配含字面下划线的内容，不会把 _ 当单字符通配去匹配 pathXa
    const under = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=${encodeURIComponent("path_a")}&kind=all&limit=20`,
    );
    expect(under.status).toBe(200);
    const underBody = await under.json();
    expect(underBody.items.map((i: { id: string }) => i.id).sort()).toEqual(
      ["msg-like-literal", "tool-like-literal"].sort(),
    );
    expect(
      underBody.items.every((i: { snippet: string }) => i.snippet.includes("path_a")),
    ).toBe(true);

    // q 含反斜杠时按字面匹配
    const backslash = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=${encodeURIComponent("a\\b")}&kind=all&limit=20`,
    );
    expect(backslash.status).toBe(200);
    const backslashBody = await backslash.json();
    expect(backslashBody.items.map((i: { id: string }) => i.id).sort()).toEqual(
      ["msg-like-literal", "tool-like-literal"].sort(),
    );
    expect(
      backslashBody.items.every((i: { snippet: string }) => i.snippet.includes("a\\b")),
    ).toBe(true);

    // 正常关键字仍可用（回归）
    const normal = await app.request(
      `/v1/public/session-shares/${created.token}/search?q=unique-needle&kind=all&limit=20`,
    );
    expect(normal.status).toBe(200);
    const normalBody = await normal.json();
    expect(normalBody.items.length).toBeGreaterThanOrEqual(2);
  });

  it("messages supports pagination, role filter, and jsonl", async () => {
    const created = await createShare(app);

    const page1 = await app.request(
      `/v1/public/session-shares/${created.token}/messages?limit=1&offset=0&format=json`,
    );
    expect(page1.status).toBe(200);
    const p1 = await page1.json();
    expect(p1.items.length).toBe(1);
    expect(p1.items[0].role).toBe("user");
    expect(p1.items[0].content).toContain("hello share");
    expect(p1.items[0]).toHaveProperty("truncated");
    expect(p1.items[0]).not.toHaveProperty("tool_calls");
    expect(p1.next_offset).toBe(1);

    const page2 = await app.request(
      `/v1/public/session-shares/${created.token}/messages?limit=1&offset=1&format=json`,
    );
    const p2 = await page2.json();
    expect(p2.items.length).toBe(1);
    expect(p2.items[0].role).toBe("assistant");
    expect(p2.next_offset).toBeNull();

    const users = await app.request(
      `/v1/public/session-shares/${created.token}/messages?role=user&format=json`,
    );
    const u = await users.json();
    expect(u.items.length).toBe(1);
    expect(u.items.every((m: { role: string }) => m.role === "user")).toBe(true);

    const jsonlRes = await app.request(
      `/v1/public/session-shares/${created.token}/messages?format=jsonl&limit=50`,
    );
    expect(jsonlRes.status).toBe(200);
    expect(jsonlRes.headers.get("Content-Type")).toContain("application/x-ndjson");
    const lines = (await jsonlRes.text()).trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBeTruthy();
  });

  it("turns supports pagination and jsonl with cost fields", async () => {
    const created = await createShare(app);
    const page1 = await app.request(
      `/v1/public/session-shares/${created.token}/turns?limit=1&offset=0&format=json`,
    );
    expect(page1.status).toBe(200);
    const p1 = await page1.json();
    expect(p1.items.length).toBe(1);
    expect(p1.items[0].total_tokens).toBe(150);
    expect(p1.items[0].cost_cny).toBeDefined();
    expect(p1.next_offset).toBe(1);

    const jsonlRes = await app.request(
      `/v1/public/session-shares/${created.token}/turns?format=jsonl&limit=50`,
    );
    expect(jsonlRes.status).toBe(200);
    expect(jsonlRes.headers.get("Content-Type")).toContain("application/x-ndjson");
    const lines = (await jsonlRes.text()).trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("tool-calls supports filter, pagination, and jsonl", async () => {
    const created = await createShare(app);
    const all = await app.request(
      `/v1/public/session-shares/${created.token}/tool-calls?limit=1&offset=0&format=json`,
    );
    expect(all.status).toBe(200);
    const p1 = await all.json();
    expect(p1.items.length).toBe(1);
    expect(p1.items[0].tool_name).toBe("Read");
    expect(p1.items[0]).toHaveProperty("args");
    expect(p1.items[0]).toHaveProperty("args_truncated");
    expect(p1.items[0]).toHaveProperty("output_text");
    expect(p1.items[0]).toHaveProperty("output_text_truncated");
    expect(p1.next_offset).toBe(1);

    const filtered = await app.request(
      `/v1/public/session-shares/${created.token}/tool-calls?tool_name=Grep&format=json`,
    );
    const f = await filtered.json();
    expect(f.items.length).toBe(1);
    expect(f.items[0].tool_name).toBe("Grep");

    const jsonlRes = await app.request(
      `/v1/public/session-shares/${created.token}/tool-calls?format=jsonl&limit=50`,
    );
    expect(jsonlRes.status).toBe(200);
    expect(jsonlRes.headers.get("Content-Type")).toContain("application/x-ndjson");
    const lines = (await jsonlRes.text()).trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("sub-resources accept alias credential", async () => {
    const created = await createShare(app);
    const alias = expectedShareAlias(created.id);
    const res = await app.request(
      `/v1/public/session-shares/${alias}/messages?format=json&limit=10`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
  });

  it("stores only sha256 hash of token in DB, never plaintext", async () => {
    const created = await createShare(app, "3d");
    const expectedHash = createHash("sha256").update(created.token).digest("hex");

    const rows = db.query("SELECT token_hash, session_id FROM session_shares").all() as Array<{
      token_hash: string;
      session_id: string;
    }>;
    expect(rows.some((r) => r.token_hash === expectedHash)).toBe(true);
    expect(rows.some((r) => r.token_hash === created.token)).toBe(false);

    // 全表序列化也不应出现明文 token
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(created.token);
  });

  it("public share token cannot call write endpoints", async () => {
    const created = await createShare(app, "1h");

    const ingestRes = await app.request("/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": created.token,
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(ingestRes.status).toBe(401);

    const pricingRes = await app.request("/v1/pricing", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": created.token,
      },
      body: JSON.stringify({
        provider: "x",
        model: "y",
        input_price: 1,
        output_price: 2,
      }),
    });
    expect(pricingRes.status).toBe(401);

    // 公开分享路径本身不提供写方法
    const writeShare = await app.request(`/v1/public/session-shares/${created.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hack: true }),
    });
    expect([404, 405]).toContain(writeShare.status);
  });

  it("GET /v1/sessions/:id/shares requires auth", async () => {
    const res = await app.request("/v1/sessions/share-sess-1/shares");
    expect(res.status).toBe(401);
  });

  it("lists only active shares with share_url alias, without token fields", async () => {
    const first = await (
      await app.request("/v1/sessions/share-sess-1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ duration: "1h" }),
      })
    ).json();
    // 保证第二条 created_at 更新，列表按 DESC
    await Bun.sleep(5);
    const second = await (
      await app.request("/v1/sessions/share-sess-1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ duration: "6h" }),
      })
    ).json();

    // 过期一条：不应出现在列表
    db.query(
      "UPDATE session_shares SET expires_at = $expires_at WHERE token_hash = $token_hash",
    ).run({
      $expires_at: new Date(Date.now() - 60_000).toISOString(),
      $token_hash: first.id,
    });

    const listRes = await app.request("/v1/sessions/share-sess-1/shares", {
      headers: { "X-API-Key": API_KEY },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list.shares)).toBe(true);
    expect(list.shares.length).toBe(1);
    expect(list.shares[0].id).toBe(second.id);
    expect(list.shares[0].created_at).toBeTruthy();
    expect(list.shares[0].expires_at).toBe(second.expires_at);

    // 列表 share_url 为可验证签名 alias（可从历史 token_hash 重算）
    const expectedAlias = expectedShareAlias(second.id);
    expect(list.shares[0].share_url).toBe(`http://localhost/#/share/${expectedAlias}`);
    expect(list.shares[0].share_url).toBe(second.share_url);
    expect(list.shares[0].share_url).not.toContain(second.token);

    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain('"token"');
    expect(listJson).not.toContain("token_hash");
    expect(listJson).not.toContain(first.token);
    expect(listJson).not.toContain(second.token);

    for (const item of list.shares) {
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("token_hash");
      expect(typeof item.share_url).toBe("string");
    }
  });

  it("DELETE revoke requires auth and invalidates public link", async () => {
    const created = await (
      await app.request("/v1/sessions/share-sess-1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ duration: "1h" }),
      })
    ).json();

    const unauth = await app.request(
      `/v1/sessions/share-sess-1/shares/${created.id}`,
      { method: "DELETE" },
    );
    expect(unauth.status).toBe(401);

    const ok = await app.request(`/v1/sessions/share-sess-1/shares/${created.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ revoked: true });

    const publicRes = await app.request(`/v1/public/session-shares/${created.token}`);
    expect(publicRes.status).toBe(404);

    const again = await app.request(`/v1/sessions/share-sess-1/shares/${created.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });
    expect(again.status).toBe(404);
  });

  it("DELETE is scoped to session and rejects non-hex shareId", async () => {
    seedSession(db, "share-sess-2");
    const created = await (
      await app.request("/v1/sessions/share-sess-1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ duration: "1h" }),
      })
    ).json();

    // 跨 session 不得撤回
    const cross = await app.request(`/v1/sessions/share-sess-2/shares/${created.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });
    expect(cross.status).toBe(404);

    // 原 session 链接仍有效
    const still = await app.request(`/v1/public/session-shares/${created.token}`);
    expect(still.status).toBe(200);

    const badId = await app.request("/v1/sessions/share-sess-1/shares/not-hex", {
      method: "DELETE",
      headers: { "X-API-Key": API_KEY },
    });
    expect(badId.status).toBe(404);
  });
});
