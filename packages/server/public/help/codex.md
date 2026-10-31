# Codex 安装配置

Codex 接入由 `@runmarks/codex-plugin` 完成。插件通过 Codex 本地 marketplace 安装 Hook，并在 `Stop` 阶段读取 rollout JSONL 补齐 assistant、tool、token 与费用估算。

安装前请先完成“统一接入配置”，确保 `~/.config/runmark/env` 中已经配置 `RUNMARK_ENDPOINT` 和 `RUNMARK_API_KEY`。

## 一键安装 Codex 插件

推荐使用 npx 安装：

```bash
npx @runmarks/codex-plugin
```

安装脚本会完成以下动作：

1. 复制 Runmark marketplace 到本机 Codex 工作目录。
2. 生成带绝对路径的 `hooks.json`。
3. 注册 Codex marketplace。
4. 安装 Runmark 插件。

## 本仓库源码安装

开发或调试本仓库插件时执行：

```bash
cd packages/plugin-codex
bash install.sh
```

## 信任 Hook

Codex Hook 需要用户审查后才能运行。安装完成后，在 Codex 中执行：

```text
/hooks
```

检查 Runmark 插件的 hook 命令后信任该 Hook。

## 常见问题

- 会话没有 assistant、tool 或 token：重新执行 `npx @runmarks/codex-plugin`，并重启 Codex App。
- Hook 无响应：确认本机存在 Bun 或 Node，并在 `/hooks` 中确认 Runmark 启动器可执行。
- ingest 返回 401：对齐 `~/.config/runmark/env` 中的 `RUNMARK_API_KEY` 与服务端 `RUNMARK_API_KEY`。
