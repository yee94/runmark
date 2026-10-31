# 网页功能 → API 索引

完整参数以 [OpenAPI](../openapi.yaml) 为准。除 `/auth/*`、`/health`、公开分享外，Dashboard 数据默认需 Cookie 或 API Key；ingest、OTLP、定价写入始终校验 API Key。

| 网页功能 | 接口 |
|---|---|
| 登录/状态/退出 | POST `/auth/login`、GET `/auth/session`、POST `/auth/logout` |
| 总览与模型排行 | GET `/v1/stats/summary`、`by-model`、`by-agent`、`daily` |
| 全文搜索 | GET `/v1/sessions?q=...`（标题/摘要/消息） |
| AI 会话搜索 | POST `/v1/sessions/agent-search` |
| 会话详情/调用链 | GET `/v1/sessions/{id}` 及 `/messages`、`/turns`、`/tool-calls`、`/children` |
| 重生成摘要 | POST `/v1/sessions/{id}/resummarize` |
| 创建/列出/撤回分享 | POST/GET `/v1/sessions/{id}/shares`、DELETE `/v1/sessions/{id}/shares/{shareId}` |
| 公开分享 | GET `/v1/public/session-shares/{credential}` 及 `/search`、`/trace`、`/focus`、`/messages`、`/turns`、`/tool-calls` |
| 事项筛选/详情 | GET `/v1/matters`（q/tab/limit/offset）、`/v1/matters/{id}` |
| AI 事项搜索 | POST `/v1/matters/agent-search` |
| 事项生成/重新总结/归档 | POST `/v1/matters/resummarize`、`/v1/matters/{id}/resummarize`、`/v1/matters/{id}/archive` |
| Agent 配置/运行 | GET `/v1/agents`、GET/PUT `/v1/agents/{id}/config`、POST `/v1/agents/{id}/runs` |
| 任务历史/详情/重试 | GET `/v1/agent-runs`、GET `/v1/agent-runs/{id}`、POST `/v1/agent-runs/{id}/retry` |
| Cursor 对账 | GET `/v1/cursor/status`、POST/DELETE `/v1/cursor/cookies`、POST `/v1/cursor/sync` |
| 系统模型配置 | GET `/v1/system-config`、POST `/providers`、PUT `/providers/{id}`、POST `/providers/test`、POST `/providers/{id}/test`、POST `/models`、DELETE `/models/{id}`（后六项前缀 `/v1/system-config`） |
| 定价与历史重算 | GET/PUT `/v1/pricing`、POST `/v1/pricing/reprice` |
| 服务更新 | GET `/v1/system-update/check`、`/v1/system-update/status`、POST `/v1/system-update` |
| 帮助上下文 | GET `/v1/help/context` |
| 分层长期记忆 | GET `/v1/memories/scopes`、`/projects`、`/index`、GET/POST `/v1/memories`、GET/PATCH/DELETE `/v1/memories/{id}`；scope + agent_key 选择空间，view=effective 读取适用层；见 [分层记忆](memory.md) |

采集接口另有 POST `/v1/ingest`、`/v1/traces`、`/v1/metrics`。OTLP 只支持 HTTP JSON，metrics 接收后丢弃。GET `/v1/turns` 提供全局 turn 分页；GET `/v1/stats/by-tool` 仍存在，但网页不展示工具统计。

当前限制：全文搜索不索引工具内容；会话列表没有服务端日期过滤；父会话搜索结果不附命中片段。历史事实需要分页读取原文/子会话核对，不能将摘要或 AI 搜索结果当作完整证据。
