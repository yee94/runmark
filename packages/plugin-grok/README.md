# Runmark — Grok Build CLI 插件

将 [Grok Build](https://x.ai/cli)（`grok`）编码会话遥测上报到 [Runmark](../../README.md) 服务中心，与 OpenCode / Codex / Claude 等客户端共用同一 Dashboard。

## 工作原理

```
[Grok Build CLI]
  └── ~/.grok/hooks/runmark-tracker.json
        └── grok-tracker-hook <event>
              ├── stdin JSON → transform → POST /v1/ingest
              └── Stop 时读 ~/.grok/sessions/... 补齐 token / cost
```

Grok 官方支持 **Hooks**（command / http），用户级 hook 文件放在 `~/.grok/hooks/*.json`，可与 Orca、Asymptote 等其它 hook 文件共存。

## Hook 事件映射

| Grok Hook | 上报事件 | 说明 |
|-----------|----------|------|
| `SessionStart` (startup) | （延迟） | 等首条真实 `UserPromptSubmit` 再建会话 |
| `SessionStart` (resume/clear/compact) | `session.compacted` | 恢复 / 压缩 |
| `UserPromptSubmit` | `session.created` + `message` (user) | 首条真实用户输入 |
| `PostToolUse` | `tool.result` | 跳过 Read/Write/Shell/Grep 等高频噪声 |
| `PostToolUseFailure` | `tool.result` (error) | 工具失败 |
| `Stop` / `SessionEnd` | session 文件补齐 + `session.idle` | assistant / tool / `turn.completed` |
| `StopFailure` | `turn.error` + `session.idle` | API 失败 |

## 本地 session 补齐

Grok Hook stdin 通常不含完整 token。插件在 `Stop` 时读取：

```
~/.grok/sessions/<url-encoded-cwd>/<sessionId>/
  summary.json
  chat_history.jsonl
  updates.jsonl      # usage: inputTokens / cachedReadTokens / costUsdTicks
  events.jsonl
```

`costUsdTicks` 按 `ticks / 1e9` 换算为 USD；也可由服务端按 `DEFAULT_PRICING`（provider=`xai`）估算。

## 安装

### 前置

- [Bun](https://bun.sh/) ≥ 1.1（或 Node ≥ 18）
- Grok Build CLI（`grok`）
- Runmark Server 已部署

### 统一入口（推荐）

```bash
npx @runmarks/runmark --clients grok
```

### 单包安装

```bash
npx @runmarks/grok-plugin
```

安装脚本会：

1. 复制 `dist/index.mjs` 到 `~/.config/agent-tracker/grok-plugin/`
2. 生成可执行 `grok-tracker-hook`
3. 写入 `~/.grok/hooks/runmark-tracker.json`

### 源码安装

```bash
cd packages/plugin-grok
bash install.sh
```

### 卸载

```bash
npx @runmarks/grok-plugin --uninstall
# 或
bash install.sh --uninstall
```

## 配置

与其它客户端共用 `~/.config/agent-tracker/env`：

```bash
AGENT_TRACKER_ENDPOINT="http://localhost:3456"
AGENT_TRACKER_API_KEY="dev-key-change-me"
# 可选
AGENT_TRACKER_DEBUG=true
```

## 验证

```bash
# 确认 hook 已加载
grok inspect --json | head

# 冒烟
echo '{"sessionId":"test","hookEventName":"UserPromptSubmit","prompt":"hi","cwd":"'"$PWD"'"}' \
  | ~/.config/agent-tracker/grok-plugin/grok-tracker-hook user-prompt
```

装完后**重启 Grok 或新开会话**。用户级 hooks 一般无需 `/hooks-trust`（项目级 `.grok/hooks` 才需要）。

## 常见问题

- **没有 token / cost**：确认 `Stop` 后 `~/.grok/sessions/.../updates.jsonl` 含 `usage`；开启 `AGENT_TRACKER_DEBUG=true` 看 `~/.config/agent-tracker/plugin.log`。
- **与 Orca 冲突**：不会。各自 JSON 文件并存（`runmark-tracker.json` vs `orca-status.json`）。
- **ingest 401**：对齐 `apiKey` 与服务端 `AGENT_TRACKER_API_KEY`。
- **Dashboard 看不到**：会话页筛选 `agent=grok`。
