# OTLP 接入

Runmark 提供 OTLP/HTTP 接收端点，任意 OpenTelemetry exporter（magpie、OpenTelemetry Collector、Langfuse SDK 等）把 endpoint 指向本服务即可上报。接入层只做协议翻译：span 摊平成既有 IngestEvent，落库、计价、统计、Dashboard 全部复用现有逻辑，行为与插件上报一致。

## 端点与鉴权

| 方法 | 路径 | 行为 |
|------|------|------|
| POST | `/v1/traces` | 解析 span，落成 session / message / turn |
| POST | `/v1/metrics` | 接收后返回 200 并丢弃，不落库 |

- 编码：只支持 OTLP/HTTP 的 **JSON**（`Content-Type: application/json`），不支持 protobuf 编码。
- 鉴权：与 ingest 同一个 API Key，支持 `X-API-Key: <key>` 或 `Authorization: Bearer <key>`。缺失或错误返回 401。
- 响应：正常路径始终 HTTP 200 + `{"partialSuccess": {}}`，符合 OTLP 规范。exporter 见到 4xx/5xx 会反复重投，因此只有请求体完全不是对象时才返回 400，空 `resourceSpans` 返回 200 且不产生数据。

## 属性映射

属性名对齐 OTel GenAI semconv，并兼容 magpie / Langfuse 的扩展属性。

| OTLP 属性 | Runmark 字段 | 说明 |
|---|---|---|
| `magpie.agent`，缺失时回落 resource 的 `service.name` | `sessions.agent` | 都缺失时为 `unknown` |
| `langfuse.session.id`，缺失时回落 `span.traceId` | session 分组键 | magpie 的 gateway trace 没有 session.id，会按 traceId 归并 |
| `langfuse.trace.name` | `sessions.title` | |
| `gen_ai.request.model` | `turns.model` | |
| `gen_ai.provider.name`（兼容旧 `gen_ai.system`） | `turns.provider` | |
| `gen_ai.usage.input_tokens` | `turns.input_tokens` | 需减去两项 cache，见下文 |
| `gen_ai.usage.cache_read.input_tokens` | `cache_read_tokens` | |
| `gen_ai.usage.cache_creation.input_tokens` | `cache_write_tokens` | |
| `gen_ai.usage.output_tokens` | `output_tokens` | |
| `gen_ai.usage.reasoning.output_tokens` | `reasoning_tokens` | |
| span start / end 纳秒时间 | `created_at` / `duration_ms` | |
| `error.type` 或 `status.code == 2` | `turns.error` | 落成 `turn.error` |
| `langfuse.observation.cost_details` 的 `total` | `turns.cost_usd` | 缺失时按服务端定价表估算 |
| `langfuse.observation.input` / `.output` | user / assistant 消息 | 需 exporter 开启正文，默认不发 |

## 关键设计

### token 换算：input 要扣掉缓存

OTel GenAI semconv 与 magpie 的 `gen_ai.usage.input_tokens` 是**含缓存**的提示词总量（magpie 源码 `internal/otlp/otel_wire.go:86` 写入的是 `r.Input + r.CacheRead + r.CacheWrite`），而 Runmark 的 `input_tokens` 定义为非缓存输入。解析时会做：

```text
uncached_input = max(0, gen_ai.usage.input_tokens - cache_read - cache_creation)
```

不扣减会让输入侧翻倍计价：缓存 token 既算进 `input_tokens` 又单独算一次 `cache_read_tokens` / `cache_write_tokens`。

### 只把 generation span 落成 turn

magpie 开启 Sessions 后，一次交互会发出 agent root span + 若干 tool span + generation span 的分层结构，只有 generation span 带 `gen_ai.usage.*` 与模型名。实现里按 `langfuse.observation.type == "generation"` 判断，属性缺失时回落看 span 是否带 `gen_ai.usage.*` 或 `gen_ai.request.model`。

root span 与 tool span 只用于建立会话（`sessions.agent` / `title` / 分组键），不产生 turn。否则每次交互会多出一堆 0-token 空 turn，污染会话数与模型统计。

### 同一 spanId 的修订版会覆盖

magpie 流式期间先发未完成的 span，结束后用**同一个 spanId** 重发修订版（magpie 源码 `internal/sessions/traces_snapshot.go:41-52` 的 `Update` 逻辑）。`turn_id` 直接取 `span.spanId`，因此修订版命中同一行。

ingest 层对已存在的 turn 按差值校正 token / cost，且仅在新 `total_tokens` 更大时执行：

- 重复上报同值 → 空操作
- 修订版 token 变大 → `turns` 更新为新值，session 累计只加差值
- 修订版 token 更小或为 0 → 忽略，不会把已有数据改小，也不会把会话累计扣成负数

## magpie 配置示例

magpie 通过环境变量开启 OTLP 上报。把 endpoint 指向 Runmark 服务的根地址，路径由 exporter 自行拼接（`/v1/traces`、`/v1/metrics`）。

```bash
export MAGPIE_OTEL_ENABLED=true
export MAGPIE_OTEL_ENDPOINT=http://localhost:3456
export MAGPIE_OTEL_HEADERS='X-API-Key=dev-key-change-me'
export MAGPIE_OTEL_SESSIONS=true
export MAGPIE_OTEL_BODIES=true
```

| 变量 | 作用 |
|------|------|
| `MAGPIE_OTEL_ENABLED` | 开启 OTLP 上报 |
| `MAGPIE_OTEL_ENDPOINT` | Runmark 地址（不要带 `/v1/traces`） |
| `MAGPIE_OTEL_HEADERS` | 认证头，**值需要 percent-encode** |
| `MAGPIE_OTEL_SESSIONS` | 上报分层 Sessions span（root / tool / generation） |
| `MAGPIE_OTEL_BODIES` | 上报 prompt 与回复正文；不开启只有元数据遥测 |

`MAGPIE_OTEL_HEADERS` 使用字面量 `=` 分隔头名和值，多个 header 使用字面量逗号分隔。仅值中的特殊字符需要 percent-encode，例如同时带 key 与自定义头：

```text
MAGPIE_OTEL_HEADERS='X-API-Key=dev-key-change-me,X-Env=local'
```

用 Bearer 写法时：

```text
MAGPIE_OTEL_HEADERS='Authorization=Bearer%20dev-key-change-me'
```

`MAGPIE_OTEL_SESSIONS=true` 才能拿到 generation / tool span 的分层结构与 `magpie.agent`，建议常开。正文包含用户代码与模型输出，按需开启。

## curl 验证

最小 span：一个 generation span 同时带 session、模型与 token。

```bash
NOW=$(date +%s)000000000
END=$((NOW + 1000000000))

curl -sS http://localhost:3456/v1/traces \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-key-change-me' \
  -d "{
    \"resourceSpans\": [{
      \"resource\": {\"attributes\": [{\"key\": \"service.name\", \"value\": {\"stringValue\": \"magpie\"}}]},
      \"scopeSpans\": [{
        \"spans\": [{
          \"traceId\": \"77777777777777777777777777777777\",
          \"spanId\": \"8888888888888888\",
          \"name\": \"chat gpt-5\",
          \"startTimeUnixNano\": \"${NOW}\",
          \"endTimeUnixNano\": \"${END}\",
          \"attributes\": [
            {\"key\": \"magpie.agent\", \"value\": {\"stringValue\": \"opencode\"}},
            {\"key\": \"langfuse.session.id\", \"value\": {\"stringValue\": \"ses-otlp-demo\"}},
            {\"key\": \"langfuse.observation.type\", \"value\": {\"stringValue\": \"generation\"}},
            {\"key\": \"gen_ai.request.model\", \"value\": {\"stringValue\": \"gpt-5\"}},
            {\"key\": \"gen_ai.provider.name\", \"value\": {\"stringValue\": \"openai\"}},
            {\"key\": \"gen_ai.usage.input_tokens\", \"value\": {\"intValue\": \"1000\"}},
            {\"key\": \"gen_ai.usage.cache_read.input_tokens\", \"value\": {\"intValue\": \"800\"}},
            {\"key\": \"gen_ai.usage.output_tokens\", \"value\": {\"intValue\": \"200\"}}
          ],
          \"status\": {\"code\": 0}
        }]
      }]
    }]
  }"
```

预期返回：

```json
{"partialSuccess":{}}
```

本例 `input_tokens` 上报 1000、cache_read 800，落库后 `turns.input_tokens` 为 200。核对：

```bash
curl -sS 'http://localhost:3456/v1/sessions/ses-otlp-demo/turns' -H 'X-API-Key: dev-key-change-me'
```

metrics 端点只验证可达性：

```bash
curl -sS -X POST http://localhost:3456/v1/metrics \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-key-change-me' \
  -d '{"resourceMetrics": []}'
```

## 已知限制

- `/v1/metrics` 只返回 200，不落库，metrics 数据不会出现在 Dashboard。
- 只支持 OTLP/HTTP 的 JSON 编码，不支持 protobuf；exporter 需显式配置为 JSON（collector 用 `encoding: json`）。
- 不开 `MAGPIE_OTEL_BODIES` 时只有元数据遥测，没有对话内容。
- `magpie.agent` 是 magpie 私有扩展属性，标准 OTel GenAI semconv 没有 agent 概念。换用 openllmetry / Langtrace / opentelemetry-js 等通用 exporter 时，只能靠 resource 的 `service.name` 推断 agent 名，需要用户把 `service.name` 配成 `opencode` / `codex` 这类值。模型识别是标准的，没有此问题。
