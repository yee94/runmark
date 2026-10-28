# OTLP 接入（magpie 等）

Runmark 支持 OpenTelemetry（OTLP/HTTP）上报。已有 OTLP 导出能力的工具（如 magpie）把上报地址指向本服务即可接入，**不需要安装任何插件**。

接入后可在 Dashboard 查看会话、Agent、模型与用量；可显示的内容取决于工具实际上报的数据。

## 填写地址

按使用的工具填写对应地址：

| 工具 | 填写内容 |
|------|----------|
| magpie | 服务地址填 `{{ENDPOINT}}` |
| 其它 OTLP/HTTP 工具 | Traces 地址填 `{{ENDPOINT}}/v1/traces` |

鉴权使用与客户端插件相同的 API Key：

```text
X-API-Key: {{API_KEY}}
```

也支持写成 `Authorization: Bearer {{API_KEY}}`。

注意：本服务只接受 OTLP/HTTP 的 **JSON** 编码。若工具提供编码选项，请选择 JSON，不要选 protobuf。

## 配置 magpie

打开 Settings → Observability，Collector 选择 **OTLP**：

| 界面项 | 填写内容 |
|--------|----------|
| OTLP export | 选 **On** |
| OTLP endpoint | `{{ENDPOINT}}` |
| OTLP headers | `X-API-Key={{API_KEY}}` |
| Trace agent conversations | 建议选 **On**，采集本机各客户端的会话 |
| Request and response content | 默认 **Metadata only**；需要正文时再选后两项 |

关于 OTLP headers：这一栏用逗号分隔多个 `name=value`，值里的特殊字符需要转义（`=` 写成 `%3D`，空格写成 `%20`）。若 Key 中含有这类字符，请照此转义后再填。

保存后立即生效，无需重启。

只开 OTLP export 时，只会记录经 magpie 网关发出的请求；打开 Trace agent conversations 才能看到本地每个会话的完整记录。正文默认为 Metadata only，此时只上报模型、token、状态与耗时，提示词与回复不会离开本机。

### 环境变量

用 `magpie serve` 启动时，改用环境变量配置，写法与界面项一一对应：

```bash
MAGPIE_OTEL_ENABLED=true \
MAGPIE_OTEL_ENDPOINT="{{ENDPOINT}}" \
MAGPIE_OTEL_HEADERS='X-API-Key={{API_KEY}}' \
MAGPIE_OTEL_SESSIONS=true \
magpie serve
```

| 变量 | 对应界面项 |
|------|-----------|
| `MAGPIE_OTEL_ENABLED` | OTLP export，必须为 `true` |
| `MAGPIE_OTEL_ENDPOINT` | OTLP endpoint，填 `{{ENDPOINT}}` |
| `MAGPIE_OTEL_HEADERS` | OTLP headers，值需转义 |
| `MAGPIE_OTEL_SESSIONS` | Trace agent conversations |
| `MAGPIE_OTEL_BODIES` | Request and response content，设为 `true` 才上报正文 |

只配 `MAGPIE_OTEL_ENDPOINT` 不会开启导出，必须同时设置 `MAGPIE_OTEL_ENABLED=true`。

## 其它 OTLP 工具

除 magpie 外，任何支持 OTLP/HTTP 导出的工具都可以接入，填这三项：

| 项目 | 填写内容 |
|------|----------|
| Traces 地址 | `{{ENDPOINT}}/v1/traces` |
| API Key | `{{API_KEY}}` |
| 编码 | 选 JSON（不支持 protobuf） |

Metrics 地址是 `{{ENDPOINT}}/v1/metrics`，当前不展示指标数据，可以不开启。

Dashboard 会按工具上报的 Agent 名称归类会话。如果工具要求填写服务名，请填 `opencode`、`codex`、`claude` 这类名称；留空或填错时会话的 Agent 会显示为 `unknown`，但不影响 token 与费用统计。

## 确认是否接入成功

先确认服务可访问，返回 `{"status":"ok"...}` 即为正常：

```bash
curl {{HEALTH_URL}}
```

配置保存后（magpie 立即生效），在 Dashboard 的会话页刷新即可看到新上报的会话。magpie 场景可按 Agent 名称筛选。

## 同时使用 OpenCode 插件与 magpie

可以同时开启两种上报。Runmark 能确认它们属于同一个 OpenCode 会话时，在收到插件上报的有效模型调用后，会优先展示和统计插件数据，避免 token、费用、对话和工具记录出现两份。只有会话创建通知时，仍展示 magpie 已采集的内容。

建议在 magpie 中打开 **Trace agent conversations**，让会话能够关联。仅经网关转发、无法关联到原生会话的请求会独立展示，不会仅因时间或用量相近就合并。

切换为插件数据后，该会话不会再用 magpie 数据补齐插件未采到的调用。此行为适用于新采集的数据，升级前的重复记录不会自动清理。

## 常见问题

- **返回 401**：检查 API Key 是否与 Dashboard 显示的一致。Header 格式为 `X-API-Key=你的Key`，分隔头名和值的等号不能写成 `%3D`。
- **Dashboard 没有数据**：确认 OTLP export 已选 **On**（或设置 `MAGPIE_OTEL_ENABLED=true`）。只填地址不会开启导出。
- **有会话但没有 token**：magpie 需要打开 Trace agent conversations（`MAGPIE_OTEL_SESSIONS=true`），并确认本地会话目录可读。
- **模型显示 unknown**：上报数据里没有模型名称，请升级到支持上报模型的版本。
- **费用为 0**：模型不在服务端定价表内，且工具未上报费用。可在定价页补充该模型价格。
- **看不到对话内容**：默认只上报用量与模型等元数据，需要在工具侧单独开启正文上报。
