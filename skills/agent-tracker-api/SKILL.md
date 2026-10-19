---
name: agent-tracker-api
description: >-
  通过 curl 查询 Runmark API，拉取 Cursor / OpenCode / Codex / Grok 等会话上下文、时间段统计、
  Cursor 账单同步状态、智能体调用记录与事项归档，以及公开 Session Share（免登录 credential）摘要与
  按需 messages/turns/tool-calls，供后续 Agent 分析。触发词：agent tracker api、遥测分析、
  查 session、curl 拉会话、token 统计、历史用量、agent-runs、matters、cursor sync、session share、
  公开分享。
---

# Runmark API — 查询与分析 Skill

本 Skill 用于通过 HTTP API 拉取 Runmark 数据，供 Agent 做用量审计、会话复盘、失败排查、事项归档检查和智能体运行分析。

完整 OpenAPI 定义见同目录 [`openapi.yaml`](openapi.yaml)。如果 OpenAPI 与源码有差异，以 `packages/server/src/routes/*.ts` 为准。

## 0. 快速启动（静默加载鉴权）

**Agent 执行任何查询前，先 source 封装脚本——鉴权自动从 `~/.config/agent-tracker/env` 加载，无需手动 export。**

```bash
source skills/agent-tracker-api/runmark-api.sh
```

之后所有 `runmark_get` / `runmark_post` / `runmark_put` / `runmark_delete` 自动带上 API Key。不要手动设置 `AGENT_TRACKER_API_KEY` 或 `AGENT_TRACKER_ENDPOINT` 环境变量，封装已处理。

```bash
# 示例：一键查询
runmark_health                              # 健康检查
runmark_get /v1/sessions?limit=10 | jq .   # 最近 10 个会话
runmark_get /v1/stats/summary?range=7d     # 7 天统计
runmark_get /v1/matters | jq .             # 事项归档列表
```

输出默认走 `jq` 格式化，单条命令直接可读。

### 备选：原始 curl（展示完整认证逻辑）

如无法用封装脚本，curl 需要显式传递 Header：

```bash
ENV_FILE="$HOME/.config/agent-tracker/env"
[[ -f "$ENV_FILE" ]] && set -a && source "$ENV_FILE" && set +a
AT="${AGENT_TRACKER_ENDPOINT:-http://localhost:3456}"
AUTH=(-H "X-API-Key: ${AGENT_TRACKER_API_KEY:-}")
curl -sS "${AUTH[@]}" "$AT/health" | jq .
```

但 Agent 默认应始终走封装，避免遗漏鉴权。

## 1. 入口优先级（先总结，后细节）

### 原则：优先相信 AI 总结，快速了解情况

当需了解某个会话、某段工作或整体进展时，按以下优先级递减：

| 优先级 | 入口 | 适用场景 | 命令 |
|--------|------|----------|------|
| **1** | **事项归档** | "做了哪些事""完成什么""交接成果" | `runmark_get /v1/matters` |
| **2** | **会话 AISummary** | 快速理解某个 session 做了什么 | `runmark_get /v1/sessions/{id} \| jq '.AISummary'` |
| **3** | **会话 Messages** | 需要看对话正文、验证证据 | `runmark_get /v1/sessions/{id}/messages?limit=500` |
| **4** | **Turns / Tool Calls** | 排查 token、cost、错误、工具执行 | `runmark_get /v1/sessions/{id}/turns` |

### 事项归档（Matter）——「做了什么」的首选入口

事项归档按 matter 聚合多个会话，产出可交接的标题、主题、Markdown 总结、依赖文件与时间线。**不要把最近 N 个 Session 机械当成最近 N 件事。**

```bash
# 活跃事项
runmark_get /v1/matters | jq .

# 已归档事项
runmark_get "/v1/matters?tab=archive" | jq .

# 事项详情
runmark_get /v1/matters/<matter_id> | jq .
```

事项关键字段：

| 字段 | 说明 |
|------|------|
| `type` | `Design` / `Feature` / `Fix` 等分类 |
| `title` / `topic` / `markdown` | 正式交接内容，**优先阅读 markdown** |
| `summary` | 简要摘要 |
| `result` | 最终结果/结论 |
| `dependency_refs` / `timeline_points` | 依赖文件、接口、时间线 |
| `relatedSessionIds` | 关联来源 session |
| `effort_level` / `word_target` | 篇幅档位 |

### Session AISummary ——「这个会话做了什么」的有效捷径

`/v1/sessions/{id}` 返回中包含 `AISummary` 字段，由 Session Summary Agent 对完整对话生成。**如果 AISummary 非空且与当前问题相关，应直接信任它作为该会话的权威总结，无需逐条翻阅 messages/turns。**

```bash
SESSION_ID="ses_xxxxxxxx"

# 先拿 AISummary——大多数问题到这里就解决了
runmark_get /v1/sessions/$SESSION_ID | jq '{AISummary, title, model, agent, total_tokens, total_cost_usd}'
```

**只有当以下情况才深入 messages / turns：**
- AISummary 为空或未生成
- 用户明确要求看原文对话、验证证据
- 需要排查 token 消耗、错误原因、工具调用细节
- AISummary 与用户描述明显不符

### 完整 Session 上下文（仅在上述不足时使用）

```bash
SESSION_ID="ses_xxxxxxxx"

runmark_get /v1/sessions/$SESSION_ID | jq .
runmark_get "/v1/sessions/$SESSION_ID/messages?limit=500" | jq .
runmark_get /v1/sessions/$SESSION_ID/turns | jq .
runmark_get /v1/sessions/$SESSION_ID/tool-calls | jq .
runmark_get /v1/sessions/$SESSION_ID/children | jq .
```

一键合并（带 env 自动加载）：

```bash
source skills/agent-tracker-api/runmark-api.sh
./skills/agent-tracker-api/examples/fetch-session-context.sh "$SESSION_ID" analysis.json
```

重点字段速查：

| 目标 | 重点字段 |
|------|----------|
| **快速理解** | `session.AISummary`、`session.title`（**优先**） |
| 对话复盘 | `messages[].role`、`messages[].content`、`created_at` |
| Token / 费用 | `turns[].input_tokens`、`cache_read_tokens`、`output_tokens`、`cost_usd` |
| 失败排查 | `turns[].error`、`finish_reason`、0-token turn |
| 仓库上下文 | `session.repo_url`、`branch`、`directory`、`worktree` |
| 子会话 | `parent_session_id`、`/children`（OpenCode subagent / fork） |

## 2. 时间段统计

四个统计接口（`summary`、`by-model`、`by-agent`、`daily`）共用 `range` / `from` / `to`。省略 `range` 默认本月；`range` 支持：

| range | 含义 |
|-------|------|
| `today` | 当天北京时间 0 点至今 |
| `24h` | 过去 24 小时 |
| `7d` | 过去 7 天 |
| `month` | 本月北京时间 1 日至今 |
| `last_month` | 上一个完整北京时间自然月 |
| `custom` | 自定义闭区间，必须同时传 `from` / `to` |
| `all` | 全量 |

```bash
runmark_get "/v1/stats/summary?range=7d" | jq .
runmark_get "/v1/stats/by-model?range=7d&sort=cost" | jq .
runmark_get "/v1/stats/by-agent?range=7d&sort=tokens" | jq .
runmark_get "/v1/stats/daily?range=7d" | jq .
```

### 自定义日期与快捷范围

`from` / `to` 使用带时区的 ISO 8601 时间，成对传入时优先于 `range`，首尾均包含。缺少一端、格式非法或起点晚于终点返回 HTTP 400。用 `--data-urlencode` 编码时区中的 `+`。

```bash
# 北京时间 2026 年第三季度，含 7 月 1 日与 9 月 30 日全天
runmark_get /v1/stats/summary -G \
  --data-urlencode 'range=custom' \
  --data-urlencode 'from=2026-07-01T00:00:00+08:00' \
  --data-urlencode 'to=2026-09-30T23:59:59.999+08:00' | jq .
```

年度、季度等是客户端计算边界后调用 `range=custom`，不是新增的 `range` 枚举：

| 用户表达 | 按北京时间计算日期边界 |
|----------|------------------------|
| 本年度 | 今年 1 月 1 日至今天 |
| 本季度 | 当前自然季度第一天至今天 |
| 上季度 | 上一个完整自然季度 |
| 前三个月 | 当前月之前三个完整自然月，不含本月 |

日期查询起点取北京时间当天 00:00:00，终点取当天 23:59:59.999。预设 `range` 与 Dashboard 都按北京时间（UTC+8）计算，不要再按 UTC 或浏览器本地时区理解「今天」。`daily` 按北京时间日期分组。`summary` 返回实际使用的 `from` / `to`，全量时为 null。

一键快照：

```bash
source skills/agent-tracker-api/runmark-api.sh
./skills/agent-tracker-api/examples/fetch-period-snapshot.sh 7d week-snapshot.json
./skills/agent-tracker-api/examples/fetch-period-snapshot.sh custom quarter-snapshot.json \
  '2026-07-01T00:00:00+08:00' '2026-09-30T23:59:59.999+08:00'
```

注意：

- `/v1/stats/*?range=` 是聚合统计主入口。
- `/v1/sessions` 当前不支持服务端 `range`，需要客户端按 `started_at` 过滤。
- `/v1/turns` 当前按 `created_at` 倒序分页，支持 `model` / `provider` 过滤。

## 3. 发现 Session / Turn

```bash
# 最近会话
runmark_get "/v1/sessions?limit=50&offset=0" \
  | jq '.[] | {id, agent, started_at, model, user_email, total_tokens, total_cost_usd, AISummary: (.AISummary // "" | .[0:80])}'

# 按用户过滤
runmark_get "/v1/sessions?user_email=user@example.com&limit=20" | jq .

# 最近 LLM turn
runmark_get "/v1/turns?limit=30" \
  | jq '.[] | {session_id, provider, model, total_tokens, cost_usd, created_at, error}'

# 按模型或 provider 过滤
runmark_get "/v1/turns?provider=cursor&limit=20" | jq .
```

## 4. Cursor 账单同步

Cursor Hook 负责会话归属，真实 token / cost 依赖 Cursor Usage API 对账。

```bash
# 查看同步状态
runmark_get /v1/cursor/status | jq .

# 写入 WorkosCursorSessionToken 后触发同步
runmark_post /v1/cursor/cookies \
  -H "Content-Type: application/json" \
  -d '{"sessionToken":"<WorkosCursorSessionToken>","source":"dashboard"}' | jq .

# 手动立即同步
runmark_post /v1/cursor/sync | jq .

# 清除 Cursor Cookie
runmark_delete /v1/cursor/cookies | jq .
```

分析 Cursor cost 时先看：

- `available` 是否为 `true`
- `hasCryptoKey` / `hasCookies` 是否为 `true`
- `authExpired` 是否为 `false`
- `pendingQueue` / `pendingEnrich` 是否长期堆积
- `lastError` 是否提示 401 / 403 / rate limit

## 5. Agent 调用记录与事项归档操作

```bash
# Agent 配置
runmark_get /v1/agents | jq .
runmark_get /v1/agents/agent-session-summary/config | jq .

# 触发一次 Agent run（重新为 session 生成 AISummary）
runmark_post /v1/agents/agent-session-summary/runs \
  -H "Content-Type: application/json" \
  -d '{"session_id":"'"$SESSION_ID"'","trigger":"openapi","force":true}' | jq .

# 调用记录
runmark_get "/v1/agent-runs?limit=50" | jq .

# 当前事项重新总结
runmark_post /v1/matters/<matter_id>/resummarize \
  -H "Content-Type: application/json" \
  -d '{"session_ids":["'"$SESSION_ID"'"]}' | jq .

# 归档事项
runmark_post /v1/matters/<matter_id>/archive | jq .
```

## 6. 系统配置 API

Provider 与 Model List 在系统配置中维护；Agent 配置只引用 `model_id`。

```bash
# Provider + Model List
runmark_get /v1/system-config | jq .

# 测试 OpenAI Compatible Provider 连通性
runmark_post /v1/system-config/providers/test \
  -H "Content-Type: application/json" \
  -d '{"base_url":"https://example.com/v1/chat/completions","api_key":"sk-...","model":"model-name"}' | jq .

# 新增 Provider，并创建默认模型
runmark_post /v1/system-config/providers \
  -H "Content-Type: application/json" \
  -d '{"name":"Custom","base_url":"https://example.com/v1/chat/completions","api_key":"sk-...","model":"model-name"}' | jq .

# 在已有 Provider 下新增模型
runmark_post /v1/system-config/models \
  -H "Content-Type: application/json" \
  -d '{"provider_id":"provider-xxx","model":"another-model","label":"Another Model"}' | jq .

# 删除未被 Agent 使用的模型
runmark_delete /v1/system-config/models/model-xxx | jq .
```

## 7. 帮助中心上下文

Dashboard 帮助中心通过该接口拿当前 endpoint 和 API Key：

```bash
runmark_get /v1/help/context | jq .
```

返回字段：`endpoint`、`apiKey`、`apiKeyVisible`、`publicDashboard`。

## 8. 公开 Session Share（免登录，持有 credential 即可）

事实来源：`packages/server/src/routes/session-shares.ts`。完整字段见 OpenAPI tag `session-shares`。

**适用场景**：你拿到的是分享链接 / `api_url` / credential，而不是本机已登录的 Dashboard。**无需** `X-API-Key`；credential 本身就是访问能力。

### 原则：先摘要，再按需落盘详情

| 优先级 | 入口 | 说明 |
|--------|------|------|
| **1** | **根接口** `GET /v1/public/session-shares/{credential}` | 仅摘要 + `counts` + `resources` 链接；**默认不拉全量** messages/turns/tool_calls |
| **2** | `resources.search` | 按关键词搜消息/工具片段 |
| **3** | `resources.messages` / `turns` / `tool_calls` | 需要正文、token、工具记录时再分页拉取 |

持有 credential 的接收方**可以**按需取详细消息与工具记录；建议流程：

1. 先 `curl` 根接口，优先读 `summary_markdown` / `session.AISummary`
2. 需要细节时，从响应 `resources` 选链接，用 **`curl -o <file>` 落盘** 后再分析（避免把大段 JSONL 直接塞进上下文）

### Credential 两种形态

| 形态 | 格式 | 常见来源 |
|------|------|----------|
| **raw token** | 创建分享返回的 `token`（base64url） | 创建响应的 `api_url`、`agent_prompt` |
| **HMAC alias** | `{token_hash}.{signature}`（64 位 hex + `.` + base64url 签名） | 人类链接 `/#/share/{alias}`；签名 = HMAC-SHA256(服务端 apiKey, `"agent-tracker-session-share-link-v1:" + token_hash`) |

两种 credential 访问同一分享；alias 签名错误 / 不存在 → **404**；过期 → **410** `{ "error": "Share expired" }`。

### 根接口（优先）

```bash
# 将 CRED 替换为 raw token 或 HMAC alias（URL 中注意保留字符原样）
SHARE_URL="$AT/v1/public/session-shares/$CRED"

# 建议落盘摘要
curl -sS -o runmark-session-summary.json "$SHARE_URL"
jq '{AISummary: .session.AISummary, summary_markdown, counts, resources, expires: .share.expires_at}' \
  runmark-session-summary.json
```

根响应要点：

| 字段 | 含义 |
|------|------|
| `share.expires_at` | 过期时间 |
| `session` | 公开白名单元数据（title、AISummary、agent、model(s)、token/cost、message_count/turn_count 等；**无** user_email/directory 等敏感字段） |
| `summary_markdown` | 等同 AISummary（空则 null） |
| `counts` | `{ messages, turns, tool_calls }` 仅 COUNT |
| `resources` | 子资源绝对 URL：`search`、`messages`、`turns`、`tool_calls`（后三者默认带 `format=jsonl&limit=50`） |
| `agent_prompt` | 给 Agent 的提示文案（含一条 curl 落盘示例） |

浏览器带 `Accept: text/html` 打开根 URL 会 **302** 到 Dashboard `#/share/...`；curl 默认拿 JSON。

### 搜索

```bash
curl -sS "$SHARE_URL/search?q=bugfix&kind=all&limit=20" | jq .
# kind: all | message | tool；q 至少 2 字符；limit 1–50，默认 20
```

### 详情列表（JSON / JSONL）

`messages` / `turns` / `tool-calls` 共用：

| 参数 | 默认 | 说明 |
|------|------|------|
| `format` | `json` | `json` → `{ items, next_offset }`；`jsonl` → NDJSON（`application/x-ndjson`），每行一条 |
| `limit` | `50` | 1–100 |
| `offset` | `0` | 翻页；`next_offset` 有下一页时为 `offset+limit`，否则 null |

可选过滤：

- `messages?role=user|assistant`
- `tool-calls?tool_name=ExactName`

```bash
# 建议：按 resources 链接 JSONL 落盘
curl -sS -o messages.jsonl "$SHARE_URL/messages?format=jsonl&limit=50"
curl -sS -o turns.jsonl    "$SHARE_URL/turns?format=jsonl&limit=50"
curl -sS -o tools.jsonl    "$SHARE_URL/tool-calls?format=jsonl&limit=50"

# 或 JSON 分页
curl -sS "$SHARE_URL/messages?format=json&limit=50&offset=0" | jq '{n: (.items|length), next: .next_offset}'
```

截断约定（公开投影）：message `content` ≤16KB；tool `args` ≤8KB、`output_text` ≤16KB；超限时对应 `truncated` / `args_truncated` / `output_text_truncated` 为 true。

### 错误码

| HTTP | 含义 |
|------|------|
| **404** | credential 无效、alias 签名失败、分享不存在、session 已删 → `{ "error": "Not found" }` |
| **410** | 分享过期 → `{ "error": "Share expired" }` |
| **400** | 查询参数非法（q/kind/limit/format/role 等） |

> 管理侧创建/列表/撤回（`POST/GET/DELETE /v1/sessions/{id}/shares*`）需登录鉴权，不在本公开读取路径内；Agent 作为**接收方**通常只需公开 API。

## 9. curl 速查表

| 场景 | 封装命令 |
|------|----------|
| 健康检查 | `runmark_health` |
| 会话列表 | `runmark_get "/v1/sessions?limit=50"` |
| 会话详情 | `runmark_get /v1/sessions/{id}` |
| 会话 AISummary | `runmark_get /v1/sessions/{id} \| jq '.AISummary'` |
| 对话正文 | `runmark_get "/v1/sessions/{id}/messages?limit=500"` |
| LLM turns | `runmark_get /v1/sessions/{id}/turns` |
| 工具调用 | `runmark_get /v1/sessions/{id}/tool-calls` |
| 子会话 | `runmark_get /v1/sessions/{id}/children` |
| 7 天统计 | `runmark_get "/v1/stats/summary?range=7d"` |
| 模型排行 | `runmark_get "/v1/stats/by-model?range=7d&sort=tokens"` |
| Agent 排行 | `runmark_get "/v1/stats/by-agent?range=7d&sort=cost"` |
| Cursor 状态 | `runmark_get /v1/cursor/status` |
| Agent runs | `runmark_get "/v1/agent-runs?limit=50"` |
| Matters | `runmark_get /v1/matters` |
| 系统配置 | `runmark_get /v1/system-config` |
| 公开分享摘要（免登录） | `curl -sS -o runmark-session-summary.json "$AT/v1/public/session-shares/$CRED"` |
| 分享内搜索 | `curl -sS "$AT/v1/public/session-shares/$CRED/search?q=..."` |
| 分享消息 JSONL 落盘 | `curl -sS -o messages.jsonl "$AT/v1/public/session-shares/$CRED/messages?format=jsonl&limit=50"` |
| 分享 turns JSONL | `curl -sS -o turns.jsonl "$AT/v1/public/session-shares/$CRED/turns?format=jsonl&limit=50"` |
| 分享 tool-calls JSONL | `curl -sS -o tools.jsonl "$AT/v1/public/session-shares/$CRED/tool-calls?format=jsonl&limit=50"` |

## 10. 分析输出模板

```markdown
## 上下文入口（优先）
- Matter 归档：[标题 + markdown 摘要] 或 "无关联事项"
- AISummary：[存在则直接引用核心内容] 或 "未生成"

（以下仅在 AISummary / Matter 不足以回答问题时展开）

## Session 摘要
- ID / agent / 用户 / 模型 / 时间跨度 / token / cost

## 对话与产出
- 用户目标
- Agent 实际完成内容
- 涉及文件、命令、接口和配置

## LLM 调用
- turn 数、失败数、cache 占比、最贵一轮

## 工具与代码影响
- tool calls、文件路径、additions/deletions、错误

## Agent / Matter 关联
- 优先列出 matter 标题、类型、主题、状态和交接结论
- 再说明相关 Session IDs 和是否已有 AISummary
- 相关 agent job 是否成功

## 异常与建议
- 401、Cursor cost 缺失、0-token turn、Provider 连接失败等
```

## 相关文档

- `README.md` — 项目简介和最小部署入口
- `packages/server/src/routes/*.ts` — API 源码事实来源
- `packages/server/public/help/*.md` — Dashboard 帮助中心文章
- `skills/agent-tracker-clients/` — 本机 Cursor / OpenCode / Codex / Claude 系 / Grok 等新装与更新
- `skills/agent-tracker-api/runmark-api.sh` — 本 SKILL 的封装脚本源码
- `AGENTS.md` — 服务开发与 Dashboard 约定
