import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash, createHmac } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../src/app";
import { resetDatabase } from "../src/db";
import type { ServerConfig } from "../src/config";
import type { Database } from "bun:sqlite";
import { FOCUS_ANCESTOR_DEPTH_MAX } from "../src/routes/session-shares";

/** focus / seed 固定时间锚，避免 Date.now() 影响时间相关断言 */
const SEED_TIME_BASE = Date.parse("2026-06-01T12:00:00.000Z");

const API_KEY = "test-share-secret";
const SHARE_LINK_HMAC_PREFIX = "agent-tracker-session-share-link-v1:";

function expectedShareAlias(tokenHash: string): string {
  const signature = createHmac("sha256", API_KEY)
    .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
    .digest("base64url");
  return `${tokenHash}.${signature}`;
}

function expectedAgentPrompt(apiUrl: string, restricted = false): string {
  return [
    restricted
      ? "请先读取 Session 摘要（优先 AISummary）。需要详情时，仅使用响应 resources.trace 按 next_offset 分页读取已过滤、已脱敏的共享调用链，并用 curl -o <file> 落盘后分析。"
      : "请先读取 Session 摘要（优先 AISummary）。需要定位时先使用 resources.search；需要详情时，从响应 resources 选择 trace / messages / turns / tool_calls 链接，按 next_offset 分页读取并用 curl -o <file> 落盘后分析。",
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
    llmBaseUrl: "https://api.example.com/v1/chat/completions",
    llmApiKey: "ac:test",
    llmModel: "deepseek_v4_flash_code",
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
  `).run({ $id: id, $started_at: new Date(SEED_TIME_BASE).toISOString() });

  db.query(`
    INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES ($id, $session_id, 'user', 'hello share unique-needle-alpha', $created_at)
  `).run({
    $id: `msg-${id}`,
    $session_id: id,
    $created_at: new Date(SEED_TIME_BASE - 3000).toISOString(),
  });

  db.query(`
    INSERT INTO messages (id, session_id, role, content, model, provider, created_at)
    VALUES ($id, $session_id, 'assistant', 'assistant reply body', 'claude-sonnet-4', 'anthropic', $created_at)
  `).run({
    $id: `msg-asst-${id}`,
    $session_id: id,
    $created_at: new Date(SEED_TIME_BASE - 2000).toISOString(),
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
    $created_at: new Date(SEED_TIME_BASE - 1500).toISOString(),
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
    $created_at: new Date(SEED_TIME_BASE - 1000).toISOString(),
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
    $created_at: new Date(SEED_TIME_BASE - 500).toISOString(),
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
    $created_at: new Date(SEED_TIME_BASE).toISOString(),
  });

  return id;
}

async function createShare(
  app: ReturnType<typeof createApp>["app"],
  duration = "6h",
  sessionId = "share-sess-1",
  scope: { types?: string[]; node?: string | null; child?: string | null } = {},
) {
  const createRes = await app.request(`/v1/sessions/${sessionId}/shares`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify({ duration, ...scope }),
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

/** 链接会话：用于 child 隔离 / 环检测 / cursor-turn 聚焦 */
function seedLinkedSession(
  db: Database,
  id: string,
  parentId: string | null,
  opts?: { agent?: string; title?: string; startedAt?: string },
) {
  const startedAt = opts?.startedAt ?? new Date().toISOString();
  db.query(`
    INSERT INTO sessions (
      id, agent, title, provider, model, started_at,
      project_name, user_email, hostname, directory, worktree, repo_url, branch,
      parent_session_id, metadata, AISummary,
      request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd
    ) VALUES (
      $id, $agent, $title, 'anthropic', 'claude-sonnet-4',
      $started_at,
      'secret-project', 'user@secret.example', 'secret-host', '/secret/dir', '/secret/worktree',
      'git@secret.example/repo.git', 'secret-branch',
      $parent_session_id, $metadata, '短摘要',
      1, 10, 5, 15, 0.001
    )
  `).run({
    $id: id,
    $agent: opts?.agent ?? "opencode",
    $title: opts?.title ?? `子会话 ${id}`,
    $started_at: startedAt,
    $parent_session_id: parentId,
    $metadata: parentId
      ? '{"is_subagent":true}'
      : '{"is_fork":true,"fork_parent_session_id":"parent-secret"}',
  });

  db.query(`
    INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES ($id, $session_id, 'user', $content, $created_at)
  `).run({
    $id: `${id}-user`,
    $session_id: id,
    $content: `hello ${id}`,
    $created_at: startedAt,
  });
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

    // 默认 body 禁止 messages/turns/tool_calls 全量数组
    expect(bundle).not.toHaveProperty("messages");
    expect(bundle).not.toHaveProperty("turns");
    expect(bundle).not.toHaveProperty("tool_calls");
    expect(bundle).not.toHaveProperty("counts");

    const base = created.api_url;
    expect(bundle.resources).toEqual({
      search: `${base}/search`,
      trace: `${base}/trace?limit=50`,
      messages: `${base}/messages?format=jsonl&limit=50`,
      turns: `${base}/turns?format=jsonl&limit=50`,
      tool_calls: `${base}/tool-calls?format=jsonl&limit=50`,
    });
    expect(bundle.scope).toEqual({ types: [], node: null, child: null });
    expect(bundle).not.toHaveProperty("rows");
    expect(bundle).not.toHaveProperty("item");
    expect(bundle).not.toHaveProperty("items");

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
    expect(bundle).not.toHaveProperty("counts");
    expect(bundle).not.toHaveProperty("messages");
    expect(bundle.share.expires_at).toBe(created.expires_at);
    expect(bundle.resources.trace).toContain(`/v1/public/session-shares/${alias}/trace`);
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
    expect(bundle).not.toHaveProperty("counts");
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
      `/v1/public/session-shares/${created.token}/trace`,
      `/v1/public/session-shares/${created.token}/messages`,
      `/v1/public/session-shares/${created.token}/turns`,
      `/v1/public/session-shares/${created.token}/tool-calls`,
      `/v1/public/session-shares/${created.token}/focus?node=msg-share-sess-1`,
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

  it("paginates the shared root trace and filters complete categories", async () => {
    seedLinkedSession(db, "share-child-1", "share-sess-1", {
      startedAt: new Date(SEED_TIME_BASE + 1000).toISOString(),
    });
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('reasoning-share-1', 'share-sess-1', 'reasoning', 'reasoning body', $created_at)
    `).run({ $created_at: new Date(SEED_TIME_BASE + 1500).toISOString() });
    db.query(`
      INSERT INTO turns (
        id, session_id, model, provider, total_tokens, duration_ms, cost_usd,
        finish_reason, error, created_at
      ) VALUES
        ('abort-share-1', 'share-sess-1', 'claude-sonnet-4', 'anthropic', 1, 1, 0,
          'aborted', NULL, $abort_at),
        ('error-share-1', 'share-sess-1', 'claude-sonnet-4', 'anthropic', 1, 1, 0,
          NULL, 'provider failed', $error_at)
    `).run({
      $abort_at: new Date(SEED_TIME_BASE + 2000).toISOString(),
      $error_at: new Date(SEED_TIME_BASE + 3000).toISOString(),
    });
    const created = await createShare(app);

    const first = await app.request(
      `/v1/public/session-shares/${created.token}/trace?limit=2&offset=0`,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.items.map((item: { key: string }) => item.key)).toEqual([
      "msg-msg-share-sess-1",
      "msg-msg-asst-share-sess-1",
    ]);
    expect(firstBody.items.map((item: { category: string }) => item.category)).toEqual([
      "user",
      "assistant",
    ]);
    expect(firstBody.pagination).toEqual({
      limit: 2,
      offset: 0,
      returned: 2,
      has_more: true,
      next_offset: 2,
    });

    const second = await app.request(
      `/v1/public/session-shares/${created.token}/trace?limit=2&offset=2`,
    );
    const secondBody = await second.json();
    expect(secondBody.items.map((item: { key: string }) => item.key)).toEqual([
      "turn-turn-share-sess-1",
      "turn-turn-2-share-sess-1",
    ]);

    const filteredShare = await createShare(app, "6h", "share-sess-1", {
      types: ["assistant", "tool"],
    });
    const filtered = await app.request(
      `/v1/public/session-shares/${filteredShare.token}/trace?limit=50`,
    );
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json();
    expect(filteredBody.items.map((item: { category: string }) => item.category)).toEqual([
      "assistant",
      "tool",
      "tool",
    ]);
    expect(filteredBody.items.map((item: { key: string }) => item.key).sort()).toEqual([
      "msg-msg-asst-share-sess-1",
      "tool-tool-2-share-sess-1",
      "tool-tool-share-sess-1",
    ]);

    const subagentShare = await createShare(app, "6h", "share-sess-1", {
      types: ["subagent"],
    });
    const subagents = await app.request(
      `/v1/public/session-shares/${subagentShare.token}/trace`,
    );
    const subagentBody = await subagents.json();
    expect(subagentBody.items).toHaveLength(1);
    expect(subagentBody.items[0].key).toBe("subagent-share-child-1");
    expect(subagentBody.items[0].category).toBe("subagent");
    expect(JSON.stringify(subagentBody)).not.toContain("hello share-child-1");
    expect(subagentBody.items[0]).not.toHaveProperty("parent_session_id");

    const statusShare = await createShare(app, "6h", "share-sess-1", {
      types: ["reasoning", "abort", "error"],
    });
    const statuses = await app.request(
      `/v1/public/session-shares/${statusShare.token}/trace`,
    );
    const statusBody = await statuses.json();
    expect(statusBody.items.map((item: { category: string }) => item.category)).toEqual([
      "reasoning",
      "abort",
      "error",
    ]);

    for (const path of ["limit=101", "limit=0", "offset=-1"]) {
      const invalid = await app.request(
        `/v1/public/session-shares/${created.token}/trace?${path}`,
      );
      expect(invalid.status).toBe(400);
    }
  });

  it("persists a hard type scope across page, trace, focus, resources, and active links", async () => {
    db.query(`
      INSERT INTO messages (id, session_id, role, content, created_at)
      VALUES ('msg-tool-role-share-sess-1', 'share-sess-1', 'tool', 'tool role message', $created_at)
    `).run({ $created_at: new Date(SEED_TIME_BASE - 1750).toISOString() });
    const created = await createShare(app, "6h", "share-sess-1", {
      types: ["tool", "assistant", "tool"],
    });
    expect(created.share_url).toContain("?types=assistant,tool");
    expect(created.agent_prompt).toBe(expectedAgentPrompt(created.api_url, true));

    const root = await app.request(`/v1/public/session-shares/${created.token}`);
    expect(root.status).toBe(200);
    const bundle = await root.json();
    expect(bundle.scope).toEqual({ types: ["assistant", "tool"], node: null, child: null });
    expect(bundle.resources).toEqual({ trace: `${created.api_url}/trace?limit=50` });
    expect(bundle.agent_prompt).toBe(expectedAgentPrompt(created.api_url, true));

    const trace = await app.request(
      `/v1/public/session-shares/${created.token}/trace?types=user,turn`,
    );
    expect(trace.status).toBe(200);
    const traceBody = await trace.json();
    expect(traceBody.items.map((item: { category: string }) => item.category)).toEqual([
      "assistant",
      "tool",
      "tool",
      "tool",
    ]);
    expect(traceBody.items.map((item: { key: string }) => item.key)).toContain(
      "msg-msg-tool-role-share-sess-1",
    );

    const allowedFocus = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-asst-share-sess-1`,
    );
    expect(allowedFocus.status).toBe(200);
    const blockedFocus = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1`,
    );
    expect(blockedFocus.status).toBe(404);

    for (const resource of ["search?q=hello", "messages", "turns", "tool-calls"]) {
      const blocked = await app.request(
        `/v1/public/session-shares/${created.token}/${resource}`,
      );
      expect(blocked.status).toBe(403);
    }

    const active = await app.request("/v1/sessions/share-sess-1/shares", {
      headers: { "X-API-Key": API_KEY },
    });
    const activeBody = await active.json();
    const listed = activeBody.shares.find((share: { id: string }) => share.id === created.id);
    expect(listed.scope).toEqual({ types: ["assistant", "tool"], node: null, child: null });
    expect(listed.share_url).toContain("?types=assistant,tool");
  });

  it("persists an exact node scope and rejects attempts to expand it", async () => {
    const created = await createShare(app, "6h", "share-sess-1", {
      types: ["turn"],
      node: "turn-turn-share-sess-1",
    });
    expect(created.share_url).toContain("types=turn");
    expect(created.share_url).toContain("node=turn-turn-share-sess-1");

    const root = await app.request(`/v1/public/session-shares/${created.token}`);
    const bundle = await root.json();
    expect(bundle.scope).toEqual({
      types: ["turn"],
      node: "turn-turn-share-sess-1",
      child: null,
    });

    const trace = await app.request(`/v1/public/session-shares/${created.token}/trace`);
    const traceBody = await trace.json();
    expect(traceBody.items.map((item: { key: string }) => item.key)).toEqual([
      "turn-turn-share-sess-1",
    ]);

    const otherTurn = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=turn-turn-2-share-sess-1`,
    );
    expect(otherTurn.status).toBe(404);

    const mismatch = await app.request("/v1/sessions/share-sess-1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({
        duration: "1h",
        types: ["assistant"],
        node: "turn-turn-share-sess-1",
      }),
    });
    expect(mismatch.status).toBe(400);

    const invalidTypes = await app.request("/v1/sessions/share-sess-1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ duration: "1h", types: ["assistant", "secret"] }),
    });
    expect(invalidTypes.status).toBe(400);

    const childWithoutNode = await app.request("/v1/sessions/share-sess-1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ duration: "1h", child: "share-child-1" }),
    });
    expect(childWithoutNode.status).toBe(400);
  });

  it("merges a Cursor synthetic turn and excludes its billing row", async () => {
    seedSession(db, "share-cursor-root");
    db.query("UPDATE sessions SET agent = 'cursor' WHERE id = 'share-cursor-root'").run();
    db.query(`
      INSERT INTO turns (
        id, session_id, message_id, model, provider,
        input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at
      ) VALUES (
        'cursor-usage-root-bill', 'share-cursor-root', 'msg-asst-share-cursor-root',
        'cursor', 'cursor', 8, 4, 12, 0.002, 30, $created_at
      )
    `).run({ $created_at: new Date(SEED_TIME_BASE - 2000).toISOString() });
    const created = await createShare(app, "6h", "share-cursor-root", { types: ["turn"] });

    const res = await app.request(
      `/v1/public/session-shares/${created.token}/trace`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = body.items.map((item: { key: string }) => item.key);
    expect(keys).toContain("cursor-turn-msg-asst-share-cursor-root");
    expect(keys).not.toContain("turn-cursor-usage-root-bill");
    const synthetic = body.items.find(
      (item: { key: string }) => item.key === "cursor-turn-msg-asst-share-cursor-root",
    );
    expect(synthetic.id).toBe("msg-asst-share-cursor-root");
    expect(synthetic.total_tokens).toBe(12);
  });

  it("focus requires a node and protects the share credential", async () => {
    const created = await createShare(app, "1h");
    const alias = expectedShareAlias(created.id);

    const missingNode = await app.request(`/v1/public/session-shares/${created.token}/focus`);
    expect(missingNode.status).toBe(400);
    expect(await missingNode.json()).toEqual({ error: "Invalid node" });

    const badNode = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=not-a-key`,
    );
    expect(badNode.status).toBe(400);

    const invalid = await app.request("/v1/public/session-shares/not-a-real-token/focus?node=msg-share-sess-1");
    expect(invalid.status).toBe(404);

    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    db.query(
      "UPDATE session_shares SET expires_at = $expires_at WHERE token_hash = $token_hash",
    ).run({
      $expires_at: new Date(Date.now() - 60_000).toISOString(),
      $token_hash: tokenHash,
    });
    const expired = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1`,
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "Share expired" });

    db.query(
      "UPDATE session_shares SET expires_at = $expires_at WHERE token_hash = $token_hash",
    ).run({
      $expires_at: new Date(Date.now() + 60_000).toISOString(),
      $token_hash: tokenHash,
    });
    const viaAlias = await app.request(
      `/v1/public/session-shares/${alias}/focus?node=msg-msg-share-sess-1`,
    );
    expect(viaAlias.status).toBe(200);
    const body = await viaAlias.json();
    expect(body.node).toBe("msg-msg-share-sess-1");
    expect(body.child).toBeNull();
    expect(body.item.key).toBe("msg-msg-share-sess-1");
    expect(body).not.toHaveProperty("items");
  });

  it("focus looks up root keys and returns a bounded explicit projection", async () => {
    const created = await createShare(app);

    const msg = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1`,
    );
    expect(msg.status).toBe(200);
    const body = await msg.json();
    expect(body.node).toBe("msg-msg-share-sess-1");
    expect(body.child).toBeNull();
    expect(body).not.toHaveProperty("items");
    expect(body.item.key).toBe("msg-msg-share-sess-1");
    expect(body.item.kind).toBe("message");
    expect(body.item.id).toBe("msg-share-sess-1");
    expect(body.item.content).toContain("hello share");
    expect(body.item).toHaveProperty("truncated");
    expect(body.item).not.toHaveProperty("tool_calls");
    expect(body.item).not.toHaveProperty("focused");

    const turn = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=turn-turn-share-sess-1`,
    );
    expect(turn.status).toBe(200);
    const turnBody = await turn.json();
    expect(turnBody.item.key).toBe("turn-turn-share-sess-1");
    expect(turnBody.item.kind).toBe("turn");
    expect(turnBody.item.cost_cny).toBeDefined();

    const tool = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=tool-tool-share-sess-1`,
    );
    expect(tool.status).toBe(200);
    const toolBody = await tool.json();
    expect(toolBody.item.key).toBe("tool-tool-share-sess-1");
    expect(toolBody.item.kind).toBe("tool");
    expect(toolBody.item).toHaveProperty("args_truncated");
    expect(toolBody.item).toHaveProperty("output_text_truncated");
    expect(toolBody.item).not.toHaveProperty("file_path");

    const dump = JSON.stringify(body);
    for (const secret of [
      "secret-project",
      "user@secret.example",
      "secret-host",
      "/secret/dir",
      "git@secret.example",
      "parent-secret",
    ]) {
      expect(dump).not.toContain(secret);
    }
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
      expect(body.item).not.toHaveProperty(key);
    }
  });

  it("focus confines lookup to the shared root session", async () => {
    seedLinkedSession(db, "share-child-1", "share-sess-1", {
      startedAt: "2026-07-09T12:10:00.000Z",
    });
    const created = await createShare(app);

    const childMsgOnRoot = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-share-child-1-user`,
    );
    expect(childMsgOnRoot.status).toBe(404);

    const subagent = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=subagent-share-child-1`,
    );
    expect(subagent.status).toBe(200);
    const body = await subagent.json();
    expect(body.item.kind).toBe("subagent");
    expect(body.item.id).toBe("share-child-1");
    expect(body.item.summary).toBe("子会话 share-child-1");
    expect(body.item).not.toHaveProperty("project_name");
    expect(body.item).not.toHaveProperty("metadata");
    expect(JSON.stringify(body.item)).not.toContain("secret-project");
    expect(JSON.stringify(body.item)).not.toContain("hello share-child-1");
  });

  it("focus confines child scope to descendants and rejects unrelated or cyclic parents", async () => {
    seedLinkedSession(db, "share-child-1", "share-sess-1", {
      startedAt: "2026-07-09T12:00:00.000Z",
    });
    seedLinkedSession(db, "share-grand-1", "share-child-1", {
      startedAt: "2026-07-09T12:01:00.000Z",
    });
    seedLinkedSession(db, "share-child-2", "share-sess-1", {
      startedAt: "2026-07-09T12:02:00.000Z",
    });
    seedLinkedSession(db, "unrelated-sess", null, {
      startedAt: "2026-07-09T12:03:00.000Z",
    });
    seedLinkedSession(db, "cycle-a", "share-sess-1", {
      startedAt: "2026-07-09T12:04:00.000Z",
    });
    seedLinkedSession(db, "cycle-b", "cycle-a", {
      startedAt: "2026-07-09T12:05:00.000Z",
    });
    db.query("UPDATE sessions SET parent_session_id = $parent WHERE id = $id").run({
      $parent: "cycle-b",
      $id: "cycle-a",
    });

    const created = await createShare(app);

    const childOk = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-share-child-1-user&child=share-child-1`,
    );
    expect(childOk.status).toBe(200);
    const childBody = await childOk.json();
    expect(childBody.child).toBe("share-child-1");
    expect(childBody.node).toBe("msg-share-child-1-user");
    expect(childBody.item.key).toBe("msg-share-child-1-user");

    const grandOk = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-share-grand-1-user&child=share-grand-1`,
    );
    expect(grandOk.status).toBe(200);
    expect((await grandOk.json()).child).toBe("share-grand-1");

    const parentNodeInChild = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1&child=share-child-1`,
    );
    expect(parentNodeInChild.status).toBe(404);

    const sibling = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-share-child-2-user&child=share-child-1`,
    );
    expect(sibling.status).toBe(404);

    const unrelated = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-unrelated-sess-user&child=unrelated-sess`,
    );
    expect(unrelated.status).toBe(404);

    const parentOfRoot = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1&child=parent-secret`,
    );
    expect(parentOfRoot.status).toBe(404);

    const cyclic = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-cycle-a-user&child=cycle-a`,
    );
    expect(cyclic.status).toBe(404);

    const explicitRoot = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-msg-share-sess-1&child=share-sess-1`,
    );
    expect(explicitRoot.status).toBe(200);
    expect((await explicitRoot.json()).child).toBeNull();
  });

  it("focus rejects child ancestor chains that exceed the hard depth limit", async () => {
    const base = Date.parse("2026-07-10T00:00:00.000Z");
    let parent = "share-sess-1";
    for (let i = 0; i <= FOCUS_ANCESTOR_DEPTH_MAX; i++) {
      const id = `deep-${i}`;
      seedLinkedSession(db, id, parent, {
        startedAt: new Date(base + i * 1000).toISOString(),
      });
      parent = id;
    }
    const created = await createShare(app);
    const allowedId = `deep-${FOCUS_ANCESTOR_DEPTH_MAX - 1}`;
    const rejectedId = `deep-${FOCUS_ANCESTOR_DEPTH_MAX}`;

    const allowed = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-${allowedId}-user&child=${allowedId}`,
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).child).toBe(allowedId);

    const rejected = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=msg-${rejectedId}-user&child=${rejectedId}`,
    );
    expect(rejected.status).toBe(404);
  });

  it("focus excludes fork structural keys from public excerpts", async () => {
    const created = await createShare(app);
    for (const node of ["fork-from-parent-secret", "fork-origin-msg-pmsg-1", "fork-from-"]) {
      const res = await app.request(
        `/v1/public/session-shares/${created.token}/focus?node=${encodeURIComponent(node)}`,
      );
      expect(res.status).toBe(404);
    }
  });

  it("focus supports cursor-turn keys on cursor descendant sessions", async () => {
    seedLinkedSession(db, "share-cursor-1", "share-sess-1", {
      agent: "cursor",
      startedAt: "2026-07-09T13:00:00.000Z",
    });
    db.query(`
      INSERT INTO messages (id, session_id, role, content, model, provider, created_at)
      VALUES ($id, $session_id, 'assistant', 'cursor reply', 'cursor', 'cursor', $created_at)
    `).run({
      $id: "asst-cursor-1",
      $session_id: "share-cursor-1",
      $created_at: "2026-07-09T13:00:01.000Z",
    });
    db.query(`
      INSERT INTO turns (
        id, session_id, message_id, model, provider,
        input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at
      ) VALUES (
        $id, $session_id, $message_id, 'cursor', 'cursor',
        8, 4, 12, 0.002, 30, $created_at
      )
    `).run({
      $id: "cursor-usage-bill-1",
      $session_id: "share-cursor-1",
      $message_id: "asst-cursor-1",
      $created_at: "2026-07-09T13:00:01.000Z",
    });

    const created = await createShare(app);
    const res = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=cursor-turn-asst-cursor-1&child=share-cursor-1`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.child).toBe("share-cursor-1");
    expect(body.node).toBe("cursor-turn-asst-cursor-1");
    expect(body.item.key).toBe("cursor-turn-asst-cursor-1");
    expect(body.item.kind).toBe("turn");
    expect(body.item.id).toBe("asst-cursor-1");
    expect(body.item.total_tokens).toBe(12);
    expect(body.item.cost_cny).toBeDefined();
    expect(body.item.key).not.toBe("turn-cursor-usage-bill-1");

    const billingKey = await app.request(
      `/v1/public/session-shares/${created.token}/focus?node=turn-cursor-usage-bill-1&child=share-cursor-1`,
    );
    expect(billingKey.status).toBe(404);
  });
});
