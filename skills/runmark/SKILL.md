---
name: runmark
description: 查询 Runmark 历史会话与工作记录：找以前配置过的 token、命令或决策，按原文定位证据；读取、保存或纠正全局、项目及 Agent 专属记忆；统计用量费用、检索事项、查看 Agent 任务、读取公开分享及管理服务配置。
---

# Runmark

## 启动

从本 Skill 的实际目录加载脚本（全局安装时不依赖当前仓库）：

```bash
source <skill目录>/runmark-api.sh
runmark_health
```

脚本静默读取 `~/.config/runmark/env`，新文件缺失时只读兼容旧配置。进程环境优先于文件，同一来源内 `RUNMARK_*` 优先于旧前缀，支持 `endpoint` / `apiKey` 短键。请求路径含 `?`、`&` 时加引号；查询值使用 `-G --data-urlencode`。输出为原始 JSON，需要时管道到 `jq`。HTTP 错误应作为错误处理，不能解释成无记录。

## 找历史事实：搜索 → 原文 → 证据

用户问“这周设置过 npm token 吗”“之前怎么配置的”“找那段命令”时，直接搜索正文。Matter / AISummary 用于发现候选，不是配置成功的原始证据。

1. 明确日期边界。“本周”是北京时间周一 00:00 至现在，不等于滚动 `7d`。
2. 用关键词分别查询；`q` 是完整字面子串，不支持多词 AND。比如依次用 `NPM_TOKEN`、`npm_`、`npm token`、`.npmrc`。

```bash
runmark_get /v1/sessions -G --data-urlencode 'q=NPM_TOKEN' \
  --data-urlencode 'limit=200' --data-urlencode 'offset=0'
```

3. 返回根会话数组，按 `last_activity_at` 倒序。搜索覆盖标题、AISummary、消息正文及子会话正文，**不覆盖工具参数/输出**。每页最多 200；满页继续增加 offset，直到短页。服务端不支持会话时间筛选；先用活动时间判断候选，再按原文 `created_at` 判断是否在本周。旧会话也可能本周继续使用。
4. 读取候选消息，默认只有 100 条，必须分页至短页；命中可能来自子会话，必要时继续 `/children`。消息未命中时查摘要来源及 `/tool-calls` 的 `args`、`output_text`，不能因为父会话首屏没有就判断不存在。

```bash
runmark_get "/v1/sessions/$SESSION_ID/messages?limit=500&offset=0" -o messages.json
runmark_get "/v1/sessions/$SESSION_ID/children"
runmark_get "/v1/sessions/$SESSION_ID/tool-calls" -o tools.json
```

5. 给出时间、会话标题与链接、消息 ID、原文结论。区分“提供 token”“写入配置”“验证成功”。默认展示配置位置与脱敏片段，原值按用户明确需求提供。链接用 `$_RM_ENDPOINT/#/sessions/$SESSION_ID`。排除当前查询会话、日报转述等自引用命中。

关键词难以描述时，可调用与网页相同的 AI 搜索（会运行模型）：

```bash
runmark_post /v1/sessions/agent-search -H 'Content-Type: application/json' \
  -d '{"query":"查找本周配置 npm 发布 token 的会话"}'
runmark_get "/v1/agent-runs/$JOB_ID"
```

默认返回 202 Job；用返回的 `id` 查询到终态后阅读结果，再核对原文。事项 AI 搜索为 `/v1/matters/agent-search`，同样传 `query`。同步执行可加 `?sync=1`，失败返回 500；409 表示忙，不等于无结果。

## 其他入口

| 需求 | 入口与参考 |
|---|---|
| 工作成果、事项 | `GET /v1/matters?q=...&tab=archive&limit=50&offset=0`，详情 `/v1/matters/{id}` |
| 约定、偏好与决策记忆 | 用户要求回忆、记住、纠正或忘记，或当前任务需要既有约定时，读 [分层记忆](references/memory.md)；索引用于发现，详情才是应用依据 |
| 用量、费用、模型排行 | `/v1/stats/summary`、`by-model`、`by-agent`、`daily`；日期口径见 [工作流](references/workflows.md#2-时间段统计) |
| Agent 任务状态与重试 | `/v1/agent-runs` 返回 `{items,total,limit,offset,has_more}`；详情 `/v1/agent-runs/{id}` |
| 分享读取与管理 | [API 索引](references/api-map.md)；公开读取无需本机鉴权，优先响应中的 resources |
| Cursor 对账、Provider、定价、更新 | [API 索引](references/api-map.md)，字段见 [OpenAPI](openapi.yaml) |
| 本机客户端安装 | 仓库 `skills/agent-tracker-clients/SKILL.md` |
| 服务部署 | 仓库 `skills/agent-tracker-setup/SKILL.md` |

详细操作示例见 [工作流](references/workflows.md)。完整接口合约见 [OpenAPI](openapi.yaml)。仓库内以 `packages/server/src/routes/*.ts` 与 `src/app.ts` 为事实来源；运行 `bun skills/runmark/scripts/check-api-coverage.ts` 检查路由覆盖和引用。远端 404 时先核对 `/health` 版本，不把本地新增能力当成已部署。
