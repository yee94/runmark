# Runmark — Agent 协作指南

本文档供后续 Cursor / OpenCode Agent 快速接手本项目。读完即可开发、调试、扩展，无需翻遍历史对话。

## 项目是什么

**Runmark** 是中心化 AI 编码 Agent 遥测服务（MVP 已可用）：

```
[OpenCode + Plugin] ──POST /v1/ingest──▶ [Bun + Hono + SQLite] ──▶ [Eficy Dashboard]
[Codex + Hook Plugin] ────POST /v1/ingest──▶
[Claude Code Plugin] ─────POST /v1/ingest──▶
[CodeBuddy Plugin] ───────POST /v1/ingest──▶
[WorkBuddy Plugin] ───────POST /v1/ingest──▶
[Grok Build Hooks] ───────POST /v1/ingest──▶
```

- **采集**：OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build 等客户端插件监听生命周期，上报 session / message / turn / tool
- **存储**：SQLite，按 session 聚合 token 与 cost
- **展示**：单文件 `packages/server/public/index.html`（Eficy + 暗色 PC 后台布局）

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Bun ≥ 1.1 |
| 后端 | Hono、SQLite (`bun:sqlite`) |
| 共享类型 | `packages/shared/` workspace `@agent-tracker/shared` |
| 插件 | OpenCode Plugin API (`@opencode-ai/plugin` / `@opencode-ai/sdk`) |
| Codex 插件 | Codex Hook/Plugin 系统（stdin/stdout JSON 命令行钩子） |
| Claude Code / CodeBuddy / WorkBuddy | 共用 `plugin-claude-compat`：官方 Plugin Marketplace 安装；按 `--runtime` 分产品；Stop 读 transcript JSONL |
| Grok Build 插件 | `plugin-grok`：用户级 `~/.grok/hooks/*.json` command hook；Stop 读 `~/.grok/sessions` |
| Dashboard | Eficy 1.2.3 + `@eficy/shadcn-ui` 1.1.3，零构建单 HTML |

## 仓库结构

```
agent-tracker/
├── AGENTS.md                 # 本文件
├── README.md                 # 用户向快速入门
├── skills/                   # Agent 查询 / 部署 / 客户端 Skills
│   ├── agent-tracker-api/    # curl + OpenAPI：拉 session 上下文、时间段统计
│   ├── agent-tracker-setup/  # 服务端部署
│   └── agent-tracker-clients/# 本机客户端新装与更新（优先 npx @runmark/runmark）
├── .cursor/skills/           # 项目级 Cursor Skills
│   └── eficy-shadcn/       # Dashboard / 单页 UI 开发（从 langfuse-analyze-agent 复制）
├── packages/
│   ├── runmark/              # 品牌统一入口 @runmark/runmark（编排各客户端安装）
│   ├── shared/src/
│   │   ├── index.ts          # Ingest 合约、领域模型、定价表、computeCost
│   │   ├── model-id.ts       # 模型 id 规范化（-ioa 等别名）
│   │   └── logger.ts         # FileLogger（debug 文件日志）
│   ├── server/
│   │   ├── src/
│   │   │   ├── app.ts        # Hono 组装、鉴权、路由挂载
│   │   │   ├── config.ts     # 服务配置
│   │   │   ├── logger.ts     # server 侧 FileLogger 单例
│   │   │   ├── db/schema.ts  # SQLite DDL
│   │   │   ├── routes/       # ingest、sessions、stats
│   │   │   └── services/
│   │   │       ├── ingest.ts # 批量 ingest + session upsert
│   │   │       ├── cost.ts   # 定价与 cost 计算
│   │   │       └── stats.ts  # 时间范围解析（today/24h/7d/month/all）
│   │   ├── public/index.html # Dashboard（主 UI，~1600 行 Eficy）
│   │   ├── data/             # agent-tracker.db、agent-tracker.log（gitignore）
│   │   └── __tests__/
│   ├── plugin-opencode/
│   │   ├── src/index.ts      # 插件入口：hooks + TrackerClient
│   │   ├── tsdown.config.ts  # npm 发布 bundle 配置
│   │   └── __tests__/
│   ├── plugin-codex/
│   │   ├── src/index.ts      # CLI 入口：stdin JSON → IngestEvent → POST
│   │   ├── src/config.ts     # 配置加载（复用 shared env-file）
│   │   ├── src/transform.ts  # Codex hook 数据 → IngestEvent 映射
│   │   ├── src/send.ts       # HTTP POST /v1/ingest
│   │   ├── src/git.ts        # Git 元信息采集
│   │   ├── tsdown.config.ts  # 打包构建配置
│   │   ├── bin/              # npx 一键安装入口
│   │   ├── marketplace/      # Codex local marketplace
│   │   └── install.sh        # npx / 源码共用安装脚本
│   ├── plugin-claude-compat/
│   │   ├── src/index.ts      # CLI 入口：stdin hook → IngestEvent → POST（runtime / PLUGIN_ROOT 区分产品）
│   │   ├── src/transform.ts  # SessionStart / UserPrompt / PostToolUse / Stop 映射
│   │   ├── src/transcript.ts # transcript JSONL → assistant / tool / turn
│   │   ├── marketplace/      # Claude / CodeBuddy / WorkBuddy local marketplace
│   │   ├── bin/              # npx 一键安装入口
│   │   └── install.sh        # marketplace add + plugin install（--runtime / --uninstall）
│   └── plugin-grok/
│       ├── src/index.ts      # CLI 入口：stdin hook → IngestEvent → POST
│       ├── src/transform.ts  # SessionStart / UserPrompt / PostToolUse / Stop 映射
│       ├── src/session.ts    # ~/.grok/sessions → assistant / tool / turn / cost
│       ├── hooks/            # runmark-tracker.json 模板
│       ├── bin/              # npx 一键安装入口
│       └── install.sh        # 写入 ~/.grok/hooks（与 Orca 等共存）
```

## 常用命令

```bash
# 根目录
bun install
bun test                    # 全量测试（当前 15 个）

# 启动服务
cd packages/server && bun dev
# → http://localhost:3456/  Dashboard
# → http://localhost:3456/health

# 构建 / 发布插件（改 src 后必做）
cd packages/plugin-opencode
bun run build                      # tsdown → dist/
# 然后重启 OpenCode

# 本机客户端统一入口（推荐；含 Cursor / OpenCode / Codex / Claude 系 / Grok）
npx @runmark/runmark --clients all
# 或按需：npx @runmark/runmark --clients cursor,codex,workbuddy,grok

# 单包排障 / 源码调试（可选）
npx @runmark/codex-plugin
cd packages/plugin-codex && bash install.sh
cd packages/plugin-claude-compat && bash install.sh --runtime claude
cd packages/plugin-grok && bash install.sh
```


## CI / 发布（GitHub Actions）

| 产物 | 标签 | Workflow | 备注 |
|------|------|----------|------|
| PR / main 检查 | — | `.github/workflows/ci.yml` | `bun install` → build → test |
| npm 客户端 | `npm-v*` | `.github/workflows/npm-release.yml` | 需 Secret `NPM_TOKEN`；`changeset publish` |
| Server 包 + Docker + Release | `server-vX.Y.Z` | `.github/workflows/server-release.yml` | 标签版本 = `packages/server/package.json`；镜像 `ghcr.io/yee94/runmark/runmark-server` |

详情见 [DEPLOY.md](DEPLOY.md)。自动更新默认 manifest：`https://github.com/yee94/runmark/releases/latest/download/server-manifest.json`。

## 环境变量

### Server (`packages/server`)

| 变量 | 默认 | 说明 |
|------|------|------|
| `AGENT_TRACKER_PORT` | `3456` | 端口 |
| `AGENT_TRACKER_API_KEY` | `dev-key-change-me` | ingest / 写 pricing 鉴权 |
| `AGENT_TRACKER_DB_PATH` | `data/agent-tracker.db` | SQLite 路径 |
| `AGENT_TRACKER_PUBLIC_DASHBOARD` | `false` | 为 `true` 时 Dashboard 免登录（仅本地开发） |
| `AGENT_TRACKER_DEBUG` | `false` | 文件日志开关 |
| `AGENT_TRACKER_LOG_FILE` | `data/agent-tracker.log` | 服务日志 |

### Plugin（`~/.config/agent-tracker/env`，启动时自动读取）

| 键名 | 默认 | 说明 |
|------|------|------|
| `endpoint` | `http://localhost:3456` | 上报地址（兼容 `AGENT_TRACKER_ENDPOINT`） |
| `apiKey` | `dev-key-change-me` | 访问密码（兼容 `AGENT_TRACKER_API_KEY`） |
| `debug` | `false` | 文件日志开关 |
| `logFile` | `~/.config/agent-tracker/plugin.log` | 插件日志 |
| `includeMessages` | `true` | 是否上报消息正文 |
| `includeToolOutput` | `true` | 是否上报 tool 输出 |

进程环境变量若已设置，优先于配置文件。无需修改 `~/.zshrc`。

### OpenCode 插件注册

`npx @runmark/runmark --clients opencode` 会 **patch**（非覆写）`~/.config/opencode/opencode.jsonc` 的 `plugin` 数组；已有注释、其它插件、顶层字段与 symlink 必须保留。

`opencode.jsonc` 示例：

```jsonc
"plugin": ["@runmark/opencode-plugin"]
```

改 `src/index.ts` 后必须 rebuild `dist/index.js` 并重启 OpenCode。

### Codex 插件注册

Codex 插件通过命令行 hook 上报数据，每个 hook 事件对应一个 stdin/stdout JSON 命令：

| Codex Hook 事件 | 映射 IngestEvent | 说明 |
|----------------|-----------------|------|
| `SessionStart` (startup) | `session.created` | 新会话，含 git 元信息 |
| `SessionStart` (resume/clear/compact) | `session.compacted` | 会话恢复/压缩 |
| `UserPromptSubmit` | `message` (user) | 用户发送消息 |
| `PostToolUse` | `tool.result` | 工具执行完成 |
| `Stop` | `session.idle` + `message` (assistant) | 会话结束 |

Codex Hook 的 stdin 只提供基础事件；插件在 `Stop` 阶段读取 rollout JSONL，补齐 assistant 回复、tool 调用结果、turn token 与费用估算。

改 `src/` 下文件后需 rebuild 并重装：
```bash
cd packages/plugin-codex && bash install.sh
```

### Claude Code / CodeBuddy / WorkBuddy 插件注册

三个产品各自独立接入；共用安装包与 marketplace 插件，但必须按产品指定 `--runtime`。安装走官方 `plugin marketplace`（可 `plugin uninstall`），Dashboard 帮助中心分三篇（`claude.md` / `codebuddy.md` / `workbuddy.md`）。

| 产品 | `--runtime` | CLI / 安装位置 | 上报 `agent` |
|------|-------------|----------------|--------------|
| Claude Code（含 TClaude） | `claude` | `tclaude`/`claude` → `~/.tclaude` 或 `~/.claude` | `claude` |
| CodeBuddy | `codebuddy` | `codebuddy` → `~/.codebuddy` | `codebuddy` |
| WorkBuddy | `workbuddy` | Desktop 内嵌 CLI + `CODEBUDDY_CONFIG_DIR=~/.workbuddy` | `workbuddy` |

本地 marketplace：`~/.config/agent-tracker/claude-compat-marketplace/`。

| Hook 事件 | 映射 IngestEvent | 说明 |
|----------|-----------------|------|
| `SessionStart` (startup) | `session.created` | 新会话，含 git 元信息 |
| `SessionStart` (resume/clear/compact) | `session.compacted` | 会话恢复/压缩 |
| `UserPromptSubmit` | `message` (user) | 用户发送消息 |
| `PostToolUse` | `tool.result` | 工具执行完成（跳过 Read/Write/Shell\|Bash/Grep） |
| `Stop` / `SessionEnd` | transcript → assistant / tool / `turn.completed` + `session.idle` | 读 JSONL 补齐 token |

`Stop` 的 stdin 通常不含 token；插件读取 `transcript_path`，从 assistant `message.usage`（或 CodeBuddy 原生字段）提取用量，并用本地 offset 状态避免重复上报。

改 `src/` 后需 rebuild 并按产品重装（幂等）：
```bash
cd packages/plugin-claude-compat && bash install.sh --runtime claude   # 或 codebuddy / workbuddy / all
```

### Grok Build 插件注册

Grok Build（`grok` CLI）通过**用户级 Hooks** 上报，hook 文件写入 `~/.grok/hooks/runmark-tracker.json`，可与 Orca / Asymptote 等其它 JSON 共存。安装落点：`~/.config/agent-tracker/grok-plugin/`。

| Grok Hook 事件 | 映射 IngestEvent | 说明 |
|---------------|-----------------|------|
| `SessionStart` | `session.created` | 新会话，含 git 元信息 |
| `UserPromptSubmit` | `message` (user) | 用户发送消息 |
| `PostToolUse` | `tool.result` | 工具执行完成（跳过 Read/Write/Shell 等） |
| `PostToolUseFailure` | `tool.result` (error) | 工具失败 |
| `Stop` / `StopFailure` / `SessionEnd` | session 文件 → assistant / tool / `turn.completed` + `session.idle` | 读 `~/.grok/sessions` 补齐 token / cost |

`Stop` 的 stdin 通常不含完整 token；插件解析 `summary.json`、`chat_history.jsonl`、`updates.jsonl`、`events.jsonl`。费用优先用 Grok 原生 `costUsdTicks / 1e9`，否则 server 侧按 `xai`/`grok` 定价估算。上报 `agent=grok`，provider 默认 `xai`。

改 `src/` 后需 rebuild 并重装：
```bash
cd packages/plugin-grok && bun run build && bash install.sh
# 或：npx @runmark/runmark --clients grok
```

用户级 hooks 一般无需 `/hooks-trust`（项目级 `.grok/hooks` 才需要）。装完后**新开 Grok 会话**即可；可用 `grok inspect --json` 确认 hooks 含 runmark。

## 数据流与关键设计

### Ingest 事件类型

| type | 含义 |
|------|------|
| `session.created` | 新会话 |
| `session.idle` | 会话结束 |
| `message` | user / assistant 消息 |
| `turn.completed` | LLM 一轮完成（token + cost） |
| `turn.error` | LLM 失败 |
| `tool.result` | 工具执行结果（仍入库，Dashboard 已隐藏工具统计） |

### Ingest 顺序问题（已修复）

子事件可能早于 `session.created` 到达 → `ingest.ts` 的 `ensureSession()` 做 upsert，不能假设 session 已存在。

### Plugin 采集要点（`packages/plugin-opencode/src/index.ts`）

- **用户消息**：`chat.message` + `extractTextFromParts()`，禁止对 `UserMessage` 做 `JSON.stringify`
- **Turn**：仅在 `message.updated` 且 `assistant` 的 `time.completed` 存在时记录；使用 `msg.cost` 与 `msg.tokens`
- **兜底**：`message.part.updated` 的 `step-finish` 也可产生 turn
- **垃圾过滤**：Dashboard 侧 `isGarbageMessage()` 过滤历史元数据 JSON
- **上报**：关键事件后 `flush()`；`session.idle` 时也会 flush
- **配置**：启动时自动读取 `~/.config/agent-tracker/env`（`process.env` 优先），无需 shell 注入

### Cost

- 插件可带 `cost_usd`（OpenCode 计算值）
- 否则 server 用 `shared` 的 `DEFAULT_PRICING` + `computeCost()` 按 provider/model 估算

## Dashboard（`public/index.html`）

**改 UI 前必读 Skill**：`.cursor/skills/eficy-shadcn/SKILL.md`

### 设计约定

- 暗色 PC 后台：顶栏 + 侧栏 + 宽内容区 + KPI 四列
- 参考过 `langfuse-analyze-agent/skills/html-debug-report/examples/cases` 的密集 trace 行（`h-8` 风格），会话详情为左右分栏调用链
- **不要**恢复「工具统计」Tab（用户已明确不需要）
- **不要**展示 `project_name`（用户已明确不需要；DB 字段可保留）

### Hash 路由

| Hash | 页面 |
|------|------|
| `#/summary` | 总览 |
| `#/models` | 模型统计 |
| `#/sessions` | 会话列表 |
| `#/sessions/{id}` | 会话详情（密集 trace） |

### 统计筛选

KPI 与模型表共用 query：

- `range`: `today` \| `24h` \| `7d` \| `month` \| `all`
- `sort`: `tokens` \| `cost`（倒序，server 侧 `ORDER BY`）

示例：`GET /v1/stats/by-model?range=7d&sort=cost`

### Token 分项

Turn 与统计 API 区分五类 token（与 OpenCode `msg.tokens` 对齐）：

| 字段 | 含义 |
|------|------|
| `input_tokens` | 非缓存输入 |
| `cache_read_tokens` | 缓存读取（cached input） |
| `cache_write_tokens` | 缓存写入 |
| `output_tokens` | 输出 |
| `reasoning_tokens` | 推理（o 系列等） |

`/v1/stats/summary` 的 `tokens` 对象含 `input` / `cache_read` / `cache_write` / `output` / `reasoning` / `total`；`/v1/stats/by-model` 每行含对应 `*_tokens` 聚合。Dashboard 用颜色区分：蓝=In、橙=Cache读、黄=Cache写、绿=Out、紫=Reason。

### 调用链图例

- 蓝点：user 消息
- 紫点：assistant 消息
- 绿点：**LLM 推理 Turn**（token/费用单元，不是对话正文）
- 黄点：用户 Abort（`finish_reason`/`error` = `aborted`）
- 红点：失败的 Turn（API Error、0 token 脏数据等）

## API 速查

| 方法 | 路径 | 鉴权 |
|------|------|------|
| POST | `/v1/ingest` | API Key |
| GET | `/v1/sessions` | 公开（默认） |
| GET | `/v1/sessions/:id/messages` | 公开 |
| GET | `/v1/sessions/:id/turns` | 公开 |
| GET | `/v1/stats/summary?range=&sort=` | 公开 |
| GET | `/v1/stats/by-model?range=&sort=` | 公开 |
| PUT | `/v1/pricing` | API Key |
| GET | `/health` | 公开 |

Header：`X-API-Key: <key>` 或 `Authorization: Bearer <key>`

## 测试

```bash
bun test
```

覆盖：ingest upsert、cost 计算、API 集成、stats 时间过滤、TrackerClient 缓冲。

新增 ingest / stats 行为时请补 `packages/server/__tests__/`。

## 调试清单

1. Server 是否运行：`curl localhost:3456/health`
2. 插件日志：`~/.config/agent-tracker/plugin.log`
3. Server 日志：`packages/server/data/agent-tracker.log`
4. DB：`sqlite3 packages/server/data/agent-tracker.db`
5. 插件是否 rebuild + OpenCode 是否重启
6. Dashboard 硬刷新（单 HTML 无构建，改完即生效）

## 代码规范（用户要求）

- **不要修改**原有注释（前辈注释保留）
- 新方法注释风格与现有文件一致
- 改动保持最小 diff，不要过度抽象
- 未要求不要 `git commit`

## 项目 Skills

| Skill | 路径 | 何时用 |
|-------|------|--------|
| **eficy-shadcn** | `.cursor/skills/eficy-shadcn/SKILL.md` | 改 `public/index.html`、新建 Eficy 单页 UI |
| **agent-tracker-api** | `skills/agent-tracker-api/SKILL.md` | curl 拉 session 上下文、时间段统计、Agent 遥测分析 |
| **agent-tracker-setup** | `skills/agent-tracker-setup/SKILL.md` | 服务端部署、health 验证、交付 Dashboard |
| **agent-tracker-clients** | `skills/agent-tracker-clients/SKILL.md` | 本机安装 / 更新；优先 `npx @runmark/runmark --clients …` |

来源：`langfuse-analyze-agent/.agents/skills/eficy-shadcn`（已完整复制到本仓库）。

## 已知限制 / 后续方向

- [x] Claude Code / CodeBuddy / WorkBuddy Plugin Marketplace（`packages/plugin-claude-compat`）
- [x] Grok Build 用户级 Hooks（`packages/plugin-grok`）
- [ ] 会话列表未按 stats `range` 过滤（仅 KPI/模型表过滤）
- [ ] 旧会话可能有 0-token 脏 turn（插件修复前数据）；新数据正常

## 接手任务时的推荐顺序

1. `bun test` 确认基线
2. `cd packages/server && bun dev` 起服务
3. 读 `packages/shared/src/index.ts` 理解合约
4. 改 UI → 读 **eficy-shadcn** skill，只动 `public/index.html`
5. 改采集 → `plugin-opencode` / `plugin-codex` / `plugin-claude-compat` / `plugin-grok` → rebuild + 重装对应客户端
6. 改存储/统计 → `server/src/services/` + 补测试
