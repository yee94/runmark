# Runmark 操作示例

先按 [SKILL](../SKILL.md) 加载 `runmark-api.sh`。下列变量由调用方填写；历史事实检索按 SKILL 的原文取证流程执行。

## 1. 会话与事项

```bash
runmark_get "/v1/sessions/$SESSION_ID"
runmark_get "/v1/sessions/$SESSION_ID/messages?limit=500&offset=0"
runmark_get "/v1/sessions/$SESSION_ID/turns"
runmark_get "/v1/sessions/$SESSION_ID/tool-calls"
runmark_get "/v1/sessions/$SESSION_ID/children"
runmark_get /v1/matters -G --data-urlencode 'q=发布' --data-urlencode 'limit=50'
runmark_get '/v1/matters?tab=archive&limit=50&offset=0'
runmark_get "/v1/matters/$MATTER_ID"
```

AISummary / matter markdown 用于快速了解工作；具体事实回查消息与工具。会话详情的 token/cost 含直接子会话汇总，避免再次累加。全局 turns 支持 `model`、`provider`、`limit`、`offset`，按 created_at 倒序。单会话 turns/tool-calls 返回全量数组；messages 返回升序分页数组。

## 2. 时间段统计

`summary`、`by-model`、`by-agent`、`daily` 共用 `range/from/to`。默认本月；range 为 `today`、`24h`、`7d`、`month`、`last_month`、`custom`、`all`。预设日历与 daily 按北京时间 UTC+8；`7d` 是滚动七天。自定义 from/to 为带时区 ISO 8601，成对传入，闭区间，优先于 range；非法边界返回 400。

```bash
runmark_get '/v1/stats/summary?range=7d'
runmark_get '/v1/stats/by-model?range=7d&sort=cost'
runmark_get '/v1/stats/by-agent?range=7d&sort=tokens'
runmark_get '/v1/stats/daily?range=7d'
runmark_get /v1/stats/summary -G --data-urlencode 'range=custom' \
  --data-urlencode 'from=2026-10-26T00:00:00+08:00' \
  --data-urlencode 'to=2026-10-29T23:59:59.999+08:00'
```

年度/季度/本周由调用方计算边界。“前三个月”指当前月之前三个完整自然月。summary 返回实际 from/to。sessions/turns 列表不支持统计时间参数；快照脚本中的 recent_sessions/recent_turns 只是近期样本。

## 3. Agent 与事项操作

```bash
runmark_get /v1/agents
runmark_get '/v1/agent-runs?limit=50&offset=0'
runmark_get "/v1/agent-runs/$JOB_ID"
runmark_post "/v1/agent-runs/$JOB_ID/retry" -H 'Content-Type: application/json' -d '{}'
runmark_post "/v1/sessions/$SESSION_ID/resummarize"
runmark_post /v1/matters/resummarize -H 'Content-Type: application/json' \
  -d '{"session_ids":["session-id"],"append_matters":true}'
runmark_post "/v1/matters/$MATTER_ID/resummarize" -H 'Content-Type: application/json' -d '{}'
runmark_post "/v1/matters/$MATTER_ID/archive"
```

Job 默认为异步 202；详情查到终态再读结果。retry 仅用于失败任务，创建新任务后删除旧任务；忙或状态不符返回 409。session resummarize 会清空旧 AISummary 并生成新摘要。事项重总结可指定 session_ids 与 append_matters。

## 4. Cursor 与系统配置

```bash
runmark_get /v1/cursor/status
runmark_post /v1/cursor/sync
runmark_get /v1/system-config
runmark_get /v1/pricing
runmark_get /v1/system-update/check
runmark_get /v1/system-update/status
```

Cursor cost 缺失时检查 available、hasCryptoKey、hasCookies、authExpired、pendingQueue、pendingEnrich、lastError。Cookie 写入 body 为 `{sessionToken,source}`；清除用 DELETE `/v1/cursor/cookies`。

Provider 配置与连通测试、Model 创建/删除、Agent 配置、定价写入与历史重算见 [OpenAPI](../openapi.yaml)。系统更新 POST `/v1/system-update` body 为 `{version}`，返回 202 后查询 status。`/v1/help/context` 可返回 API Key，只提取任务需要的字段。

## 5. 公开分享

接收方用分享链接中的 credential（raw token 或签名 alias），无需 X-API-Key。先 curl `GET /v1/public/session-shares/{credential}`，按响应 resources 下钻，详情用 `curl -o` 落盘。

```bash
curl -fsS "$SHARE_URL" -o summary.json
curl -fsS -G "$SHARE_URL/search" --data-urlencode 'q=配置' --data-urlencode 'kind=all'
curl -fsS "$SHARE_URL/trace?limit=50&offset=0" -o trace.json
curl -fsS "$SHARE_URL/messages?format=json&limit=50&offset=0" -o messages.json
```

消息/turns/tool-calls JSON 返回 `{items,next_offset}`，JSONL 用 `format=jsonl`。默认 50、最大 100；消息可按 role，工具可按 tool_name 过滤。trace 是网页时间线入口；focus 用 `node`（msg-/turn-/tool- 前缀节点 key）和可选 child 读取单节点。以 trace 返回 key 为准。

分享可限定 types 或单 node/child；所有子资源受创建时 scope 限制，不保证包含整段会话。检查 truncated、args_truncated、output_text_truncated；404 是不存在/无权限，410 是过期，400 是参数非法。管理侧 shares 创建/列表/撤回需本机鉴权，字段见 [OpenAPI](../openapi.yaml)。
