---
name: agent-tracker-setup
description: >-
  从零部署 Runmark 服务端。适用于开发机一键部署、本地试用、health 验证与交付
  Dashboard / 帮助中心入口。客户端插件接入以部署后的帮助中心为准。触发词包括"安装 agent-tracker"、
  "部署 agent-tracker"、"部署 Runmark"、"初始化 agent-tracker"。
---

# Runmark — 部署 Skill

本 Skill 让 Agent **完成服务端部署与启动验证**。Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build 的客户端配置、插件安装与排障，**不要在本 Skill 里展开长流程**——部署成功后引导用户打开 Dashboard 帮助中心：

```text
http://<服务地址>:3456/#/help
```

帮助中心会自动填入当前服务的 endpoint 和 API Key。

## 0. 用户通常会提供什么

用户往往已经：

1. 准备好一台可 SSH 登录的 Linux 服务器（或本机）
2. 提供了 SSH 连接方式（如有）

若用户把 SSH 命令贴进对话，优先用该命令连上开发机，再执行下文「服务端部署」。

## 1. 项目形态（背景）

```text
[Cursor Hook]        ─┐
[OpenCode Plugin]    ─┤
[Codex Hook Plugin]  ─┤
[Claude Code Plugin] ─┼─ POST /v1/ingest ─▶ [Bun + Hono + SQLite] ─▶ [Dashboard]
[CodeBuddy Plugin]   ─┤
[WorkBuddy Plugin]   ─┤
[Grok Build Hooks]   ─┘
```

服务端还包含 Cursor 账单同步、智能体 / 事项归档、以及 `#/help` 帮助中心。用户想了解「做了哪些事情」时，默认引导看「事项归档」；Session 用于追溯过程与证据。

## 2. 服务端部署

### 推荐：开发机 / 服务器模式

在目标开发机上执行（路径可按环境调整，默认 `/opt/agent-tracker`）：

```bash
git clone https://github.com/yee94/runmark.git /opt/agent-tracker
cd /opt/agent-tracker
./setup.sh --server
```

`--server` 模式只做服务端初始化：

- 检查 `git` / `bun`
- `bun install`
- 初始化 / 迁移 SQLite
- 生成 `packages/server/.env`
- 注册并启动 systemd 服务 `agent-tracker`

部署完成后记录终端输出的 **Dashboard 地址** 和 **API Key**。API Key 同时是 Dashboard 登录密码和 ingest 鉴权 key。

### 本地试用 / 开发模式

本机试用时执行：

```bash
git clone https://github.com/yee94/runmark.git
cd runmark
./setup.sh
```

本地模式会额外尝试构建 OpenCode 插件、写入本机 `~/.config/agent-tracker/env`，并注册 OpenCode 插件。

也可以手动启动：

```bash
bun install
cd packages/server
bun dev
```

本地 Dashboard：`http://localhost:3456/`。

## 3. 服务验证

```bash
curl http://<服务地址>:3456/health
```

期望返回：

```json
{"status":"ok","version":"0.2.2"}
```

systemd 常用命令：

```bash
systemctl status agent-tracker
journalctl -u agent-tracker -f
systemctl restart agent-tracker
```

可选：探测 ingest 鉴权（排除网络 / Key 问题）：

```bash
curl -X POST "http://<服务地址>:3456/v1/ingest" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <服务端 API Key>" \
  -d '{"events":[{"type":"session.created","session_id":"probe-1","agent":"opencode"}]}'
```

返回 `{"ingested":1,"errors":[]}` 表示服务端写入链路正常。

## 4. 部署完成后交付给用户

安装完成后，明确告诉用户：

1. Dashboard 地址：`http://<服务地址>:3456/`
2. 登录密码 / API Key：部署输出中的 `AGENT_TRACKER_API_KEY`
3. 帮助中心：`http://<服务地址>:3456/#/help`
4. **下一步**：打开帮助中心「统一接入配置」，再按实际客户端安装 Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build（帮助中心按产品分篇，勿统称）
5. 阅读工作成果：默认进入「事项归档」；Session 用于补充追溯和排障

**不要**在对话里默认展开完整客户端安装步骤；帮助中心已覆盖统一 env、各客户端安装与常见问题。若用户明确要求本机安装 / 更新 Cursor、OpenCode、Codex、Claude Code、CodeBuddy、WorkBuddy、Grok Build 客户端，改用 [`agent-tracker-clients`](../agent-tracker-clients/SKILL.md)。

`setup.sh --server` 收尾也会打印 Dashboard / 帮助中心 URL 与 API Key；Dashboard 在 sessions=0 时会显示欢迎条，按钮直达 `#/help`。登录页也会提示「登录后打开帮助中心」。

若用户明确要求本机写入统一配置，最小示例为（`INCLUDE_*` 默认已为 true，无需写入）：

```bash
mkdir -p ~/.config/agent-tracker
cat > ~/.config/agent-tracker/env << 'EOF'
AGENT_TRACKER_ENDPOINT="http://<服务地址>:3456"
AGENT_TRACKER_API_KEY="<服务端 API Key>"
EOF
```

短键 `endpoint` / `apiKey` 也兼容；帮助中心使用 `AGENT_TRACKER_*`。

## 5. 常见问题（服务端）

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| SSH 卡住要密码 | 密钥未配置 / 命令不完整 | 确认 SSH 密钥与连接命令 |
| `curl /health` 失败 | 服务未起或端口不通 | `systemctl status agent-tracker`；检查防火墙 / 域名 |
| ingest 返回 401 | API Key 不一致 | 对齐服务端 `.env` 中的 `AGENT_TRACKER_API_KEY` |
| 修改 `.env` 后不生效 | 服务未重启 | `systemctl restart agent-tracker` |
| Dashboard 无数据 | 客户端尚未按帮助中心接入 | 引导打开 `#/help`，不要在本 Skill 里长篇代配插件 |

客户端侧问题（无数据、Cursor 无 cost、Codex hook 未信任等）一律指向帮助中心对应文章。

## 相关文档

- `README.md` — 项目简介、AI 部署提示词、折叠的人工步骤
- `packages/server/public/help/*.md` — Dashboard 帮助中心（客户端接入主入口）
- `skills/agent-tracker-clients/` — 本机 Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build 新装与更新
- `skills/agent-tracker-api/` — curl + OpenAPI 查询 Skill
- `AGENTS.md` — 开发协作、Dashboard 约定和调试说明
