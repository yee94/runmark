# CodeBuddy 安装配置

CodeBuddy 通过 **Plugin Marketplace** 安装 Runmark 插件。安装包为 `@runmark/claude-compat-plugin`，使用 `--runtime codebuddy`。`Stop` 阶段读取 `~/.codebuddy/projects/...` 下的 transcript JSONL，补齐 assistant、tool、token，并由服务端估算费用。

安装前请先完成“统一接入配置”，确保 `~/.config/agent-tracker/env` 中已经配置 `endpoint` 和 `apiKey`。

## 一键安装

```bash
npx @runmark/claude-compat-plugin --runtime codebuddy
```

安装脚本会（可重复执行，幂等升级）：

1. 构建插件并整目录刷新本地 marketplace：`~/.config/agent-tracker/claude-compat-marketplace/`。
2. `codebuddy plugin marketplace remove/add` + `plugin uninstall/install` + `enable`。
3. 合并 `enabledPlugins["runmark-tracker@runmark"]=true`（保留用户其它插件）。

## 本仓库源码安装

```bash
cd packages/plugin-claude-compat
bash install.sh --runtime codebuddy
```

## 卸载

```bash
bash install.sh --uninstall --runtime codebuddy
# 或
codebuddy plugin uninstall runmark
```

## 信任 Hook / 重启

若 CodeBuddy 提供 `/hooks` 或 `/plugin` 面板，请审查并信任 Runmark 插件 hooks。然后重启 CodeBuddy（或 `/reload-plugins` / 新开会话）。

## 事件说明

- **SessionStart (startup)**：`session.created`
- **SessionStart (resume/clear/compact)**：`session.compacted`
- **UserPromptSubmit**：`message` (user)
- **PostToolUse**：`tool.result`（跳过 Read/Write/Shell/Bash/Grep）
- **Stop / SessionEnd**：transcript → assistant / tool / `turn.completed` + `session.idle`

## 常见问题

- 没有 token / cost：确认 `transcript_path` 存在，且 Stop 后 JSONL 中含 usage（CodeBuddy 常见为顶层 `type=message` + `message.usage` / `providerData`）。
- 重复 turn：插件会按 transcript offset 增量读取。
- ingest 401：对齐 `~/.config/agent-tracker/env` 的 `apiKey` 与服务端 `AGENT_TRACKER_API_KEY`。
- 插件未生效：`codebuddy plugin marketplace list` 应含 `runmark`；`settings.json` 的 `enabledPlugins` 应含 `runmark-tracker@runmark: true`。
- 需要 Claude Code：见帮助中心「Claude Code」一文。
- 需要 WorkBuddy：见帮助中心「WorkBuddy」一文。
