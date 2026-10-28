import type { IngestEvent, IngestSessionEvent, IngestTurnEvent } from "@agent-tracker/shared";

/**
 * OTLP/HTTP（JSON）接入：把 OpenTelemetry span 摊平成既有 IngestEvent。
 *
 * 只做协议翻译，落库、计价、统计全部复用现有 ingestService。
 * 属性名对齐 OTel GenAI semconv，并兼容 magpie / Langfuse 的扩展属性。
 */

type AnyRecord = Record<string, any>;

/** OTLP 属性数组 → 普通对象（stringValue / intValue / doubleValue / boolValue） */
function attributesOf(list: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const attr = raw as AnyRecord;
    const key = typeof attr?.key === "string" ? attr.key : "";
    if (!key) continue;
    const value = (attr.value ?? {}) as AnyRecord;
    if (value.stringValue != null) out[key] = String(value.stringValue);
    else if (value.intValue != null) out[key] = Number(value.intValue);
    else if (value.doubleValue != null) out[key] = Number(value.doubleValue);
    else if (value.boolValue != null) out[key] = Boolean(value.boolValue);
  }
  return out;
}

/** 纳秒时间戳字符串 → ISO；缺省 / 非法返回 undefined */
function isoFromNanos(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return undefined;
  const ms = Number(BigInt(text) / 1_000_000n);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function firstString(...values: unknown[]): string | undefined {
  for (const raw of values) {
    const text = String(raw ?? "").trim();
    if (text) return text;
  }
  return undefined;
}

/** 摊平所有 span，保留所属 resource 的 service.name 以便兜底推断 agent */
function collectSpans(payload: unknown): Array<{ span: AnyRecord; serviceName?: string }> {
  const collected: Array<{ span: AnyRecord; serviceName?: string }> = [];
  const resourceSpans = (payload as AnyRecord)?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return collected;
  for (const resourceSpan of resourceSpans) {
    const resource = attributesOf((resourceSpan as AnyRecord)?.resource?.attributes);
    const serviceName = firstString(resource["service.name"]);
    const scopeSpans = (resourceSpan as AnyRecord)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scopeSpan of scopeSpans) {
      const spans = (scopeSpan as AnyRecord)?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        if (span && typeof span === "object") collected.push({ span: span as AnyRecord, serviceName });
      }
    }
  }
  return collected;
}

/** magpie / Langfuse 的 cost_details 是 JSON 字符串：{"input":…,"output":…,"total":…} */
function reportedCost(value: unknown): number | undefined {
  const text = firstString(value);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as AnyRecord;
    const total = Number(parsed.total);
    if (Number.isFinite(total) && total > 0) return total;
  } catch {
    // 非 JSON 或结构不符时退回服务端定价估算
  }
  return undefined;
}

/** 是否是模型调用 span：Langfuse 显式标注，或带 GenAI 用量/模型属性 */
function isGenerationSpan(attrs: Record<string, string | number | boolean>): boolean {
  const type = firstString(attrs["langfuse.observation.type"])?.toLowerCase();
  if (type) return type === "generation";
  return (
    attrs["gen_ai.usage.input_tokens"] != null ||
    attrs["gen_ai.usage.output_tokens"] != null ||
    attrs["gen_ai.request.model"] != null
  );
}

/** OTLP 请求体 → IngestEvent[]；无法识别的 span 忽略 */
export function spansToIngestEvents(payload: unknown): IngestEvent[] {
  const events: IngestEvent[] = [];
  for (const { span, serviceName } of collectSpans(payload)) {
    const attrs = attributesOf(span.attributes);
    const sessionId = firstString(attrs["langfuse.session.id"], span.traceId);
    if (!sessionId) continue;

    const model = firstString(attrs["gen_ai.request.model"]);
    const provider = firstString(attrs["gen_ai.provider.name"], attrs["gen_ai.system"]);
    const createdAt = isoFromNanos(span.startTimeUnixNano) ?? new Date().toISOString();
    const startedAtMs = isoFromNanos(span.startTimeUnixNano);
    const endedAtMs = isoFromNanos(span.endTimeUnixNano);
    const durationMs =
      startedAtMs && endedAtMs ? Math.max(0, new Date(endedAtMs).getTime() - new Date(startedAtMs).getTime()) : 0;

    const sessionEvent: IngestSessionEvent = {
      type: "session.created",
      session_id: sessionId,
      agent: firstString(attrs["magpie.agent"], serviceName) ?? "unknown",
      title: firstString(attrs["langfuse.trace.name"]),
      provider,
      model,
    };
    events.push(sessionEvent);

    // 正文：magpie 的 MAGPIE_OTEL_BODIES=true 才发，缺省只有元数据
    const spanId = String(span.spanId ?? `${sessionId}-${createdAt}`);
    const promptText = firstString(attrs["langfuse.observation.input"]);
    if (promptText) {
      events.push({
        type: "message",
        session_id: sessionId,
        message_id: `${spanId}-input`,
        role: "user",
        content: promptText,
        model,
        provider,
        created_at: createdAt,
      });
    }
    const replyText = firstString(attrs["langfuse.observation.output"]);
    if (replyText) {
      events.push({
        type: "message",
        session_id: sessionId,
        message_id: `${spanId}-output`,
        role: "assistant",
        content: replyText,
        model,
        provider,
        created_at: isoFromNanos(span.endTimeUnixNano) ?? createdAt,
      });
    }

    // 只有模型调用 span 才是 turn（token/费用单元）；agent root 与 tool span 只用于建会话
    if (!isGenerationSpan(attrs)) continue;

    const input = Number(attrs["gen_ai.usage.input_tokens"] ?? 0);
    const output = Number(attrs["gen_ai.usage.output_tokens"] ?? 0);
    const cacheRead = Number(attrs["gen_ai.usage.cache_read.input_tokens"] ?? 0);
    const cacheWrite = Number(attrs["gen_ai.usage.cache_creation.input_tokens"] ?? 0);
    const reasoning = Number(attrs["gen_ai.usage.reasoning.output_tokens"] ?? 0);
    // OTel GenAI semconv / magpie 的 input_tokens 是「含缓存」的提示词总量
    // （otel_wire.go: r.Input+r.CacheRead+r.CacheWrite），Runmark 的 input_tokens
    // 是非缓存输入，必须扣掉两项缓存，否则输入侧翻倍计价
    const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);

    const errorType = firstString(attrs["error.type"]);
    const statusCode = Number((span.status as AnyRecord)?.code ?? 0);
    const failed = Boolean(errorType) || statusCode === 2;

    const turnEvent: IngestTurnEvent = {
      type: failed ? "turn.error" : "turn.completed",
      session_id: sessionId,
      turn_id: String(span.spanId ?? `${sessionId}-${createdAt}`),
      model: model ?? "unknown",
      provider: provider ?? "unknown",
      input_tokens: uncachedInput,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: reasoning,
      total_tokens: uncachedInput + output + cacheRead + cacheWrite + reasoning,
      duration_ms: durationMs,
      cost_usd: reportedCost(attrs["langfuse.observation.cost_details"]),
      error: failed ? (errorType ?? "otlp span error") : undefined,
      created_at: createdAt,
    };
    events.push(turnEvent);
  }
  return events;
}

export const otlpService = { spansToIngestEvents };
