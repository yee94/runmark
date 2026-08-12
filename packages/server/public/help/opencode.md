# OpenCode 安装配置

OpenCode 接入由 `@runmarks/opencode-plugin` 完成。插件在 OpenCode 进程内监听 session、message、turn、tool 事件，并把数据写入 Runmark。

安装前请先完成“统一接入配置”，确保 `~/.config/agent-tracker/env` 中已经配置 `endpoint` 和 `apiKey`。

## 一键安装插件

编辑 `~/.config/opencode/opencode.jsonc`，在 `plugin` 数组中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@runmarks/opencode-plugin"
  ]
}
```

OpenCode 启动时会通过 Bun 从 npm 加载插件。配置完成后重启 OpenCode。

## 本仓库源码调试

开发插件时，先构建本地 dist：

```bash
cd packages/plugin-opencode
bun run build
```

然后把 `opencode.jsonc` 指向本地构建产物：

```json
{
  "plugin": [
    "file:///绝对路径/agent-tracker/packages/plugin-opencode/dist/index.mjs"
  ]
}
```

## 调试日志

需要插件日志时，把以下配置追加到 `~/.config/agent-tracker/env` 后重启 OpenCode：

```bash
{
  echo 'debug=true'
  echo 'logFile="~/.config/agent-tracker/plugin.log"'
} >> ~/.config/agent-tracker/env
```

查看日志：

```bash
tail -f ~/.config/agent-tracker/plugin.log
```

## 常见问题

- 仍然上报 `localhost`：确认 `~/.config/agent-tracker/env` 已更新，并重启 OpenCode。
- ingest 返回 401：客户端 `apiKey` 与服务端 `AGENT_TRACKER_API_KEY` 不一致。
- token 为 0：升级 `@runmarks/opencode-plugin`，重启 OpenCode，并确认 assistant turn 已完成。
