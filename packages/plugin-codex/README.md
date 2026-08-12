# Runmark — Codex CLI 插件

将 Codex CLI 的编码会话遥测数据上报到 [Runmark](../../README.md) 服务中心，与 OpenCode 插件共用同一套 Dashboard。

## 工作原理

```
[Codex CLI] ──hooks.json──▶ [codex-tracker-hook] ──stdin JSON──▶ [Bun CLI]
                                  │                                    │
                                  ▼                                    ▼
                          hook 事件分发                        transform → POST /v1/ingest
                          (session-start / user-prompt           ──────────────▶ [Runmark Server]
                           post-tool-use / stop)
```

Codex 通过 **stdin/stdout 命令行钩子** 触发上报脚本。每个 hook 事件 Codex 会向脚本 stdin 传入一个 JSON 对象，脚本处理后 POST 到 Runmark 服务器。

## Hook 事件映射

| Codex Hook | 匹配条件 | 上报事件 | 说明 |
|------------|---------|----------|------|
| `SessionStart` | `startup` | `session.created` | 新会话（含 git 仓库/分支/作者） |
| `SessionStart` | `resume` / `clear` / `compact` | `session.compacted` | 会话恢复或压缩 |
| `UserPromptSubmit` | — | `message` (user) | 用户发送的 prompt 文本 |
| `PostToolUse` | — | `tool.result` | 工具执行完成（名称、参数、输出） |
| `Stop` | — | `session.idle` + `message` (assistant) | 会话结束 + 最后一条 assistant 回复 |

## 已知限制

Codex Hook stdin 只提供基础事件。插件在 `Stop` 阶段读取 rollout JSONL，补齐：

- ✅ assistant 回复正文
- ✅ tool 调用与输出
- ✅ `turn.completed` token 分项
- ✅ server 端按 token 与模型估算 cost

## 安装

### 前置条件

- [Bun](https://bun.sh/) ≥ 1.1
- Codex CLI（`npm install -g @openai/codex` 或 `brew install --cask codex`）
- Runmark Server 已部署（[部署指南](../../README.md)）

### npx 一键安装

```bash
npx @runmarks/codex-plugin
```

安装脚本会自动完成：

1. 复制包内 marketplace 到 `~/.codex/agent-tracker-marketplace`
2. 生成带绝对路径的 `hooks.json`
3. 注册 Codex marketplace：`agent-tracker`
4. 安装并启用插件：`agent-tracker@agent-tracker`

### 源码安装

```bash
cd packages/plugin-codex
bash install.sh
```

如果已有 agent-tracker 仓库，直接进入 plugin-codex 目录执行 install.sh。

从零安装：

```bash
git clone https://github.com/yee94/runmark.git /tmp/agent-tracker-codex && \
  cd /tmp/agent-tracker-codex && bun install && \
  cd packages/plugin-codex && bash install.sh && \
  rm -rf /tmp/agent-tracker-codex
```

安装后文件结构：

```
~/.codex/agent-tracker-marketplace/
├── .agents/plugins/marketplace.json
└── plugins/agent-tracker/
    ├── .codex-plugin/plugin.json
    ├── hooks/hooks.json
    └── dist/
        ├── index.mjs
        └── codex-tracker-hook
```

### 信任 Hook

Codex 的 hook 需要用户审查后才能运行。在 Codex 中使用 `/hooks` 命令查看待信任的 hook，确认无误后信任。

### 配置上报地址

插件与 OpenCode 共用 `~/.config/agent-tracker/env`：

```bash
# ~/.config/agent-tracker/env
endpoint="http://<服务地址>:3456"
apiKey="<API Key>"
```

> 也兼容 `AGENT_TRACKER_ENDPOINT` / `AGENT_TRACKER_API_KEY` 环境变量格式。

## 验证

### 手动测试 hook

```bash
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}' \
  | ~/.codex/agent-tracker-marketplace/plugins/agent-tracker/dist/codex-tracker-hook session-start
```

返回 `{}` 即为正常（hook 不阻塞 Codex 主流程）。

### 查看 Dashboard

打开 `http://<ENDPOINT>/`，在会话列表中筛选 `agent=codex` 确认数据已上报。

## 开发

### 修改源码后重新安装

```bash
cd packages/plugin-codex
bash install.sh      # 自动 build + 安装到 ~/.codex/plugins/
```

### 调试

启用 debug 日志：

```bash
# ~/.config/agent-tracker/env
debug=true
logFile=~/.config/agent-tracker/codex-hook.log
```

### 包结构

```
packages/plugin-codex/
├── bin/
│   └── agent-tracker-codex-install.js # npx 入口
├── src/
│   ├── index.ts           # CLI 入口（#!/usr/bin/env bun），从 stdin 读 JSON 分发
│   ├── config.ts          # 配置加载，复用 shared 的 env-file 逻辑
│   ├── transform.ts       # Codex hook stdin JSON → IngestEvent 转换
│   ├── send.ts            # HTTP POST /v1/ingest（5s 超时，静默失败）
│   ├── git.ts             # Git 元信息采集（Bun.spawn）
│   └── transcript.ts      # 解析 Codex rollout JSONL，补齐 assistant/tool/token
├── marketplace/           # Codex local marketplace
├── install.sh             # npx / 源码共用安装脚本
├── package.json
├── tsconfig.json
└── tsdown.config.ts       # tsdown 打包，onlyBundle @agent-tracker/shared
```

### 构建配置

`tsdown.config.ts` 将 `@agent-tracker/shared` bundle 进 `dist/index.mjs`，使 hook 脚本零外部依赖、可独立运行。

## 与 OpenCode 插件的对比

| | OpenCode Plugin | Codex Plugin |
|--|----------------|--------------|
| **安装方式** | npm 包（`@runmarks/opencode-plugin`） | npm 包（`npx @runmarks/codex-plugin`） |
| **运行方式** | OpenCode 进程内 JS 插件 | 独立进程（stdin/stdout JSON 命令行） |
| **事件上报** | 6 个 hook（session/message/turn/tool） | Hook + rollout JSONL（session/message/turn/tool） |
| **token/cost** | ✅ 完整采集 | ✅ 通过 rollout JSONL 解析 |
| **适用场景** | OpenCode 编码时自动上报 | Codex CLI 编码时自动上报 |

## License

MIT
