# Runmark — Claude Code / CodeBuddy / WorkBuddy Plugin

通过官方 **plugin marketplace** 安装，可随时卸载。

| 产品 | 命令 | CLI | Dashboard `agent` |
|------|------|-----|-------------------|
| Claude Code（含 TClaude） | `--runtime claude` | `tclaude` / `claude` | `claude` |
| CodeBuddy | `--runtime codebuddy` | `codebuddy` | `codebuddy` |
| WorkBuddy | `--runtime workbuddy` | WorkBuddy.app 内嵌 CLI | `workbuddy` |

## 安装

### 前置条件

- **Bun ≥ 1.1 或 Node ≥ 18**（hook 启动器优先 bun，缺失回退 node）
- 对应产品 CLI（`claude` / `tclaude` / `codebuddy` / WorkBuddy App）
- Runmark Server 已部署

```bash
# Claude Code
npx @runmarks/claude-compat-plugin --runtime claude

# CodeBuddy
npx @runmarks/claude-compat-plugin --runtime codebuddy

# WorkBuddy
npx @runmarks/claude-compat-plugin --runtime workbuddy
```

本仓库源码：

```bash
cd packages/plugin-claude-compat
bash install.sh --runtime codebuddy
```

安装后会（可重复执行，幂等升级）：

1. 构建 `dist/` 并整目录刷新本地 marketplace
2. `plugin marketplace remove/add` + `plugin uninstall/install` + `enable`
3. 合并 `enabledPlugins["runmark-tracker@runmark"]=true`（保留用户其它插件）

## 卸载

```bash
npx @runmarks/claude-compat-plugin --uninstall --runtime codebuddy
# 或源码：
bash install.sh --uninstall --runtime codebuddy
# 或：
codebuddy plugin uninstall runmark
```

## 配置

与其它客户端共用 `~/.config/agent-tracker/env`：

```bash
endpoint="http://localhost:3456"
apiKey="dev-key-change-me"
```

## 事件映射

| Hook | Ingest |
|------|--------|
| SessionStart (startup) | `session.created` |
| SessionStart (resume/clear/compact) | `session.compacted` |
| UserPromptSubmit | `message` (user) |
| PostToolUse | `tool.result`（跳过 Read/Write/Shell\|Bash/Grep） |
| Stop / SessionEnd | transcript → assistant / tool / `turn.completed` + `session.idle` |

## 验证

```bash
HOOK=~/.config/agent-tracker/claude-compat-marketplace/plugins/runmark-tracker/dist/claude-compat-tracker-hook
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"'"$HOME"'/.codebuddy"}' | $HOOK session-start
```

帮助中心分篇：`packages/server/public/help/claude.md` / `codebuddy.md` / `workbuddy.md`。
