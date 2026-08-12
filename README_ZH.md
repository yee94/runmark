<p align="center">
  <img src="docs/images/runmark-logo.png" alt="Runmark" width="320" />
</p>

<p align="center">
  <strong>Runmark</strong> — 把你在 A 电脑与 CodeX、B 电脑与 Claude Code 等所有 AI 编码对话集中上报到一处，统一分析与搜索。
</p>

<p align="center">
  <a href="README.md">English</a> · MIT License
</p>

### ✨ 特性

- 📡 **统一采集与审查** — 汇集 Cursor、OpenCode、Codex、Claude Code、CodeBuddy、WorkBuddy、Grok Build 等不同 Agent 客户端的会话，在一处查看费用用量与完整对话内容。
- 📝 **AI 智能 Summary** — 自动总结你与 AI 的对话事项，快速了解做了什么，帮助做好日常记录与交接。
- 🔗 **Open API 与 SDK** — 提供标准接口与接入能力，可把整套服务对接到你的任意 Agent 或自动化流程中。
- 📊 **用量与费用洞察** — 按今天 / 本周 / 本月等时间窗口，聚合 token、费用、模型与客户端分布，一眼看清花在哪。
- 📋 **事项归档** — 跨会话沉淀工作成果与可交接事项，优先回顾「做了什么」，不必逐条翻 Session。
- 🔍 **会话调用链追溯** — 密集 trace 视图，回溯某次对话的消息、推理 turn 与工具调用细节。
- 💰 **Cursor 账单同步** — 对接 Cursor Usage API，与本地遥测数据对账，补齐官方账单视角。
- 🤖 **可配置智能体** — 自定义触发器（新对话 throttle、定时 CRON），自动执行 Summary、归档等后台任务。
- 🚀 **一键部署** — `setup.sh` 完成服务安装、鉴权与客户端配置，Dashboard 内置帮助中心引导接入。

<table align="center" width="100%">
  <tr>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/preview-overview.jpg" alt="Runmark 总览" width="100%" />
      <br /><sub>总览</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/preview-session-list.jpg" alt="Runmark 会话记录" width="100%" />
      <br /><sub>会话记录</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/preview-session-summary.jpg" alt="Runmark 会话总结" width="100%" />
      <br /><sub>会话总结</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="docs/images/preview-matter.jpg" alt="Runmark 事项归档" width="100%" />
      <br /><sub>跨会话事项归档</sub>
    </td>
  </tr>
</table>

## 架构

```text
[Cursor Hook]        ─┐
[OpenCode Plugin]    ─┤
[Codex Hook Plugin]  ─┤
[Claude Code Plugin] ─┼─ POST /v1/ingest ─▶ [Runmark Server] ─▶ [Dashboard]
[CodeBuddy Plugin]   ─┤
[WorkBuddy Plugin]   ─┤
[Grok Build Hooks]   ─┘
```

## 快速开始

分两步：**先部署服务端**，再在本机安装客户端插件。分产品说明与排障见 Dashboard 帮助中心：`http://<服务地址>:3456/#/help`。

### 1. 部署服务端

#### 推荐：让 AI 帮你部署

把下面提示词发给 Cursor / OpenCode / Codex 等 Agent，并把 SSH 命令或本机路径替换进去：

```text
请帮我部署 Runmark。

目标环境：
- 本机 / 远程服务器（若远程，请给出 SSH 连接命令）

请严格参考仓库内 skills/agent-tracker-setup/SKILL.md 完成：
1. 若远程则先 SSH 连上目标机
2. 按 Skill「服务端部署」章节执行 ./setup.sh --server
3. 用 curl 验证 /health
4. 把 Dashboard 地址、API Key、帮助中心地址回给我

不要在本机配置客户端插件；部署完成后告诉我去 Dashboard 帮助中心或按 README「本机安装客户端」继续接入。
```

Skill 路径：[skills/agent-tracker-setup/SKILL.md](skills/agent-tracker-setup/SKILL.md)

也可用 Docker 部署。镜像构建、数据卷、环境变量和升级流程见 [Docker 部署指南](docs/docker.md)。

<details>
<summary><strong>人工部署服务端（展开）</strong></summary>

#### 部署服务

在目标机上执行：

```bash
git clone https://github.com/yee94/runmark.git /opt/agent-tracker
cd /opt/agent-tracker
./setup.sh --server
```

`--server` 会完成：前置检查 → 安装依赖 → 初始化 SQLite → 生成 `.env` → 注册 systemd → 启动服务。

终端会打印 **Dashboard 地址** 和 **API Key**（同时是登录密码）。验证：

```bash
curl http://<服务器地址>:3456/health
```

返回 `{"status":"ok",...}` 即表示可用。

#### 本地开发

```bash
git clone https://github.com/yee94/runmark.git
cd runmark
./setup.sh
```

或手动：

```bash
bun install
cd packages/server
bun dev
```

Dashboard：`http://localhost:3456/`。脚本幂等，重复执行不会覆盖已有配置。

</details>

### 2. 本机安装客户端

服务端就绪后，在本机安装 Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build 等插件。统一入口是品牌包 `@runmarks/runmark`。

#### 方式 A：让 AI 读 Skill 安装（推荐）

把下面提示词发给本机 Agent（Cursor / OpenCode / Codex 等），并填入你的 Dashboard 地址与 API Key：

```text
请帮我在本机安装 Runmark 客户端插件。

服务端：
- Dashboard / endpoint：http://<服务地址>:3456
- API Key：<服务端 API Key>

请严格参考仓库内 skills/agent-tracker-clients/SKILL.md：
1. 先列出可选 Client（Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build）让我勾选，不要默认 all
2. 写入或核对 ~/.config/agent-tracker/env（endpoint + apiKey）
3. 用统一入口安装：npx @runmarks/runmark --clients <我选的列表>
4. 装完告诉我需要重启哪些客户端，并给出 Dashboard 验证方式
```

Skill 路径：[skills/agent-tracker-clients/SKILL.md](skills/agent-tracker-clients/SKILL.md)

#### 方式 B：手动安装

1. 写入统一配置（新装必做；已有文件则核对，勿盲目覆盖）：

```bash
mkdir -p ~/.config/agent-tracker
cat > ~/.config/agent-tracker/env << 'EOF'
export AGENT_TRACKER_ENDPOINT="http://<服务地址>:3456"
export AGENT_TRACKER_API_KEY="<服务端 API Key>"
EOF
```

2. 用品牌包安装：

```bash
# 交互安装（推荐）：自动探测；已装用户再次运行会预选已装项并更新
npx @runmarks/runmark

# 只更新已装 Runmark 的客户端（无交互）
npx @runmarks/runmark --clients installed
# 或：npx @runmarks/runmark --yes

# 一键装齐 / 按需
npx @runmarks/runmark --clients all
npx @runmarks/runmark --clients cursor,codex,workbuddy

# 卸载示例
npx @runmarks/runmark --clients codebuddy --uninstall
```

若本机 `npx @runmarks/runmark` 报 `command not found`，改用：

```bash
npx -p @runmarks/runmark runmark
# 或：bunx @runmarks/runmark
```

3. **重启**已安装的客户端（Claude / CodeBuddy / WorkBuddy 可用 `/reload-plugins`；Grok Build 新开会话即可）。Codex / Claude 系若提示未信任，在 App 内审查并信任 Runmark plugin hooks。

4. 打开 Dashboard 会话页，确认对应 `agent=cursor|opencode|codex|claude|codebuddy|workbuddy|grok`。

可选客户端：`cursor` · `opencode` · `codex` · `claude` · `codebuddy` · `workbuddy` · `grok` · `all` · `installed` · `detected`。无参数时默认探测并交互勾选（有已装则预选已装并更新）。

## 开发

```bash
bun install
bun test
```

常用入口：

- `packages/runmark`：品牌统一安装入口 `@runmarks/runmark`
- `packages/server`：Bun + Hono + SQLite 服务端和 Dashboard
- `packages/plugin-opencode`：OpenCode 插件
- `packages/plugin-codex`：Codex Hook 插件
- `packages/plugin-claude-compat`：Claude Code / CodeBuddy / WorkBuddy 的 Plugin Marketplace 安装包（按 `--runtime` 分产品；`npx` 幂等升级）
- `packages/plugin-grok`：Grok Build 用户级 Hooks 插件（`~/.grok/hooks`，Stop 读本地 session）
- `packages/hook-cursor`：Cursor Hook
- `shared`：共享类型、定价和工具函数
- `skills/agent-tracker-setup` / `skills/agent-tracker-clients`：服务端部署 / 本机客户端安装 Skill

## License

MIT
