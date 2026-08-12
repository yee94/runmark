# Cursor 安装配置

Cursor 接入由 `@runmarks/cursor-hooks` 完成。安装脚本会把 Hook 写入 Cursor 的 `hooks.json`。

安装前请先完成“统一接入配置”，确保 `~/.config/agent-tracker/env` 中已经配置 `endpoint` 和 `apiKey`。

## 一键安装 Cursor Hook

用户级安装会写入 `~/.cursor/hooks.json`：

```bash
npx @runmarks/cursor-hooks init
```

只给当前项目安装时，在项目根目录执行：

```bash
npx @runmarks/cursor-hooks init --project
```

## 重启

重启 Cursor IDE。

## Cursor 账单同步

请特别确认当前系统已经配置过 Cursor 账单同步。Cursor Hook 负责建立会话归属，但真实 token 与费用需要在 Dashboard 的“系统配置 → Cursor 账单同步”中配置 `WorkosCursorSessionToken` 后拉取 Cursor Usage API。

同步配置完成后，后台会把 Cursor usage events 对账到已有 `agent=cursor` 会话，不会用时间窗口把账单错配到其他 Agent。

如果没有配置 Cursor 账单同步，Dashboard 仍然可以看到 Cursor Session，但 Cursor Session 的 cost 拉不到。

## 常见问题

- Dashboard 没有数据：先检查“统一接入配置”文章中的 `endpoint` 和 `apiKey` 是否已经写入。
- Hook 没有执行：确认 `~/.cursor/hooks.json` 或项目 `.cursor/hooks.json` 中存在 `./hooks/agent-tracker/run.sh`。
- 费用为空：确认 Cursor 账单同步已经配置并同步成功；没有配置 `WorkosCursorSessionToken` 时，Cursor Session 的 cost 不会自动出现。
- 为什么 OpenCode / Codex 有 cost，Cursor 没有 cost：OpenCode / Codex 的 token 与费用来自各自插件或 transcript；Cursor 的真实费用来自 Cursor Usage API，所以必须额外配置账单同步。
- 配置账单同步后仍然没有 cost：进入“系统配置 → Cursor 账单同步”查看同步状态，确认 Token 未过期、Usage API 可访问，并执行一次“立即同步”。
