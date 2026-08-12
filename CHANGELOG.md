# Changelog

## Unreleased

## 0.2.27 (Server) - 2026-08-08

- 公开 Session Share 默认摘要优先，并提供按需 search/JSONL 详情资源。
- 公开分享页摘要与 Agent 渐进读取引导。
- LIKE 通配符搜索转义与公开 Markdown XSS 净化。
- 公开 API/Skill 文档同步。

## 0.2.26 (Server) - 2026-08-06

- 有效分享列表新增复制链接入口，并为历史分享生成可验证的人类访问链接。
- 浏览器直接打开 Agent Prompt 中的公开 API URL 时，自动跳转到同一 token 的只读分享页；curl 保持 JSON 响应。
- 分享弹窗在 HTTP 复制受限时展开链接输入框，支持手动选择复制。

## 0.2.25 (Server) - 2026-08-06

- 修复分享弹窗内复制链接与 Agent Prompt 无反馈：fallback 在弹窗内完成聚焦与复制，失败时展示手动复制提示。

## 0.2.24 (Server) - 2026-08-06

- Agent Prompt 明确说明可在 curl 命令末尾添加 `-o runmark-session-context.json`，将较大的完整上下文保存到本地文件分析。

## 0.2.23 (Server) - 2026-08-06

- 公开分享页新增“复制给 Agent”，可直接复制带临时访问凭证的上下文提示词。
- Agent Prompt 引导优先查看 AISummary，并在响应较大时将完整上下文保存到本地文件分析。
- 会话总结操作补充图标，并将分享入口调整到操作区最右侧。

## 0.2.22 (Server) - 2026-08-06

- 新增 Session 限时分享，支持 1 小时、6 小时、12 小时、3 天与 7 天有效期。
- 分享页复用完整调用链详情，以只读模式展示消息、Turn 与工具调用，并提供精简 Agent Prompt。
- 新增有效分享列表与撤回能力，区分已撤回链接和已过期链接的访问状态。
- 分享令牌使用随机值与哈希存储，公开 Session 信息采用字段白名单。

## 0.2.20 (Server) - 2026-07-28

- 扩展共享定价表：补充 Gemini 3.6 Flash、Gemini 3.5 Flash、Claude Sonnet 5、Kimi K3 及 BoxAI 代理模型价格。

## 0.2.19 (Server) - 2026-07-26

- 按 xAI / Cursor 官方 API 价修正 Grok 4.5 与 Composer 2.5 定价（含 cache / reasoning）。
- 新增 `grok-build` provider 定价条目；ingest 对 `grok-build` / `xai` / `grok` 强制服务端估算，避免 open-grok-build 漏计 cache。
- 新增 `POST /v1/pricing/reprice` 与 `scripts/reprice-grok.ts`，支持按定价表回算历史 turns。
- 启动时 `seedPricing` 与 `DEFAULT_PRICING` 对齐（upsert）。

## 0.2.18 (Server) - 2026-07-23

- Dashboard 支持 Grok Build 客户端：`agent-icons/grok.svg`、帮助中心 `grok.md`、会话列表 Agent 标签。
- 共享定价表补充 xAI / Grok 模型（`xai` / `grok` provider），便于无原生 cost 时服务端估算。
- skip-tools 增加 Grok 常用工具名（`run_terminal_command` / `search_path` / `grep_search`）。

## 0.2.17 (Server) - 2026-07-18

- 事项 AI 搜索优先扫描最近更新的归档，并将模型调用限制为最多两轮。
- 搜索结果记录实际扫描数量，便于审查候选覆盖范围与调用开销。

## 0.2.16 (Server) - 2026-07-18

- 事项与会话列表新增 AI 搜索 Agent，支持普通搜索与 AI 搜索入口、思考中状态及语义结果展示。
- 会话 AI 搜索使用关键词召回、时间范围识别与语义排序，控制候选数量与模型调用次数。
- 调用链仅保留 Tool 执行摘要；停止持久化 Tool 输入与输出，并清理历史 Tool 载荷。
- 任务重试将必要的短 query 与 Session ID 保存在任务级轻量输入中。

## 0.2.15 (Server) - 2026-07-18

- 事项归档列表支持按编号、类型、标题、主题、摘要、结果和归档正文搜索。
- 事项总结与已归档列表支持每页 50 条、关键词清除及前后翻页。

## 0.2.13 (Server) - 2026-07-17

- Session Summary 跳过 OpenCode / Cursor subagent 子会话（`parent_session_id` 或 `metadata.is_subagent`），避免子 agent 单独刷标题与摘要。
- 过滤 OpenCode SmartFetch 临时会话 `smartfetch-secondary`：ingest 不入库，Dashboard 会话列表默认隐藏。

## 0.2.12 (Server) - 2026-07-17

- 修复 Docker 发布任务缺少 Registry 登录态导致的镜像推送失败，发布阶段显式登录 Docker 制品库。

## 0.2.11 (Server) - 2026-07-17

- 新增 Runmark Server 多阶段 Docker 镜像，并通过 `server-vX.Y.Z` 发布。
- Docker 运行时使用非 root 用户、持久化 SQLite 数据卷、健康检查和强制 API Key 校验。
- macOS 发布链路拆分触发与构件下载职责。

## 0.2.10 (Server) - 2026-07-15

- 智能体配置页 Schedule 输入改为自由编辑，仅在保存时校验格式。
- Schedule 输入框下方增加协议说明小字（防抖/节流、全局/会话维度）。
- 调整触发器 Schedule 输入宽度与行布局，避免压住描述文案。

## 0.2.9 (Server) - 2026-07-15

- 会话摘要 schedule 支持按会话维度防抖：`session:debounce:5m`（token 顺序不限，如 `debounce:session:5m`），不同 Session 互不重置等待窗口。
- 内置默认：Session Summary 为 `session:debounce:5m`，Matter Archive 为 `throttle:10m`（仅影响新装与未自定义等待时长的配置，不改写已有自定义间隔）。

## 0.2.8 (Server) - 2026-07-14

- 更新器改用 SQLite 一致性快照备份数据库，拒绝空库与快照完整性失败，避免发布过程产生不可恢复备份。
- 发布后校验数据库完整性与会话、Turn 记录数；校验失败自动回滚代码和数据库快照。
- 修复成功更新后退出清理分支重复恢复服务的状态判断。

## 0.2.7 (Server) - 2026-07-14

- 修复智能体配置页未读取 `schedule` 字符串的问题，页面现在展示并编辑 `debounce:1m`、`throttle:5m` 等触发配置。

## 0.2.6 (Server) - 2026-07-14

- 会话摘要触发改为防抖调度，事项归档保持节流聚合，降低连续对话期间的重复摘要。
- 触发配置统一为 `schedule` 字符串格式，例如 `debounce:1m` 与 `throttle:5m`。
- 启动时自动将内置 Agent 的历史 `debounce`、`throttle` 配置迁移为 `schedule`，并保留既有等待时长。

## 0.2.5 (Server) - 2026-07-10

- 新增 Agent Run 列表与调用链详情，可查看 Prompt、Tool Calls、LLM 输出、模型、Token、费用与关联会话。
- 自动触发改为按 Agent 隔离的固定节流窗口；长任务使用 single-flight，避免重复或重叠执行。
- 强化 LLM 重试与 ReAct 协议恢复，减少临时网络错误和不完整模型响应导致的失败。
- 修复多会话摘要串写、并发运行冲突与调用记录缺少会话名称的问题。
- 修复更新成功后侧栏「更新成功」按钮常驻：历史 `completed` 态与静默检查不再卡在 success。
- 自动更新默认开启，并内置官方 manifest URL；无需再手动配置 `AGENT_TRACKER_UPDATE_*`。

## 0.2.4 (Server) - 2026-07-10

- 新增 Agent Run 列表与调用链详情，可查看 Prompt、Tool Calls、LLM 输出、模型、Token、费用与关联会话。
- 自动触发改为按 Agent 隔离的固定节流窗口；长任务使用 single-flight，避免重复或重叠执行。
- 强化 LLM 重试与 ReAct 协议恢复，减少临时网络错误和不完整模型响应导致的失败。
- 修复多会话摘要串写、并发运行冲突与调用记录缺少会话名称的问题。

## 0.2.3 (Server) - 2026-07-10

- 新增服务端自动更新：发布包、校验文件、更新 manifest 与 Dashboard 更新提示。
- 修复更新器同步、生产依赖安装及 Linux systemd 升级流程。

## Earlier releases

- 0.2.0–0.2.2：引入内置 Agent、事项归档、会话摘要、Cursor 用量对账与 Dashboard 优化。
- 0.2.4–0.2.10（客户端）：完善 Cursor、Codex、Claude Code、CodeBuddy、WorkBuddy 的采集与安装体验。
- 0.1.x（Runmark）：发布统一客户端安装入口 `@runmarks/runmark`。
