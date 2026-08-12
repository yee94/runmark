import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { withCostCny, withTotalCostCny } from "../services/currency";

/** 人类可复制 share 链接 HMAC 前缀（与 apiKey 组合，不入库） */
const SHARE_LINK_HMAC_PREFIX = "agent-tracker-session-share-link-v1:";

/** 允许的分享有效期 */
const SHARE_DURATIONS = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

export type ShareDuration = keyof typeof SHARE_DURATIONS;

const SEARCH_SNIPPET_MAX = 500;
const MESSAGE_CONTENT_MAX = 16 * 1024;
const TOOL_ARGS_MAX = 8 * 1024;
const TOOL_OUTPUT_MAX = 16 * 1024;
const SEARCH_LIMIT_MAX = 50;
const LIST_LIMIT_MAX = 100;
const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** 公开分享 session 字段白名单（排除环境/身份/导航类敏感字段） */
type SessionRow = {
  id: string;
  title?: string | null;
  AISummary?: string | null;
  agent?: string | null;
  provider?: string | null;
  model?: string | null;
  started_at: string;
  ended_at?: string | null;
  request_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cost_usd?: number;
};

type ShareRow = {
  token_hash: string;
  session_id: string;
  created_at: string;
  expires_at: string;
};

/** 将 sessions.model（逗号分隔）拆成展示用 models[] */
function splitStoredModels(value: string | null | undefined): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(value || "").split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(name);
  }
  return parts;
}

function maxIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function minIsoTimestamp(...values: Array<string | null | undefined>): string {
  let best = "";
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = new Date(v).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

/** 单 session 序列化：显式白名单，不含 children/fork/环境身份字段 */
function serializeShareSession(db: Database, row: SessionRow) {
  const lastMsg = db
    .query<{ last_at: string | null }, { $id: string }>(
      "SELECT MAX(created_at) as last_at FROM messages WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const lastTurn = db
    .query<{ last_at: string | null }, { $id: string }>(
      "SELECT MAX(created_at) as last_at FROM turns WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const firstMsg = db
    .query<{ first_at: string | null }, { $id: string }>(
      "SELECT MIN(created_at) as first_at FROM messages WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const firstTurn = db
    .query<{ first_at: string | null }, { $id: string }>(
      "SELECT MIN(created_at) as first_at FROM turns WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const messageCount = db
    .query<{ n: number }, { $id: string }>(
      "SELECT COUNT(*) as n FROM messages WHERE session_id = $id",
    )
    .get({ $id: row.id });
  const turnCount = db
    .query<{ n: number }, { $id: string }>(
      "SELECT COUNT(*) as n FROM turns WHERE session_id = $id",
    )
    .get({ $id: row.id });

  const models = splitStoredModels(row.model);
  const lastActivityAt = maxIsoTimestamp(row.started_at, row.ended_at, lastMsg?.last_at, lastTurn?.last_at);
  const firstActivityAt = minIsoTimestamp(firstMsg?.first_at, firstTurn?.first_at) || row.started_at;
  const durationMs = Math.max(
    0,
    new Date(lastActivityAt).getTime() - new Date(firstActivityAt).getTime(),
  );

  return {
    id: row.id,
    title: row.title ?? null,
    AISummary: row.AISummary ?? null,
    summary: (row.title && String(row.title).trim()) || row.id,
    agent: row.agent ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    models,
    started_at: row.started_at,
    ended_at: row.ended_at ?? null,
    last_activity_at: lastActivityAt,
    duration_ms: durationMs,
    request_count: row.request_count ?? 0,
    total_input_tokens: row.total_input_tokens ?? 0,
    total_output_tokens: row.total_output_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0,
    total_cost_usd: row.total_cost_usd ?? 0,
    message_count: messageCount?.n ?? 0,
    turn_count: turnCount?.n ?? 0,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 管理 id：64 位 hex（与 token_hash 同形） */
function isShareId(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function requestOrigin(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

/** 从 token_hash 生成可验证的人类 share alias（不入库，可重算） */
function signShareLinkAlias(apiKey: string, tokenHash: string): string {
  const signature = createHmac("sha256", apiKey)
    .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
    .digest("base64url");
  return `${tokenHash}.${signature}`;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** alias 形如 token_hash.signature；否则视为原始 token */
type ResolvedShareCredential =
  | { kind: "raw"; token: string; tokenHash: string }
  | { kind: "alias"; tokenHash: string; alias: string };

function resolveShareCredential(
  credential: string,
  apiKey: string,
): ResolvedShareCredential | null {
  const aliasMatch = /^([0-9a-f]{64})\.([A-Za-z0-9_-]+)$/i.exec(credential);
  if (aliasMatch) {
    const tokenHash = aliasMatch[1].toLowerCase();
    const providedSig = aliasMatch[2];
    const expectedSig = createHmac("sha256", apiKey)
      .update(`${SHARE_LINK_HMAC_PREFIX}${tokenHash}`)
      .digest("base64url");
    if (!safeEqualString(providedSig, expectedSig)) {
      return null;
    }
    return {
      kind: "alias",
      tokenHash,
      alias: signShareLinkAlias(apiKey, tokenHash),
    };
  }
  return {
    kind: "raw",
    token: credential,
    tokenHash: hashToken(credential),
  };
}

/** 浏览器导航（Accept: text/html）时 302 到 Dashboard 分享页；curl/fetch 默认走 JSON */
function wantsHtmlRedirect(c: Context): boolean {
  const accept = c.req.header("Accept") ?? "";
  if (!/\btext\/html\b/i.test(accept)) return false;
  // 显式要 JSON 时不重定向（curl / SPA fetch 保持 JSON）
  if (/\bapplication\/json\b/i.test(accept)) {
    const htmlIdx = accept.search(/\btext\/html\b/i);
    const jsonIdx = accept.search(/\bapplication\/json\b/i);
    return htmlIdx >= 0 && htmlIdx < jsonIdx;
  }
  return true;
}

/** agent_prompt：先摘要；详情走 resources；仅一条默认 curl 落盘 */
function buildAgentPrompt(apiUrl: string): string {
  return [
    "请先读取 Session 摘要（优先 AISummary）。需要详情时，从响应 resources 选择 search / messages / turns / tool_calls 链接，用 curl -o <file> 落盘后再分析。",
    "",
    "---",
    "",
    `curl -sS -o runmark-session-summary.json ${JSON.stringify(apiUrl)}`,
  ].join("\n");
}

function publicShareBaseUrl(origin: string, credential: string): string {
  return `${origin}/v1/public/session-shares/${credential}`;
}

function truncateText(
  value: string | null | undefined,
  max: number,
): { text: string; truncated: boolean } {
  const text = value == null ? "" : String(value);
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw == null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseFormat(raw: string | undefined): "json" | "jsonl" | null {
  if (raw == null || raw === "" || raw === "json") return "json";
  if (raw === "jsonl") return "jsonl";
  return null;
}

/** 将用户搜索词中的 SQLite LIKE 通配符按字面量转义（配合 ESCAPE '\'） */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function respondList(
  c: Context,
  format: "json" | "jsonl",
  items: unknown[],
  nextOffset: number | null,
) {
  if (format === "jsonl") {
    const body =
      items.length === 0
        ? ""
        : items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": NDJSON_CONTENT_TYPE },
    });
  }
  return c.json({ items, next_offset: nextOffset });
}

type ShareAccess =
  | { ok: true; share: ShareRow; resolved: ResolvedShareCredential; credential: string }
  | { ok: false; status: 404 | 410; error: string };

function resolveShareAccess(
  db: Database,
  credential: string | undefined,
  apiKey: string,
): ShareAccess {
  if (!credential) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const resolved = resolveShareCredential(credential, apiKey);
  if (!resolved) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const share = db
    .query(
      `SELECT token_hash, session_id, created_at, expires_at
       FROM session_shares WHERE token_hash = $token_hash`,
    )
    .get({ $token_hash: resolved.tokenHash }) as ShareRow | null;
  if (!share) {
    return { ok: false, status: 404, error: "Not found" };
  }
  const expiresMs = new Date(share.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: "Share expired" };
  }
  return { ok: true, share, resolved, credential };
}

function countRows(db: Database, table: "messages" | "turns" | "tool_calls", sessionId: string): number {
  const row = db
    .query<{ n: number }, { $id: string }>(
      `SELECT COUNT(*) as n FROM ${table} WHERE session_id = $id`,
    )
    .get({ $id: sessionId });
  return row?.n ?? 0;
}

function projectMessage(row: {
  id: string;
  role: string;
  content?: string | null;
  model?: string | null;
  provider?: string | null;
  created_at: string;
}) {
  const content = truncateText(row.content, MESSAGE_CONTENT_MAX);
  return {
    id: row.id,
    role: row.role,
    content: content.text,
    truncated: content.truncated,
    model: row.model ?? null,
    provider: row.provider ?? null,
    created_at: row.created_at,
  };
}

function projectTurn(row: {
  id: string;
  message_id?: string | null;
  model: string;
  provider: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  duration_ms?: number;
  cost_usd?: number;
  finish_reason?: string | null;
  error?: string | null;
  created_at: string;
}) {
  const withCny = withCostCny(row);
  return {
    id: row.id,
    message_id: row.message_id ?? null,
    model: row.model,
    provider: row.provider,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens ?? 0,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    reasoning_tokens: row.reasoning_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0,
    duration_ms: row.duration_ms ?? 0,
    cost_usd: row.cost_usd ?? 0,
    cost_cny: withCny.cost_cny,
    finish_reason: row.finish_reason ?? null,
    error: row.error ?? null,
    created_at: row.created_at,
  };
}

function projectToolCall(row: {
  id: string;
  tool_name: string;
  call_id?: string | null;
  args?: string | null;
  output_title?: string | null;
  output_text?: string | null;
  file_path?: string | null;
  duration_ms?: number;
  error?: string | null;
  created_at: string;
}) {
  const args = truncateText(row.args, TOOL_ARGS_MAX);
  const output = truncateText(row.output_text, TOOL_OUTPUT_MAX);
  return {
    id: row.id,
    tool_name: row.tool_name,
    call_id: row.call_id ?? null,
    output_title: row.output_title ?? null,
    file_path: row.file_path ?? null,
    duration_ms: row.duration_ms ?? 0,
    error: row.error ?? null,
    created_at: row.created_at,
    args: args.text,
    args_truncated: args.truncated,
    output_text: output.text,
    output_text_truncated: output.truncated,
  };
}

/** 创建/列表/撤回分享：/v1/sessions/:id/shares*（由 app 层 sessions authGuard 保护） */
export function createSessionSharesRoute(db: Database, apiKey: string) {
  const app = new Hono();

  app.post("/v1/sessions/:id/shares", async (c) => {
    const sessionId = c.req.param("id");
    const session = db
      .query("SELECT id FROM sessions WHERE id = $id")
      .get({ $id: sessionId }) as { id: string } | null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { duration?: string };
    const duration = body.duration as ShareDuration | undefined;
    if (!duration || !(duration in SHARE_DURATIONS)) {
      return c.json(
        { error: "Invalid duration", allowed: Object.keys(SHARE_DURATIONS) },
        400,
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHARE_DURATIONS[duration]);
    const token = generateShareToken();
    const tokenHash = hashToken(token);
    const createdAt = now.toISOString();
    const expiresAtIso = expiresAt.toISOString();

    db.query(`
      INSERT INTO session_shares (token_hash, session_id, created_at, expires_at)
      VALUES ($token_hash, $session_id, $created_at, $expires_at)
    `).run({
      $token_hash: tokenHash,
      $session_id: sessionId,
      $created_at: createdAt,
      $expires_at: expiresAtIso,
    });

    const origin = requestOrigin(c);
    const alias = signShareLinkAlias(apiKey, tokenHash);
    // 人类可复制链接用签名 alias；API / agent_prompt 仍用原始 token
    const shareUrl = `${origin}/#/share/${alias}`;
    const apiUrl = `${origin}/v1/public/session-shares/${token}`;

    return c.json(
      {
        id: tokenHash,
        token,
        share_url: shareUrl,
        api_url: apiUrl,
        expires_at: expiresAtIso,
        agent_prompt: buildAgentPrompt(apiUrl),
      },
      201,
    );
  });

  app.get("/v1/sessions/:id/shares", (c) => {
    const sessionId = c.req.param("id");
    const session = db
      .query("SELECT id FROM sessions WHERE id = $id")
      .get({ $id: sessionId }) as { id: string } | null;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const nowIso = new Date().toISOString();
    const rows = db
      .query(
        `SELECT token_hash, created_at, expires_at
         FROM session_shares
         WHERE session_id = $session_id AND expires_at > $now
         ORDER BY created_at DESC`,
      )
      .all({ $session_id: sessionId, $now: nowIso }) as Array<{
      token_hash: string;
      created_at: string;
      expires_at: string;
    }>;

    const origin = requestOrigin(c);
    return c.json({
      shares: rows.map((row) => ({
        id: row.token_hash,
        created_at: row.created_at,
        expires_at: row.expires_at,
        share_url: `${origin}/#/share/${signShareLinkAlias(apiKey, row.token_hash)}`,
      })),
    });
  });

  app.delete("/v1/sessions/:id/shares/:shareId", (c) => {
    const sessionId = c.req.param("id");
    const shareId = c.req.param("shareId");
    if (!isShareId(shareId)) {
      return c.json({ error: "Not found" }, 404);
    }

    const result = db
      .query(
        `DELETE FROM session_shares
         WHERE session_id = $session_id AND token_hash = $token_hash`,
      )
      .run({
        $session_id: sessionId,
        $token_hash: shareId.toLowerCase(),
      });

    if (result.changes === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ revoked: true });
  });

  return app;
}

/** 公开读取分享 bundle：GET /v1/public/session-shares/:token（免登录） */
export function createPublicSessionSharesRoute(db: Database, apiKey: string) {
  const app = new Hono();

  app.get("/v1/public/session-shares/:credential", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const origin = requestOrigin(c);

    // 浏览器打开 API URL：302 到人类页。raw token 必须保留原 token，禁止改成 alias
    if (wantsHtmlRedirect(c)) {
      const pageCredential =
        access.resolved.kind === "raw" ? access.resolved.token : access.resolved.alias;
      return c.redirect(`${origin}/#/share/${pageCredential}`, 302);
    }

    const session = db
      .query(`
        SELECT id, title, AISummary, agent, provider, model,
          started_at, ended_at, request_count,
          total_input_tokens, total_output_tokens, total_tokens, total_cost_usd
        FROM sessions WHERE id = $id
      `)
      .get({ $id: access.share.session_id }) as SessionRow | null;
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    // 默认仅摘要：COUNT，不拉 messages/turns/tool_calls 全量行
    const counts = {
      messages: countRows(db, "messages", access.share.session_id),
      turns: countRows(db, "turns", access.share.session_id),
      tool_calls: countRows(db, "tool_calls", access.share.session_id),
    };

    // agent_prompt 在持有原始 token 时继续引用 raw API URL（创建响应 / curl 场景）
    const credentialForUrls =
      access.resolved.kind === "raw" ? access.resolved.token : access.resolved.alias;
    const apiUrl = publicShareBaseUrl(origin, credentialForUrls);
    const resources = {
      search: `${apiUrl}/search`,
      messages: `${apiUrl}/messages?format=jsonl&limit=50`,
      turns: `${apiUrl}/turns?format=jsonl&limit=50`,
      tool_calls: `${apiUrl}/tool-calls?format=jsonl&limit=50`,
    };

    const summaryMarkdown =
      session.AISummary == null || String(session.AISummary).trim() === ""
        ? null
        : String(session.AISummary);

    return c.json({
      share: { expires_at: access.share.expires_at },
      session: withTotalCostCny(serializeShareSession(db, session)),
      summary_markdown: summaryMarkdown,
      counts,
      resources,
      agent_prompt: buildAgentPrompt(apiUrl),
    });
  });

  app.get("/v1/public/session-shares/:credential/search", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) {
      return c.json({ error: "Invalid q", hint: "q must be at least 2 characters" }, 400);
    }
    const kind = (c.req.query("kind") ?? "all").toLowerCase();
    if (kind !== "all" && kind !== "message" && kind !== "tool") {
      return c.json({ error: "Invalid kind", allowed: ["all", "message", "tool"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 20, 1, SEARCH_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: SEARCH_LIMIT_MAX }, 400);
    }

    const like = `%${escapeLikePattern(q)}%`;
    type SearchItem = {
      kind: "message" | "tool";
      id: string;
      created_at: string;
      role?: string;
      tool_name?: string;
      snippet: string;
    };
    const items: SearchItem[] = [];

    if (kind === "all" || kind === "message") {
      const rows = db
        .query(
          `SELECT id, role, content, created_at
           FROM messages
           WHERE session_id = $session_id AND content LIKE $q ESCAPE '\\'
           ORDER BY created_at ASC
           LIMIT $limit`,
        )
        .all({
          $session_id: access.share.session_id,
          $q: like,
          $limit: limit,
        }) as Array<{ id: string; role: string; content: string | null; created_at: string }>;
      for (const row of rows) {
        items.push({
          kind: "message",
          id: row.id,
          created_at: row.created_at,
          role: row.role,
          snippet: truncateText(row.content, SEARCH_SNIPPET_MAX).text,
        });
      }
    }

    if (kind === "all" || kind === "tool") {
      const remaining = Math.max(0, limit - items.length);
      if (remaining > 0) {
        const rows = db
          .query(
            `SELECT id, tool_name, output_title, output_text, created_at
             FROM tool_calls
             WHERE session_id = $session_id
               AND (
                 tool_name LIKE $q ESCAPE '\\'
                 OR IFNULL(output_title, '') LIKE $q ESCAPE '\\'
                 OR IFNULL(output_text, '') LIKE $q ESCAPE '\\'
               )
             ORDER BY created_at ASC
             LIMIT $limit`,
          )
          .all({
            $session_id: access.share.session_id,
            $q: like,
            $limit: remaining,
          }) as Array<{
          id: string;
          tool_name: string;
          output_title: string | null;
          output_text: string | null;
          created_at: string;
        }>;
        for (const row of rows) {
          const snippetSource =
            (row.output_title && row.output_title.includes(q) && row.output_title) ||
            (row.output_text && row.output_text) ||
            row.tool_name;
          items.push({
            kind: "tool",
            id: row.id,
            created_at: row.created_at,
            tool_name: row.tool_name,
            snippet: truncateText(snippetSource, SEARCH_SNIPPET_MAX).text,
          });
        }
      }
    }

    items.sort((a, b) => {
      if (a.created_at < b.created_at) return -1;
      if (a.created_at > b.created_at) return 1;
      return 0;
    });

    return c.json({ items: items.slice(0, limit) });
  });

  app.get("/v1/public/session-shares/:credential/messages", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }
    const role = c.req.query("role");
    if (role != null && role !== "" && role !== "user" && role !== "assistant") {
      return c.json({ error: "Invalid role", allowed: ["user", "assistant"] }, 400);
    }

    const rows = (
      role
        ? db
            .query(
              `SELECT id, role, content, model, provider, created_at
               FROM messages
               WHERE session_id = $session_id AND role = $role
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $role: role,
              $limit: limit + 1,
              $offset: offset,
            })
        : db
            .query(
              `SELECT id, role, content, model, provider, created_at
               FROM messages
               WHERE session_id = $session_id
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $limit: limit + 1,
              $offset: offset,
            })
    ) as Array<{
      id: string;
      role: string;
      content: string | null;
      model: string | null;
      provider: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectMessage);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  app.get("/v1/public/session-shares/:credential/turns", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }

    const rows = db
      .query(
        `SELECT id, message_id, model, provider,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, total_tokens, duration_ms, cost_usd,
           finish_reason, error, created_at
         FROM turns
         WHERE session_id = $session_id
         ORDER BY created_at ASC
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        $session_id: access.share.session_id,
        $limit: limit + 1,
        $offset: offset,
      }) as Array<{
      id: string;
      message_id: string | null;
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
      duration_ms: number;
      cost_usd: number;
      finish_reason: string | null;
      error: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectTurn);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  app.get("/v1/public/session-shares/:credential/tool-calls", (c) => {
    const access = resolveShareAccess(db, c.req.param("credential"), apiKey);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const format = parseFormat(c.req.query("format"));
    if (!format) {
      return c.json({ error: "Invalid format", allowed: ["json", "jsonl"] }, 400);
    }
    const limit = parseBoundedInt(c.req.query("limit"), 50, 1, LIST_LIMIT_MAX);
    if (limit == null) {
      return c.json({ error: "Invalid limit", min: 1, max: LIST_LIMIT_MAX }, 400);
    }
    const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (offset == null) {
      return c.json({ error: "Invalid offset", min: 0 }, 400);
    }
    const toolName = c.req.query("tool_name");

    const rows = (
      toolName
        ? db
            .query(
              `SELECT id, tool_name, call_id, args, output_title, output_text,
                 file_path, duration_ms, error, created_at
               FROM tool_calls
               WHERE session_id = $session_id AND tool_name = $tool_name
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $tool_name: toolName,
              $limit: limit + 1,
              $offset: offset,
            })
        : db
            .query(
              `SELECT id, tool_name, call_id, args, output_title, output_text,
                 file_path, duration_ms, error, created_at
               FROM tool_calls
               WHERE session_id = $session_id
               ORDER BY created_at ASC
               LIMIT $limit OFFSET $offset`,
            )
            .all({
              $session_id: access.share.session_id,
              $limit: limit + 1,
              $offset: offset,
            })
    ) as Array<{
      id: string;
      tool_name: string;
      call_id: string | null;
      args: string | null;
      output_title: string | null;
      output_text: string | null;
      file_path: string | null;
      duration_ms: number;
      error: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(projectToolCall);
    return respondList(c, format, page, hasMore ? offset + limit : null);
  });

  return app;
}
