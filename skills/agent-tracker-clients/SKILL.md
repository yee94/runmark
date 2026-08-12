---
name: agent-tracker-clients
description: >-
  安装或更新本机 Runmark 客户端。统一入口 npx @runmarks/runmark --clients …，覆盖
  Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build。
  先引导用户选择要装哪些 Client，再按选择新装/升级；覆盖统一 env、冒烟验证与重启提醒。
  触发词：npx runmark、安装 cursor hook、更新 opencode 插件、升级 codex plugin、
  安装 codebuddy / workbuddy、claude code tracker、安装 grok hook、Grok Build tracker、
  更新 agent-tracker 客户端、重装 hooks。
---

# Runmark — 客户端安装 / 更新 Skill

本 Skill 让 Agent **在本机完成 Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build 客户端接入或升级**。服务端部署请用 [`agent-tracker-setup`](../agent-tracker-setup/SKILL.md)；查会话数据请用 [`agent-tracker-api`](../agent-tracker-api/SKILL.md)。

## 统一入口（优先）

**未来本机接入都收敛到品牌包 `@runmarks/runmark`**，不要再让用户分别记各子包 `npx`：

```bash
# 交互：探测本机 + 勾选（已装用户再次运行会预选已装并更新）
npx @runmarks/runmark
# 无交互：只更新已装
npx @runmarks/runmark --clients installed
npx @runmarks/runmark --yes
# 只装已发现宿主 / 显式列表 / 全量
npx @runmarks/runmark --clients detected
npx @runmarks/runmark --clients cursor,codex,workbuddy
npx @runmarks/runmark --clients all
npx @runmarks/runmark --clients codebuddy --uninstall
```

| 客户端 | 子包（由 `@runmarks/runmark` 编排） | 安装位置 |
|--------|--------------------------------------|----------|
| Cursor | `@runmarks/cursor-hooks` | `~/.cursor/hooks/agent-tracker/` + `~/.cursor/hooks.json` |
| OpenCode | `@runmarks/opencode-plugin` | `~/.config/opencode/opencode.jsonc` + `node_modules` |
| Codex | `@runmarks/codex-plugin` | `~/.codex/agent-tracker-marketplace/` + plugins cache |
| Claude Code | `@runmarks/claude-compat-plugin --runtime claude` | marketplace `runmark-tracker@runmark` |
| CodeBuddy | 同上 `--runtime codebuddy` | 同上 |
| WorkBuddy | 同上 `--runtime workbuddy` | 同上 |
| Grok Build | `@runmarks/grok-plugin` | `~/.config/agent-tracker/grok-plugin/` + `~/.grok/hooks/runmark-tracker.json` |

> Claude Code / CodeBuddy / WorkBuddy 共用 marketplace 插件 **`runmark-tracker@runmark`**，必须按产品分别指定；Dashboard 帮助中心按产品分三篇文章，不要统称。Grok Build 走用户级 Hooks，可与 Orca 等其它 `~/.grok/hooks/*.json` 共存。排障时可直接 `npx` 子包，日常安装请走 `@runmarks/runmark`。

## Agent 工作流（必读）

1. **先问再装**：用户未明确要装哪些客户端时，**必须先列出可选 Client 并请用户勾选**，不要默认 `all` / 不要静默装齐。
2. **优先统一入口**：用户选定后，用 `npx @runmarks/runmark --clients <选中列表>`；若用户说「帮我装一下 / 交互安装」，可直接跑无参数的 `npx @runmarks/runmark`（脚本会探测并交互勾选）。仅在统一入口失败或需要源码调试时，再走下方 §4–§9 子包命令。
3. **新装 vs 更新**：新装先做 §1 统一 env；更新先做 §2 查版本。用户说「全部更新」→ `npx @runmarks/runmark --clients all`（或仓库 `update-all.sh`）。用户说「装本机已有的」→ `--clients detected` / `--yes`。
4. **装完要重启**：交付时明确列出需重启的客户端；Claude 系可用 `/reload-plugins`；Grok Build 新开会话即可。

### 引导话术（复制后按本机情况微调）

> 本机可接入这些 Runmark 客户端插件，你要用哪些？可多选：
>
> 1. **Cursor** — IDE Agent 会话
> 2. **OpenCode** — OpenCode 插件
> 3. **Codex** — Codex Hook 插件
> 4. **Claude Code / TClaude** — marketplace `runmark-tracker@runmark`
> 5. **CodeBuddy**
> 6. **WorkBuddy**
> 7. **Grok Build** — 用户级 `~/.grok/hooks`
>
> 选定后我会执行：`npx @runmarks/runmark --clients <你的选择>`
> 也可以说「只装 Cursor + WorkBuddy」或「全部更新已装的」。
> Claude / CodeBuddy / WorkBuddy 是三个产品，请分别选。

用户已明确（例如「装 WorkBuddy」「更新 Cursor hook」「装 Grok」）则跳过询问，直接 `npx @runmarks/runmark --clients …`。

## 0. 先决条件

1. 服务端已可用：`curl -sS "$ENDPOINT/health"` 返回 `{"status":"ok","version":"..."}`。
2. 已知 Dashboard endpoint 与 API Key（与服务端 `AGENT_TRACKER_API_KEY` 一致）。
3. 本机有 `bun` / `bunx`（Cursor 更新优先用 bunx；Codex hook 运行也依赖 bun）。

若用户未给 endpoint / key，先读已有配置，不要覆盖：

```bash
cat ~/.config/agent-tracker/env 2>/dev/null || true
```

## 1. 统一接入配置（新装必做；更新时核对）

```bash
mkdir -p ~/.config/agent-tracker
# 仅当文件不存在，或用户明确要求改写时写入
cat > ~/.config/agent-tracker/env << 'EOF'
export AGENT_TRACKER_ENDPOINT="http://<服务地址>:3456"
export AGENT_TRACKER_API_KEY="<服务端 API Key>"
EOF
```

兼容短键 `endpoint` / `apiKey`。进程环境变量优先于文件。

可选排障：

```bash
# 追加到 env（不要重复追加）
debug=true
logFile="~/.config/agent-tracker/plugin.log"
```

Cursor Hook 日志默认：`~/.config/agent-tracker/cursor-hook.log`（需 `debug=true`）。

## 2. 查当前版本（更新前）

```bash
# 远端最新
npm view @runmarks/cursor-hooks version
npm view @runmarks/opencode-plugin version
npm view @runmarks/codex-plugin version
npm view @runmarks/claude-compat-plugin version
npm view @runmarks/grok-plugin version

# 本机现状
ls -la ~/.cursor/hooks/agent-tracker/hook.mjs 2>/dev/null
rg -n 'opencode-plugin' ~/.config/opencode/opencode.jsonc 2>/dev/null
python3 -c 'import json,pathlib; p=pathlib.Path.home()/".config/opencode/node_modules/@runmarks/opencode-plugin/package.json"; print(json.loads(p.read_text())["version"] if p.exists() else "missing")'
ls -d ~/.codex/plugins/cache/agent-tracker/agent-tracker/*/ 2>/dev/null
ls -la ~/.config/agent-tracker/claude-compat-marketplace/plugins/runmark-tracker/dist/claude-compat-tracker-hook 2>/dev/null
tclaude plugin list 2>/dev/null | head -20
codebuddy plugin marketplace list 2>/dev/null | head -20
ls -la ~/.grok/hooks/runmark-tracker.json ~/.config/agent-tracker/grok-plugin/grok-tracker-hook 2>/dev/null
```

把目标版本记为 `TARGET`（通常取上述 `npm view` 结果，例如 `0.2.10`）。

## 3. 按选择安装 / 一键更新（推荐）

用户选定客户端后（或明确要求「全部」）：

```bash
# 例：只装 Cursor + Codex + WorkBuddy
npx @runmarks/runmark --clients cursor,codex,workbuddy
# 全部
npx @runmarks/runmark --clients all
```

仓库内等价脚本（会转调同一入口）：

```bash
./skills/agent-tracker-clients/scripts/update-all.sh
# 或：./skills/agent-tracker-clients/scripts/update-all.sh cursor,workbuddy
```

**不要**在用户只说「装一下」时默认 `--clients all`。统一入口失败时，再按 §4–§10 对单个子包排障。

## 4. Cursor Hook

### 新装 / 更新（同一命令）

**优先 bunx**（`npx` 在部分环境下 bin 名解析会失败）：

```bash
bunx --bun @runmarks/cursor-hooks@$TARGET init
```

备选：

```bash
npx --yes -p @runmarks/cursor-hooks@$TARGET agent-tracker-cursor init
```

仅当前项目：

```bash
bunx --bun @runmarks/cursor-hooks@$TARGET init --project
```

### 验证

```bash
# 0.2.1+：sessionStart 应为空分支（不再建库）
rg -n 'case "sessionStart"' -A1 ~/.cursor/hooks/agent-tracker/hook.mjs
# 期望类似：case "sessionStart": break;

printf '%s' '{"hook_event_name":"sessionStart","session_id":"smoke-empty","composer_mode":"agent"}' \
  | bash ~/.cursor/hooks/agent-tracker/run.sh
# exit 0；不应向服务端新建空会话
```

确认 `~/.cursor/hooks.json` 仍含 `./hooks/agent-tracker/run.sh`（合并安装，勿删用户其它 hook）。

**必须重启 Cursor IDE。**

## 5. OpenCode Plugin

### 新装 / 更新（推荐走统一入口）

```bash
npx @runmarks/runmark --clients opencode
```

`@runmarks/runmark` **必须 patch** `~/.config/opencode/opencode.jsonc`（只改 agent-tracker 插件条目），**禁止整文件覆写**——会丢掉其它 plugin / 注释 / Mackup symlink。

手动时同样只 patch `plugin` 数组（建议钉版本），再装依赖：

```jsonc
"@runmarks/opencode-plugin@0.2.10"
```

```bash
cd ~/.config/opencode
bun add @runmarks/opencode-plugin@$TARGET
```

### 仅更新 node_modules

1. 确认 `opencode.jsonc` 里 pin 已是 `@$TARGET`（或再跑一次 `npx @runmarks/runmark --clients opencode`）。
2. 重装 node_modules 包：

```bash
cd ~/.config/opencode
bun remove @runmarks/opencode-plugin 2>/dev/null || true
bun add @runmarks/opencode-plugin@$TARGET
python3 -c 'import json; print(json.load(open("node_modules/@runmarks/opencode-plugin/package.json"))["version"])'
```

### 源码调试（可选）

```bash
cd packages/plugin-opencode && bun run build
# opencode.jsonc:
# "file:///绝对路径/agent-tracker/packages/plugin-opencode/dist/index.mjs"
```

**必须重启 OpenCode。**

## 6. Codex Hook Plugin

### 新装 / 更新（同一命令）

```bash
npx --yes @runmarks/codex-plugin@$TARGET
```

本仓库源码安装：

```bash
cd packages/plugin-codex && bash install.sh
```

期望输出含：`Installed plugin root: .../agent-tracker/0.x.y`。

### 信任 Hook

在 Codex 中执行 `/hooks`，审查并信任 Runmark 相关 hook（更新后若提示未信任需再确认一次）。

### 验证

```bash
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"/tmp"}' \
  | ~/.codex/agent-tracker-marketplace/plugins/agent-tracker/dist/codex-tracker-hook session-start
# 期望：{}
```

**重启 Codex App**（或至少新开会话）。

## 7. Claude Code Plugin

### 新装 / 更新

```bash
npx --yes @runmarks/claude-compat-plugin@$TARGET --runtime claude
```

本仓库源码：

```bash
cd packages/plugin-claude-compat && bash install.sh --runtime claude
```

期望：`tclaude/claude plugin marketplace list` 含 `runmark`；`enabledPlugins` 含 `runmark-tracker@runmark`。

### 验证

```bash
HOOK=~/.config/agent-tracker/claude-compat-marketplace/plugins/runmark-tracker/dist/claude-compat-tracker-hook
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"'"$HOME"'/.tclaude"}' \
  | $HOOK session-start
# 期望：{}
```

**重启 Claude Code / TClaude（或 `/reload-plugins`）。** Dashboard 会话页确认 `agent=claude`。

卸载：`npx @runmarks/claude-compat-plugin --uninstall --runtime claude` 或 `tclaude plugin uninstall runmark-tracker`。

## 8. CodeBuddy Plugin

### 新装 / 更新

```bash
npx --yes @runmarks/claude-compat-plugin@$TARGET --runtime codebuddy
```

本仓库源码：

```bash
cd packages/plugin-claude-compat && bash install.sh --runtime codebuddy
```

期望：`codebuddy plugin marketplace list` 含 `runmark`；`enabledPlugins` 含 `runmark-tracker@runmark`。

### 验证

```bash
HOOK=~/.config/agent-tracker/claude-compat-marketplace/plugins/runmark-tracker/dist/claude-compat-tracker-hook
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"'"$HOME"'/.codebuddy"}' \
  | $HOOK session-start
# 期望：{}
```

**重启 CodeBuddy（或 `/reload-plugins`）。** Dashboard 会话页确认 `agent=codebuddy`。

卸载：`npx @runmarks/claude-compat-plugin --uninstall --runtime codebuddy` 或 `codebuddy plugin uninstall runmark-tracker`。

## 9. WorkBuddy Plugin

### 新装 / 更新

```bash
npx --yes @runmarks/claude-compat-plugin@$TARGET --runtime workbuddy
```

本仓库源码：

```bash
cd packages/plugin-claude-compat && bash install.sh --runtime workbuddy
```

期望：`~/.workbuddy/settings.json` 的 `enabledPlugins` 含 `runmark-tracker@runmark`；marketplace 已注册。

> 本机无独立 `workbuddy` CLI 时，安装脚本会使用 WorkBuddy.app 内嵌 CLI，并注入 `ACC_PRODUCT_CONFIG_PATH` + `CODEBUDDY_CONFIG_DIR=~/.workbuddy`。

### 验证

```bash
HOOK=~/.config/agent-tracker/claude-compat-marketplace/plugins/runmark-tracker/dist/claude-compat-tracker-hook
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup","cwd":"'"$HOME"'/.workbuddy"}' \
  | $HOOK session-start
# 期望：{}
```

**重启 WorkBuddy（或 `/reload-plugins`）。** Dashboard 会话页确认 `agent=workbuddy`。

卸载：`npx @runmarks/claude-compat-plugin --uninstall --runtime workbuddy`。

### 一次装齐三端（可选）

仅当用户明确要求「Claude Code + CodeBuddy + WorkBuddy 都装」时（不要自行推断）：

```bash
npx --yes @runmarks/claude-compat-plugin@$TARGET --runtime all
# 或源码：bash install.sh --runtime all
```

## 10. Grok Build Plugin

### 新装 / 更新

```bash
npx --yes @runmarks/grok-plugin@$TARGET
# 或统一入口：npx @runmarks/runmark --clients grok
```

本仓库源码：

```bash
cd packages/plugin-grok && bun run build && bash install.sh
```

期望：`~/.grok/hooks/runmark-tracker.json` 存在；`~/.config/agent-tracker/grok-plugin/grok-tracker-hook` 可执行。可与 `orca-status.json` 等其它 hook 文件共存。

### 验证

```bash
HOOK=~/.config/agent-tracker/grok-plugin/grok-tracker-hook
echo '{"sessionId":"test","hookEventName":"UserPromptSubmit","prompt":"hi","cwd":"'"$PWD"'"}' \
  | $HOOK user-prompt
# 期望：{} 或空
# 可选：grok inspect --json | 确认 hooks 含 runmark
```

**新开 Grok 会话**（用户级 hooks 一般无需 `/hooks-trust`）。Dashboard 会话页确认 `agent=grok`。

卸载：`npx @runmarks/grok-plugin --uninstall` 或 `npx @runmarks/runmark --clients grok --uninstall`。

## 11. 交付清单

只报告**本次实际安装/更新**的客户端；未选的标「跳过」。

| 项 | 状态 |
|----|------|
| 用户选择的客户端 | 列出（如 Cursor + WorkBuddy + Grok） |
| 统一 env endpoint / apiKey | 已核对 / 已写入 |
| Cursor hook 文件 mtime / sessionStart 行为 | … / 跳过 |
| OpenCode `opencode.jsonc` pin + node_modules version | … / 跳过 |
| Codex plugins cache 版本目录 | … / 跳过 |
| Claude Code：`runmark-tracker@runmark` + enabledPlugins | … / 跳过 |
| CodeBuddy：`runmark-tracker@runmark` + enabledPlugins | … / 跳过 |
| WorkBuddy：`runmark-tracker@runmark` + enabledPlugins | … / 跳过 |
| Grok：`~/.grok/hooks/runmark-tracker.json` + grok-tracker-hook | … / 跳过 |
| 需重启的客户端 | 按实际安装列出 |

引导打开 Dashboard：`http://<服务地址>:3456/` → 会话页确认对应 `agent=cursor|opencode|codex|claude|codebuddy|workbuddy|grok`。

Cursor 费用还需在 Dashboard「系统配置 → Cursor 账单同步」配置 `WorkosCursorSessionToken`（Hook 只负责会话归属）。

## 12. 常见问题

| 现象 | 处理 |
|------|------|
| `npx … cursor-hooks` 报 `agent-tracker-cursor: command not found` | 改用 `bunx --bun @runmarks/cursor-hooks@$TARGET init` |
| `npx … claude-compat-plugin` 报 command not found | 改用 `bunx --bun @runmarks/…@TARGET --runtime …`，或 `npm pack` 后 `node bin/agent-tracker-claude-compat-install.js` |
| 仍出现 Cursor 空会话 | 确认 hook.mjs 已是新版（`sessionStart: break`），并已重启 Cursor |
| OpenCode 仍加载旧包 | 检查 `opencode.jsonc` 是否钉死旧版本；清 `node_modules` 后 `bun add` |
| Codex 无 assistant/token | 重跑 `npx @runmarks/codex-plugin@$TARGET`，`/hooks` 信任，重启 App |
| Claude Code 无 token | 确认 `enabledPlugins` 含 `runmark-tracker@runmark`；Stop 后 JSONL 含 `message.usage` |
| CodeBuddy 无 token | 确认 `codebuddy plugin marketplace list` 含 `runmark` 且 enabled；transcript 为 CodeBuddy 原生 `type=message` 格式亦可解析 |
| WorkBuddy 误标为 CodeBuddy | 确认插件 ≥ `0.2.8`（识别 `~/.workbuddy` / `CODEBUDDY_CONFIG_DIR`）；重装 `--runtime workbuddy` 并重启 |
| WorkBuddy 无 token | 确认 `~/.workbuddy` 已 enable `runmark-tracker@runmark`；重跑 `--runtime workbuddy` |
| Grok 无 token / cost | 确认 `Stop` 后 `~/.grok/sessions/.../updates.jsonl` 含 `usage`；`grok inspect --json` 含 runmark；开启 `debug=true` 看 plugin.log |
| Grok hook 无响应 | 确认本机有 Bun 或 Node；`grok-tracker-hook` 可执行；**新开会话**后生效 |
| ingest 401 | 对齐 `~/.config/agent-tracker/env` 与服务端 API Key |
| 上报打到 localhost | 改 env 中 endpoint 后重启对应客户端 |

## 相关文档

- `packages/server/public/help/cursor.md` / `opencode.md` / `codex.md` / `claude.md` / `codebuddy.md` / `workbuddy.md` / `grok.md` — Dashboard 帮助中心原文
- `skills/agent-tracker-setup/SKILL.md` — 服务端部署
- `deploy/publish-cursor-hooks.sh` / `deploy/publish-plugin.sh` / `deploy/publish-claude-compat-plugin.sh` — 维护者发版（非本机用户步骤）
