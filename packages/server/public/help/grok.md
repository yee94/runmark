# Grok Build 安装配置

Grok Build（`grok` CLI）通过用户级 Hooks 接入 Runmark。安装包为 `@runmark/grok-plugin`，写入 `~/.grok/hooks/runmark-tracker.json`，与 Orca / Asymptote 等其它 hook 文件共存。`Stop` 阶段读取 `~/.grok/sessions/...` 补齐 assistant、tool、token 与费用。

安装前请先完成“统一接入配置”，确保 `~/.config/agent-tracker/env` 中已经配置 `endpoint` 和 `apiKey`。

## 一键安装

推荐使用统一入口：

```bash
npx @runmark/runmark --clients grok
```

或单独安装：

```bash
npx @runmark/grok-plugin
```

安装脚本会（可重复执行，幂等升级）：

1. 构建 / 复制 `dist/index.mjs` 到 `~/.config/agent-tracker/grok-plugin/`。
2. 生成可执行 wrapper：`grok-tracker-hook`。
3. 写入用户级 hook：`~/.grok/hooks/runmark-tracker.json`。

## 本仓库源码安装

```bash
cd packages/plugin-grok
bash install.sh
```

## 卸载

```bash
npx @runmark/grok-plugin --uninstall
# 或
bash install.sh --uninstall
```

## 信任 Hook / 重启

用户级 `~/.grok/hooks/` 一般无需 `/hooks-trust`（项目级 `.grok/hooks` 才需要）。安装后请**重启 Grok 或新开会话**，让 hook 重新加载。

可用以下命令确认：

```bash
grok inspect --json
# 应能看到 runmark-tracker / grok-tracker-hook
```

## 事件说明

- **SessionStart (startup)**：延迟建库，等首条真实用户输入
- **SessionStart (resume/clear/compact)**：`session.compacted`
- **UserPromptSubmit**：`session.created` + `message` (user)
- **PostToolUse**：`tool.result`（跳过 Read/Write/Shell/Bash/Grep 及 Grok 的 `read_file` / `run_terminal_command` 等）
- **PostToolUseFailure**：`tool.result`（带 error）
- **Stop / SessionEnd**：本地 session 文件 → assistant / tool / `turn.completed` + `session.idle`
- **StopFailure**：`turn.error` + `session.idle`

## 常见问题

- 没有 token / cost：确认 `Stop` 后 `~/.grok/sessions/<cwd>/<sessionId>/updates.jsonl` 含 `usage`（`inputTokens` / `costUsdTicks`）。
- Hook 无响应：确认本机有 Bun 或 Node；`~/.config/agent-tracker/grok-plugin/grok-tracker-hook` 可执行。
- 与 Orca 冲突：不会。各自独立 JSON 文件（`runmark-tracker.json` vs `orca-status.json`）。
- ingest 401：对齐 `~/.config/agent-tracker/env` 的 `apiKey` 与服务端 `AGENT_TRACKER_API_KEY`。
- Dashboard：会话页筛选 `agent=grok`。
