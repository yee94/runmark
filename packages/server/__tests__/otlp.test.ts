import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { createOtlpRoute } from "../src/routes/otlp";
import { createSessionsRoute, createTurnsRoute } from "../src/routes/sessions";
import { ingestService } from "../src/services/ingest";

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

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);

    app = new Hono();
    app.route("/", createOtlpRoute(db));
    app.route("/", createSessionsRoute(db));
    app.route("/", createTurnsRoute(db));
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const sessions = async () => (await (await app.request("/v1/sessions")).json()) as any[];
  const turns = async (id: string) =>
    (await (await app.request(`/v1/sessions/${id}/turns`)).json()) as any[];

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
      output_tokens: 200,
      reasoning_tokens: 40,
      total_tokens: 1840,
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
