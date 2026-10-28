import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { createOtlpRoute } from "../src/routes/otlp";
import { createSessionsRoute, createTurnsRoute, createStatsRoute } from "../src/routes/sessions";
import { ingestService } from "../src/services/ingest";
import { createIngestRoute } from "../src/routes/ingest";

// 测试数据按 magpie internal/otlp/otel_wire.go 的真实 OTLP/HTTP JSON 形状构造，
// 不依赖我们的解析实现，避免自证。

const START = "2026-10-20T08:00:00.000Z";
const END = "2026-10-20T08:00:01.500Z";

const ns = (iso: string) => String(BigInt(new Date(iso).getTime()) * 1_000_000n);

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

type SpanOverrides = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  start?: string;
  end?: string;
  status?: number;
  attributes?: ReturnType<typeof str>[];
};

/** 一次模型调用的 generation span（magpie 开 Sessions 后的形状） */
function generationSpan(overrides: SpanOverrides = {}) {
  return {
    traceId: overrides.traceId ?? "a".repeat(32),
    spanId: overrides.spanId ?? "b".repeat(16),
    parentSpanId: overrides.parentSpanId,
    name: "chat gpt-5",
    kind: 3,
    startTimeUnixNano: ns(overrides.start ?? START),
    endTimeUnixNano: ns(overrides.end ?? END),
    attributes: overrides.attributes ?? [
      str("gen_ai.operation.name", "chat"),
      str("gen_ai.provider.name", "openai"),
      str("gen_ai.request.model", "gpt-5"),
      str("magpie.agent", "opencode"),
      str("langfuse.session.id", "ses-magpie-1"),
      str("langfuse.trace.name", "opencode interaction"),
      str("langfuse.observation.type", "generation"),
      int("gen_ai.usage.input_tokens", 100),
      int("gen_ai.usage.output_tokens", 30),
      int("gen_ai.usage.cache_read.input_tokens", 0),
      int("gen_ai.usage.cache_creation.input_tokens", 0),
      int("gen_ai.usage.reasoning.output_tokens", 0),
    ],
    status: { code: overrides.status ?? 0 },
  };
}

function otlpPayload(spans: any[], serviceName = "magpie") {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", serviceName)] },
        scopeSpans: [{ scope: { name: "github.com/yetone/magpie" }, spans }],
      },
    ],
  };
}

describe("OTLP ingest", () => {
  let db: Database;
  let app: Hono;
  let directory: string | undefined;
  let notifications: Array<Array<{ session_id: string; type: string }>>;

  beforeEach(() => {
    notifications = [];
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);

    mount();
  });

  afterEach(() => {
    db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function mount() {
    app = new Hono();
    app.route("/", createOtlpRoute(db, undefined, events => notifications.push(events)));
    app.route("/", createIngestRoute(db, undefined, events => notifications.push(events)));
    app.route("/", createSessionsRoute(db));
    app.route("/", createTurnsRoute(db));
    app.route("/", createStatsRoute(db));
  }

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const sessions = async () => (await (await app.request("/v1/sessions")).json()) as any[];
  const turns = async (id: string) =>
    (await (await app.request(`/v1/sessions/${id}/turns`)).json()) as any[];

  const nativeTurn = (session_id = "ses-magpie-1") => ({
    type: "turn.completed", session_id, turn_id: "msg-native", message_id: "msg-native",
    model: "gpt-5", provider: "openai", input_tokens: 20, output_tokens: 5,
    total_tokens: 25, duration_ms: 100, cost_usd: 0.01, created_at: START,
  });

  it("原生 turn ID 被其它会话重报时不篡改原会话或新会话累计", async () => {
    await post("/v1/ingest", { events: [nativeTurn()] });
    await post("/v1/ingest", { events: [{ ...nativeTurn("ses-fork"), total_tokens: 500, input_tokens: 495, cost_usd: 10 }] });
    expect((await turns("ses-magpie-1"))[0]).toMatchObject({ total_tokens: 25, cost_usd: 0.01 });
    expect(await (await app.request("/v1/sessions/ses-fork")).json()).toMatchObject({ total_tokens: 0, total_cost_usd: 0 });
  });

  it("只有有效原生调用才切换到原生优先，移除双份正文与计数", async () => {
    const span = generationSpan();
    span.attributes.push(str("langfuse.observation.output", "gateway reply"));
    await post("/v1/traces", otlpPayload([span]));
    await post("/v1/ingest", { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }] });
    expect(await turns("ses-magpie-1")).toHaveLength(1);
    expect((await turns("ses-magpie-1"))[0].total_tokens).toBe(130);
    await post("/v1/ingest", { events: [nativeTurn(), {
      type: "message", session_id: "ses-magpie-1", message_id: "msg-native", role: "assistant", content: "native reply", created_at: END,
    }] });
    expect(await turns("ses-magpie-1")).toHaveLength(1);
    expect((await sessions())[0]).toMatchObject({ total_tokens: 25, total_cost_usd: 0.01, request_count: 1 });
    expect(await (await app.request("/v1/sessions/ses-magpie-1/messages")).json()).toMatchObject([{ content: "native reply" }]);
  });

  it("真实 Magpie 标识可精确关联缺失 session 属性的调用，不留下双份会话", async () => {
    // 来自 Magpie Go exporter 实测 fixture，而非测试中重算散列。
    const sid = "ses_runmark_identity_fixture";
    await post("/v1/traces", otlpPayload([generationSpan({
      traceId: "2ca25587e1e02369d26826f863a3da4a", spanId: "c7512cf75cbb9b0d",
      attributes: [str("magpie.agent", "opencode"), str("gen_ai.request.model", "gpt-5"), int("gen_ai.usage.input_tokens", 100)],
    })]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: sid, agent: "opencode" },
      { ...nativeTurn(sid), turn_id: "msg_assistant_1", message_id: "msg_assistant_1" },
      { type: "message", session_id: sid, message_id: "msg_user_1", role: "user", content: "hello", created_at: START },
    ] });
    expect(await sessions()).toHaveLength(1);
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ sessions: 1, turns: 1, tokens: { total: 25 } });
  });

  it("分层正文只保留 generation 对话，tool 作为工具记录；原生优先后查询一致", async () => {
    const root = generationSpan({ spanId: "root", attributes: [str("magpie.agent", "opencode"), str("langfuse.session.id", "ses-magpie-1"), str("langfuse.observation.type", "span"), str("langfuse.observation.output", "root duplicate")] });
    const tool = generationSpan({ spanId: "tool", attributes: [str("magpie.agent", "opencode"), str("langfuse.session.id", "ses-magpie-1"), str("langfuse.observation.type", "tool"), str("langfuse.observation.input", "tool args"), str("langfuse.observation.output", "tool result")] });
    await post("/v1/traces", otlpPayload([root, generationSpan(), tool]));
    expect(await (await app.request("/v1/sessions/ses-magpie-1/messages")).json()).toEqual([]);
    expect(await (await app.request("/v1/sessions/ses-magpie-1/tool-calls")).json()).toMatchObject([{ output_text: "tool result" }]);
    await post("/v1/ingest", { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }, nativeTurn(), { type: "tool.result", session_id: "ses-magpie-1", call_id: "native-tool", tool_name: "Read", output_text: "native result", duration_ms: 20, created_at: START }] });
    expect(await (await app.request("/v1/sessions/ses-magpie-1/tool-calls")).json()).toMatchObject([{ output_text: "native result" }]);
  });

  it("原生用户消息先于有效调用时，不被同正文 OTLP 消息吞掉", async () => {
    const span = generationSpan();
    span.attributes.push(str("langfuse.observation.input", "same prompt"));
    await post("/v1/traces", otlpPayload([span]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: "ses-magpie-1", agent: "opencode" },
      { type: "message", session_id: "ses-magpie-1", message_id: "native-user", role: "user", content: "same prompt", created_at: START }, nativeTurn(),
    ] });
    expect(await (await app.request("/v1/sessions/ses-magpie-1/messages")).json()).toMatchObject([{ id: "native-user", content: "same prompt" }]);
  });

  it.each([false, true])("精确匹配的 trace 连同辅助 tool 一起归属原生会话（nativeFirst=%s）", async (nativeFirst) => {
    const traceId = "2ca25587e1e02369d26826f863a3da4a";
    const root = generationSpan({ traceId, spanId: "root", attributes: [str("magpie.agent", "opencode"), str("langfuse.observation.type", "span")] });
    const tool = generationSpan({ traceId, spanId: "tool", attributes: [str("magpie.agent", "opencode"), str("langfuse.observation.type", "tool"), str("langfuse.observation.output", "tool result")] });
    const otlp = otlpPayload([root, tool, generationSpan({ traceId, spanId: "c7512cf75cbb9b0d", attributes: [str("magpie.agent", "opencode"), str("gen_ai.request.model", "gpt-5"), int("gen_ai.usage.input_tokens", 100)] })]);
    const native = { events: [
      { type: "session.created", session_id: "ses_runmark_identity_fixture", agent: "opencode" },
      { ...nativeTurn("ses_runmark_identity_fixture"), turn_id: "msg_assistant_1", message_id: "msg_assistant_1" },
      { type: "message", session_id: "ses_runmark_identity_fixture", message_id: "msg_user_1", role: "user", content: "hello", created_at: START },
    ] };
    if (nativeFirst) await post("/v1/ingest", native);
    if (nativeFirst) notifications = [];
    await post("/v1/traces", otlp);
    if (!nativeFirst) await post("/v1/ingest", native);
    expect(await sessions()).toHaveLength(1);
    expect(await (await app.request(`/v1/sessions/${traceId}/tool-calls`)).json()).toEqual([]);
    if (nativeFirst) expect(notifications).toEqual([]);
  });

  it.each([false, true])("会话兜底跨重启、双序、重报及 idle 后所有统计保持原生值（nativeFirst=%s）", async (nativeFirst) => {
    directory = mkdtempSync(join(tmpdir(), "runmark-dedup-"));
    const path = join(directory, "test.db");
    db.close();
    db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    mount();
    const native = { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode", title: "real title", metadata: { persisted: true } }, nativeTurn()] };
    const otlp = otlpPayload([generationSpan()]);
    await post(nativeFirst ? "/v1/ingest" : "/v1/traces", nativeFirst ? native : otlp);
    db.close();
    db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    mount();
    await post(nativeFirst ? "/v1/traces" : "/v1/ingest", nativeFirst ? otlp : native);
    await post("/v1/traces", otlp);
    await post("/v1/ingest", native);
    await post("/v1/ingest", { events: [{ type: "session.idle", session_id: "ses-magpie-1", agent: "opencode", request_count: 10, session_total_tokens: 1000, session_cost_usd: 2, session_input_tokens: 800, session_output_tokens: 200 }] });
    db.close();
    db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    mount();
    await post("/v1/traces", otlp);
    await post("/v1/ingest", native);
    expect(await turns("ses-magpie-1")).toHaveLength(1);
    expect((await sessions())[0]).toMatchObject({ title: "real title", request_count: 10, total_tokens: 1000, total_cost_usd: 2, total_input_tokens: 800, total_output_tokens: 200 });
    expect(JSON.parse((await sessions())[0].metadata)).toMatchObject({ persisted: true });
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ sessions: 1, turns: 1, tokens: { total: 25 }, cost_usd: 0.01 });
    expect(await (await app.request("/v1/stats/by-model?range=all")).json()).toMatchObject([{ turn_count: 1, total_tokens: 25, total_cost_usd: 0.01 }]);
    expect(await (await app.request("/v1/stats/by-agent?range=all")).json()).toMatchObject([{ turn_count: 1, total_tokens: 1000, total_cost_usd: 2 }]);
  });

  it("零用量占位和未确认来源的 turn 不触发切换，迟到原生身份确认后才切换", async () => {
    await post("/v1/traces", otlpPayload([generationSpan()]));
    await post("/v1/ingest", { events: [{ ...nativeTurn(), total_tokens: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }] });
    expect(await turns("ses-magpie-1")).toHaveLength(2);
    await post("/v1/ingest", { events: [nativeTurn()] });
    expect(await turns("ses-magpie-1")).toHaveLength(2);
    await post("/v1/ingest", { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }] });
    expect(await turns("ses-magpie-1")).toHaveLength(1);
    expect((await sessions())[0].total_tokens).toBe(25);
  });

  it("相同时间用量的未知网关调用保持独立，历史无来源行不按 ID 形状删除", async () => {
    // 仅用于安排升级前的数据库状态；结果均通过 HTTP 读取。
    db.query("INSERT INTO sessions (id, agent, started_at) VALUES (?, ?, ?)").run("ses-magpie-1", "opencode", START);
    db.query("INSERT INTO turns (id, session_id, model, provider, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("bbbbbbbbbbbbbbbb", "ses-magpie-1", "gpt-5", "openai", 7, START);
    await post("/v1/traces", otlpPayload([generationSpan()]));
    await post("/v1/ingest", { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }, nativeTurn()] });
    await post("/v1/traces", otlpPayload([generationSpan({ traceId: "unrelated-trace", attributes: [str("magpie.agent", "opencode"), str("gen_ai.request.model", "gpt-5"), int("gen_ai.usage.input_tokens", 20), int("gen_ai.usage.output_tokens", 5)] })]));
    expect((await turns("ses-magpie-1")).map(t => t.total_tokens).sort((a,b) => a-b)).toEqual([7, 25]);
    expect((await turns("unrelated-trace"))[0].total_tokens).toBe(25);
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ sessions: 2, turns: 3, tokens: { total: 57 } });
  });

  it("共享 OTLP 分组内的 trace 分批精确关联后，最终不留空壳会话", async () => {
    const sid = "ses_runmark_identity_fixture";
    const attrs = [str("magpie.agent", "opencode"), str("langfuse.session.id", "exporter-group"), str("gen_ai.request.model", "gpt-5"), int("gen_ai.usage.input_tokens", 100)];
    await post("/v1/traces", otlpPayload([
      generationSpan({ traceId: "2ca25587e1e02369d26826f863a3da4a", spanId: "c7512cf75cbb9b0d", attributes: attrs }),
      generationSpan({ traceId: "2b0ae52c1cd3946136d52d40f7870193", spanId: "2cb16273d587ad1f", attributes: attrs }),
    ]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: sid, agent: "opencode" },
      { ...nativeTurn(sid), turn_id: "msg_assistant_1", message_id: "msg_assistant_1" },
      { type: "message", session_id: sid, message_id: "msg_user_1", role: "user", content: "first", created_at: START },
    ] });
    expect(await turns("exporter-group")).toHaveLength(1);
    await post("/v1/ingest", { events: [
      { ...nativeTurn(sid), turn_id: "msg_assistant_3", message_id: "msg_assistant_3" },
      { type: "message", session_id: sid, message_id: "msg_user_2", role: "user", content: "second", created_at: END },
    ] });
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ sessions: 1, turns: 2, tokens: { total: 50 } });
  });

  it("缺少 trace/span 标识的无效记录不凭时间生成去重身份", async () => {
    const missingSpan = { ...generationSpan(), spanId: undefined };
    const missingTrace = { ...generationSpan(), traceId: undefined };
    await post("/v1/traces", otlpPayload([missingSpan, missingTrace]));
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ sessions: 0, turns: 0 });
  });

  it("原生错误终态仍在时，迟到 completed 重报不误触发原生优先", async () => {
    await post("/v1/traces", otlpPayload([generationSpan()]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: "ses-magpie-1", agent: "opencode" },
      { ...nativeTurn(), type: "turn.error", error: "aborted" }, nativeTurn(),
    ] });
    expect(await turns("ses-magpie-1")).toHaveLength(2);
  });

  it("纯原生 600 轮不会预生成跨消息组合阻塞 ingest", async () => {
    const events: unknown[] = [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }];
    for (let i = 0; i < 600; i++) events.push(
      { type: "message", session_id: "ses-magpie-1", message_id: `user-${i}`, role: "user", content: `prompt ${i}`, created_at: START },
      { ...nativeTurn(), turn_id: `assistant-${i}`, message_id: `assistant-${i}` },
    );
    const started = performance.now();
    const response = await post("/v1/ingest", { events });
    const elapsed = performance.now() - started;
    console.info(`600-round native ingest: ${elapsed.toFixed(1)}ms`);
    expect(response.status).toBe(200);
    expect(await (await app.request("/v1/stats/summary?range=all")).json()).toMatchObject({ turns: 600, tokens: { total: 15000 } });
    expect(elapsed).toBeLessThan(2500);
  }, 30000);

  it("HTTP 上报仅通知实际可见变更：被抑制 OTLP 与原生重报不触发后续任务", async () => {
    const native = { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode" }, nativeTurn()] };
    await post("/v1/ingest", native);
    expect(notifications.flat().map(e => e.type)).toEqual(["session.created", "turn.completed"]);
    notifications = [];
    const response = await post("/v1/traces", otlpPayload([generationSpan()]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    expect(notifications).toEqual([]);
    await post("/v1/ingest", native);
    expect(notifications).toEqual([]);
    await post("/v1/traces", otlpPayload([generationSpan(), generationSpan({ traceId: "independent", attributes: [str("gen_ai.request.model", "gpt-5"), int("gen_ai.usage.input_tokens", 2)] })]));
    expect(notifications.flat().map(e => e.session_id)).toEqual(["independent", "independent"]);
  });

  it.each([false, true])("切换时恢复原生 session 权威元数据（nativeFirst=%s）", async (nativeFirst) => {
    const native = { events: [{ type: "session.created", session_id: "ses-magpie-1", agent: "opencode", title: "real title", provider: "native-provider", parent_session_id: "parent-native", repo_url: "native-repo", hostname: "native-host", metadata: { origin: "native" } }] };
    if (nativeFirst) await post("/v1/ingest", native);
    await post("/v1/traces", otlpPayload([generationSpan()]));
    if (!nativeFirst) await post("/v1/ingest", native);
    await post("/v1/ingest", { events: [nativeTurn()] });
    await post("/v1/traces", otlpPayload([generationSpan()]));
    const session = await (await app.request("/v1/sessions/ses-magpie-1")).json() as any;
    expect(session).toMatchObject({ title: "real title", provider: "native-provider", parent_session_id: "parent-native", repo_url: "native-repo", hostname: "native-host" });
    expect(JSON.parse(session.metadata)).toMatchObject({ origin: "native" });
    notifications = [];
    await post("/v1/ingest", native);
    await post("/v1/ingest", { events: [nativeTurn()] });
    expect(notifications).toEqual([]);
  });

  it("来源未知的历史元数据保留，混合累计不冒充原生快照", async () => {
    db.query("INSERT INTO sessions (id, agent, title, provider, parent_session_id, metadata, total_tokens, total_cost_usd, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ses-magpie-1", "opencode", "legacy title", "legacy-provider", "legacy-parent", '{"legacy":"keep"}', 9000, 9, START);
    await post("/v1/traces", otlpPayload([generationSpan()]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: "ses-magpie-1", agent: "opencode", metadata: { native: "added" } }, nativeTurn(),
    ] });
    const session = await (await app.request("/v1/sessions/ses-magpie-1")).json() as any;
    expect(session).toMatchObject({ title: "legacy title", provider: "legacy-provider", parent_session_id: "legacy-parent", total_tokens: 25, total_cost_usd: 0.01 });
    expect(JSON.parse(session.metadata)).toEqual({ legacy: "keep", native: "added" });
  });

  it("原生累计先于明细到达：取快照与明细最大值，迟到小快照和 OTLP 重报不能回退或叠加", async () => {
    const span = generationSpan();
    span.attributes.push(int("gen_ai.usage.input_tokens", 10000));
    await post("/v1/traces", otlpPayload([span]));
    await post("/v1/ingest", { events: [
      { type: "session.created", session_id: "ses-magpie-1", agent: "opencode", request_count: 10, session_total_tokens: 1000, session_cost_usd: 2 }, nativeTurn(),
      { type: "session.idle", session_id: "ses-magpie-1", agent: "opencode", request_count: 1, session_total_tokens: 20, session_cost_usd: 0.001 },
    ] });
    await post("/v1/traces", otlpPayload([span]));
    expect((await sessions())[0]).toMatchObject({ request_count: 10, total_tokens: 1000, total_cost_usd: 2 });
    await post("/v1/ingest", { events: [{ ...nativeTurn(), turn_id: "native-second", total_tokens: 2000, input_tokens: 1995, cost_usd: 3 }] });
    expect((await sessions())[0]).toMatchObject({ request_count: 10, total_tokens: 2025, total_cost_usd: 3.01 });
  });

  it("把 OTLP generation span 落库成会话与模型调用", async () => {
    const res = await post("/v1/traces", otlpPayload([generationSpan()]));
    expect(res.status).toBe(200);

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "ses-magpie-1",
      agent: "opencode",
      title: "opencode interaction",
      models: ["gpt-5"],
    });

    const turnRows = await turns("ses-magpie-1");
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]).toMatchObject({
      model: "gpt-5",
      provider: "openai",
      input_tokens: 100,
      output_tokens: 30,
      total_tokens: 130,
      duration_ms: 1500,
      created_at: START,
    });
  });

  it("把包含 cache 的 input_tokens 换算成非缓存输入，不重复计数", async () => {
    // magpie 的 gen_ai.usage.input_tokens = Input + CacheRead + CacheWrite，
    // 而 Runmark 的 input_tokens 是非缓存输入，必须先减掉 cache 两项
    const span = generationSpan({
      attributes: [
        str("gen_ai.provider.name", "anthropic"),
        str("gen_ai.request.model", "claude-sonnet-4-20250514"),
        str("magpie.agent", "claude"),
        str("langfuse.session.id", "ses-cache"),
        int("gen_ai.usage.input_tokens", 1600),
        int("gen_ai.usage.output_tokens", 200),
        int("gen_ai.usage.cache_read.input_tokens", 1000),
        int("gen_ai.usage.cache_creation.input_tokens", 500),
        int("gen_ai.usage.reasoning.output_tokens", 40),
      ],
    });

    await post("/v1/traces", otlpPayload([span]));

    const [turn] = await turns("ses-cache");
    expect(turn).toMatchObject({
      input_tokens: 100,
      cache_read_tokens: 1000,
      cache_write_tokens: 500,
      output_tokens: 160,
      reasoning_tokens: 40,
      total_tokens: 1800,
      cost_usd: 0.005475,
    });
  });

  it("分层 span 只把 generation 落成 turn，root 与 tool 不产生空 turn", async () => {
    // magpie 开 Sessions 后一次交互 = agent root + generation + tool
    const root = {
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      name: "opencode interaction",
      kind: 1,
      startTimeUnixNano: ns("2026-10-20T07:59:59.000Z"),
      endTimeUnixNano: ns(END),
      attributes: [
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-layered"),
        str("langfuse.trace.name", "opencode interaction"),
        str("langfuse.observation.type", "span"),
      ],
      status: { code: 0 },
    };
    const tool = {
      traceId: "c".repeat(32),
      spanId: "e".repeat(16),
      parentSpanId: "d".repeat(16),
      name: "read",
      kind: 1,
      startTimeUnixNano: ns("2026-10-20T08:00:00.200Z"),
      endTimeUnixNano: ns("2026-10-20T08:00:00.400Z"),
      attributes: [
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-layered"),
        str("langfuse.trace.name", "opencode interaction"),
        str("langfuse.observation.type", "tool"),
      ],
      status: { code: 0 },
    };
    const generation = generationSpan({
      traceId: "c".repeat(32),
      spanId: "f".repeat(16),
      parentSpanId: "d".repeat(16),
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-layered"),
        str("langfuse.trace.name", "opencode interaction"),
        str("langfuse.observation.type", "generation"),
        int("gen_ai.usage.input_tokens", 50),
        int("gen_ai.usage.output_tokens", 10),
      ],
    });

    await post("/v1/traces", otlpPayload([root, generation, tool]));

    const turnRows = await turns("ses-layered");
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]).toMatchObject({ model: "gpt-5", total_tokens: 60 });

    const [session] = await sessions();
    expect(session).toMatchObject({ agent: "opencode", models: ["gpt-5"] });
  });

  it("同一个 span 重投不重复累加 token 与费用", async () => {
    const payload = otlpPayload([generationSpan({ attributes: [
      str("gen_ai.provider.name", "openai"),
      str("gen_ai.request.model", "gpt-5"),
      str("magpie.agent", "opencode"),
      str("langfuse.session.id", "ses-retry"),
      int("gen_ai.usage.input_tokens", 100),
      int("gen_ai.usage.output_tokens", 30),
    ] })]);

    // exporter 超时重试会原样再发一次
    await post("/v1/traces", payload);
    await post("/v1/traces", payload);

    const turnRows = await turns("ses-retry");
    expect(turnRows).toHaveLength(1);

    const [session] = await sessions();
    expect(session).toMatchObject({
      request_count: 1,
      total_tokens: 130,
      models: ["gpt-5"],
    });
  });

  it("不同 trace 的同名 span 独立计数，修订不串会话", async () => {
    const first = generationSpan();
    const second = generationSpan({ traceId: "7".repeat(32), attributes: [
      str("langfuse.session.id", "ses-other"), str("gen_ai.request.model", "gpt-5"),
      int("gen_ai.usage.input_tokens", 200), int("gen_ai.usage.output_tokens", 40),
    ] });
    await post("/v1/traces", otlpPayload([first, second]));
    expect((await turns("ses-magpie-1"))[0].total_tokens).toBe(130);
    expect((await turns("ses-other"))[0].total_tokens).toBe(240);
    expect((await sessions()).map(s => s.total_tokens).sort((a,b) => a-b)).toEqual([130, 240]);
  });

  it("失败的 span 落成 turn.error，保留错误类型", async () => {
    const span = generationSpan({
      status: 2,
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "codex"),
        str("langfuse.session.id", "ses-fail"),
        str("langfuse.observation.type", "generation"),
        str("error.type", "429"),
        int("gen_ai.usage.input_tokens", 0),
        int("gen_ai.usage.output_tokens", 0),
      ],
    });

    await post("/v1/traces", otlpPayload([span]));

    const [turn] = await turns("ses-fail");
    expect(turn).toMatchObject({ model: "gpt-5", provider: "openai", error: "429", total_tokens: 0 });

    const [session] = await sessions();
    expect(session.agent).toBe("codex");
    // 失败调用不该被算成一次成功请求的费用
    expect(session.total_cost_usd).toBe(0);
  });

  it("优先使用上报的 cost_details.total，缺失时按定价表估算", async () => {
    const reported = (sessionId: string, cost?: number) =>
      generationSpan({
        spanId: `1${sessionId.slice(-1).repeat(15)}`,
        attributes: [
          str("gen_ai.provider.name", "openai"),
          str("gen_ai.request.model", "gpt-5"),
          str("magpie.agent", "opencode"),
          str("langfuse.session.id", sessionId),
          str("langfuse.observation.type", "generation"),
          int("gen_ai.usage.input_tokens", 1_000_000),
          int("gen_ai.usage.output_tokens", 0),
          ...(cost != null
            ? [str("langfuse.observation.cost_details", JSON.stringify({ input: cost, output: 0, total: cost }))]
            : []),
        ],
      });

    await post("/v1/traces", otlpPayload([reported("ses-cost-a", 0.42)]));
    await post("/v1/traces", otlpPayload([reported("ses-cost-b")]));

    const [a] = await turns("ses-cost-a");
    const [b] = await turns("ses-cost-b");
    expect(a.cost_usd).toBe(0.42);
    // gpt-5 input $2 / 1M
    expect(b.cost_usd).toBeGreaterThan(0);
    expect(b.cost_usd).not.toBe(0.42);
  });

  it("span 的 input/output 正文落成 user 与 assistant 消息", async () => {
    const span = generationSpan({
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-body"),
        str("langfuse.observation.type", "generation"),
        str("langfuse.observation.input", "重构 otlp 路由"),
        str("langfuse.observation.output", "已新增 /v1/traces"),
        int("gen_ai.usage.input_tokens", 10),
        int("gen_ai.usage.output_tokens", 5),
      ],
    });

    await post("/v1/traces", otlpPayload([span]));

    const res = await app.request("/v1/sessions/ses-body/messages");
    const messages = (await res.json()) as any[];
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "重构 otlp 路由"],
      ["assistant", "已新增 /v1/traces"],
    ]);
  });

  it("没有正文时只落元数据，不造空消息", async () => {
    await post("/v1/traces", otlpPayload([generationSpan({
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-nobody"),
        int("gen_ai.usage.input_tokens", 10),
        int("gen_ai.usage.output_tokens", 5),
      ],
    })]));

    const res = await app.request("/v1/sessions/ses-nobody/messages");
    expect(await res.json()).toEqual([]);
  });

  it("没有 magpie.agent 的通用 exporter 用 service.name 识别 agent", async () => {
    // openllmetry / opentelemetry-js 之类只发标准 semconv
    const span = generationSpan({
      attributes: [
        str("gen_ai.system", "anthropic"),
        str("gen_ai.request.model", "claude-sonnet-4-20250514"),
        str("langfuse.session.id", "ses-generic"),
        int("gen_ai.usage.input_tokens", 20),
        int("gen_ai.usage.output_tokens", 8),
      ],
    });

    await post("/v1/traces", otlpPayload([span], "codex"));

    const [session] = await sessions();
    expect(session).toMatchObject({
      id: "ses-generic",
      agent: "codex",
      models: ["claude-sonnet-4-20250514"],
    });
    const [turn] = await turns("ses-generic");
    expect(turn).toMatchObject({ provider: "anthropic", total_tokens: 28 });
  });
  it("没有 session 标识但有 traceId 时按 trace 归并成一个会话", async () => {
    const first = generationSpan({
      traceId: "9".repeat(32),
      spanId: "1".repeat(16),
      end: "2026-10-20T08:00:01.000Z",
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        int("gen_ai.usage.input_tokens", 10),
        int("gen_ai.usage.output_tokens", 2),
      ],
    });
    const second = generationSpan({
      traceId: "9".repeat(32),
      spanId: "2".repeat(16),
      start: "2026-10-20T08:00:02.000Z",
      end: "2026-10-20T08:00:03.000Z",
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        int("gen_ai.usage.input_tokens", 20),
        int("gen_ai.usage.output_tokens", 4),
      ],
    });

    await post("/v1/traces", otlpPayload([first, second]));

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("9".repeat(32));
    expect(rows[0].models).toEqual(["gpt-5"]);

    const turnRows = await turns("9".repeat(32));
    expect(turnRows.map((t) => t.total_tokens)).toEqual([12, 24]);
  });

  it("同一 span 的修订版（magpie Update）覆盖旧 token，而不是丢弃", async () => {
    // magpie 流式期间先发一次未完成的 span，结束后用同一 spanId 重发修订版
    const revised = (input: number, output: number) =>
      generationSpan({
        spanId: "5".repeat(16),
        attributes: [
          str("gen_ai.provider.name", "openai"),
          str("gen_ai.request.model", "gpt-5"),
          str("magpie.agent", "opencode"),
          str("langfuse.session.id", "ses-revise"),
          str("langfuse.observation.type", "generation"),
          int("gen_ai.usage.input_tokens", input),
          int("gen_ai.usage.output_tokens", output),
        ],
      });

    await post("/v1/traces", otlpPayload([revised(10, 3)]));
    await post("/v1/traces", otlpPayload([revised(100, 40)]));

    const turnRows = await turns("ses-revise");
    expect(turnRows).toHaveLength(1);
    expect(turnRows[0]).toMatchObject({ input_tokens: 100, output_tokens: 40, total_tokens: 140 });

    // 会话累计必须是修订后的值，不是两份相加
    const [session] = await sessions();
    expect(session).toMatchObject({ request_count: 1, total_tokens: 140 });
  });

  it("修订版 token 变小时不把已有数据改小", async () => {
    const revised = (input: number, output: number) =>
      generationSpan({
        spanId: "6".repeat(16),
        attributes: [
          str("gen_ai.provider.name", "openai"),
          str("gen_ai.request.model", "gpt-5"),
          str("magpie.agent", "opencode"),
          str("langfuse.session.id", "ses-shrink"),
          str("langfuse.observation.type", "generation"),
          int("gen_ai.usage.input_tokens", input),
          int("gen_ai.usage.output_tokens", output),
        ],
      });

    await post("/v1/traces", otlpPayload([revised(100, 40)]));
    await post("/v1/traces", otlpPayload([revised(10, 3)]));

    const [turn] = await turns("ses-shrink");
    expect(turn.total_tokens).toBe(140);

    const [session] = await sessions();
    expect(session.total_tokens).toBe(140);
  });

  it("空负载或无关 span 不产生任何数据", async () => {
    expect((await post("/v1/traces", {})).status).toBe(200);
    expect((await post("/v1/traces", { resourceSpans: [] })).status).toBe(200);
    expect(
      (await post("/v1/traces", otlpPayload([{ spanId: "x", traceId: "y", attributes: [] }]))).status,
    ).toBe(200);

    expect(await sessions()).toEqual([]);
  });

  it("props 数组里非字符串的数值属性能被读取", async () => {
    // 部分 exporter（opentelemetry-js）会把 intValue 写成数字而非字符串
    const span = generationSpan({
      attributes: [
        str("gen_ai.provider.name", "openai"),
        str("gen_ai.request.model", "gpt-5"),
        str("magpie.agent", "opencode"),
        str("langfuse.session.id", "ses-numberic"),
        str("langfuse.observation.type", "generation"),
        { key: "gen_ai.usage.input_tokens", value: { intValue: 77 } },
        { key: "gen_ai.usage.output_tokens", value: { doubleValue: 23 } },
      ] as any,
    });

    await post("/v1/traces", otlpPayload([span]));

    const [turn] = await turns("ses-numberic");
    expect(turn.total_tokens).toBe(100);
  });
});
