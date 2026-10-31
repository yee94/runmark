# WorkBuddy 安装配置

WorkBuddy 通过 **Plugin Marketplace** 安装 Runmark 插件。安装包为 `@runmarks/claude-compat-plugin`，使用 `--runtime workbuddy`。`Stop` 阶段读取 `~/.workbuddy/projects/...` 下的 transcript JSONL，补齐 assistant、tool、token，并由服务端估算费用。

安装前请先完成“统一接入配置”，确保 `~/.config/runmark/env` 中已经配置 `RUNMARK_ENDPOINT` 和 `RUNMARK_API_KEY`。

## 一键安装

```bash
npx @runmarks/claude-compat-plugin --runtime workbuddy
```

安装脚本会（可重复执行，幂等升级）：

1. 构建插件并整目录刷新本地 Runmark marketplace。
2. WorkBuddy Desktop 内嵌 CLI（注入 `ACC_PRODUCT_CONFIG_PATH` + `CODEBUDDY_CONFIG_DIR=~/.workbuddy`）执行 `plugin marketplace remove/add` + `install` + `enable`。
3. 合并 `enabledPlugins["runmark-tracker@runmark"]=true`（保留用户其它插件）。

## 本仓库源码安装

```bash
cd packages/plugin-claude-compat
bash install.sh --runtime workbuddy
```

## 卸载

```bash
bash install.sh --uninstall --runtime workbuddy
# 或
workbuddy plugin uninstall runmark
```

## 信任 Hook / 重启

若 WorkBuddy 提供 `/hooks` 或 `/plugin` 面板，请审查并信任 Runmark 插件 hooks。然后重启 WorkBuddy（或 `/reload-plugins` / 新开会话）。

## 事件说明

- **SessionStart (startup)**：`session.created`
- **SessionStart (resume/clear/compact)**：`session.compacted`
- **UserPromptSubmit**：`message` (user)
- **PostToolUse**：`tool.result`（跳过 Read/Write/Shell/Bash/Grep）
- **Stop / SessionEnd**：transcript → assistant / tool / `turn.completed` + `session.idle`

## 常见问题

- 没有 token / cost：确认 `transcript_path` 存在，且 Stop 后 JSONL 中含 usage。
- 重复 turn：插件会按 transcript offset 增量读取。
- ingest 401：对齐 `~/.config/runmark/env` 的 `RUNMARK_API_KEY` 与服务端 `RUNMARK_API_KEY`。
- 本机无独立 `workbuddy` CLI 时，安装脚本会使用 WorkBuddy.app 内嵌 CLI（`ACC_PRODUCT_CONFIG_PATH` + `CODEBUDDY_CONFIG_DIR=~/.workbuddy`）。
- 需要 Claude Code：见帮助中心「Claude Code」一文。
- 需要 CodeBuddy：见帮助中心「CodeBuddy」一文。
