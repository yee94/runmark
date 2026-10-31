# OpenCode 安装配置

OpenCode 接入由 `@runmarks/opencode-plugin` 完成。插件在 OpenCode 进程内监听 session、message、turn、tool 事件，并把数据写入 Runmark。

安装前请先完成“统一接入配置”，确保 `~/.config/runmark/env` 中已经配置 `RUNMARK_ENDPOINT` 和 `RUNMARK_API_KEY`。

## 一键安装插件

运行 `npx @runmarks/runmark --clients opencode`，安装器会迁移旧包名并去重。也可编辑 `~/.config/opencode/opencode.jsonc`，在 `plugins` 数组中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@runmarks/opencode-plugin"
  ]
}
```

OpenCode 从 npm 加载插件，V2 配置保存后自动重载，必要时使用 `/reload`。

## 自动注入 Runmark Skill

插件加载时自动注册 `runmark` Skill，包含查询脚本、参考文档和 OpenAPI；更新插件会同步更新 Skill。同名的本地自定义技能按 OpenCode 的来源优先级覆盖。

Skill 唯一源位于仓库 `skills/runmark/`，构建及 npm 打包时复制到包内 `dist/skills/runmark/`。名称、描述从同一份 `SKILL.md` 生成，维护时直接修改源目录。

## 本仓库源码调试

开发插件时，先构建本地 dist：

```bash
cd packages/plugin-opencode
bun run build
```

然后把 `opencode.jsonc` 指向本地构建产物：

```json
{
  "plugins": [
    "file:///绝对路径/runmark/packages/plugin-opencode"
  ]
}
```

## 分层记忆（OpenCode V2）

记忆适配包含在同一个插件包内，默认关闭。推荐直接用对象形式开启，配置保存在 `~/.config/opencode/opencode.jsonc`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@runmarks/opencode-plugin",
      "options": {
        "memoryEnabled": true
      }
    }
  ]
}
```

插件 options 优先于 `~/.config/runmark/env` 的同名配置；也可继续在 env 中设置 `RUNMARK_MEMORY_ENABLED=true`，或用同名环境变量覆盖。改动后保存配置或使用 `/reload` 生效。

新会话一次读取适用的全局、项目短索引，包括通用与当前命名 Agent 专属记忆；模型通过 `runmark_memory_read` 按需读取详情。工具还支持列表、刷新、保存、修订和遗忘，保存时可指定 scope。服务端后台提取需独立启用 `agent-memory-extraction`，并保持服务端自动调度开启；启用前的历史不会自动回填。

一个 Runmark 实例对应一个用户。记忆跨机器共享：全局跨项目使用，项目按仓库区分；Agent 专属维度独立于这些范围。无仓库身份时使用全局记忆。后台根据真实原文判断范围，旧项目记忆不会自动升级为全局。索引首次等待最多 1 秒，后续同会话同 Agent 使用快照；切换 Agent 使用对应索引。旧版 OpenCode 保留采集，可通过 Runmark 查询 Skill 访问记忆。

## 调试日志

需要插件日志时，把以下配置追加到 `~/.config/runmark/env` 后使用 `/reload`：

```bash
{
  echo 'RUNMARK_DEBUG=true'
  echo 'RUNMARK_LOG_FILE="~/.config/runmark/plugin.log"'
} >> ~/.config/runmark/env
```

查看日志：

```bash
tail -f ~/.config/runmark/plugin.log
```

## 常见问题

- 仍然上报 `localhost`：确认 `~/.config/runmark/env` 已更新，并使用 `/reload`。
- ingest 返回 401：客户端 `RUNMARK_API_KEY` 与服务端 `RUNMARK_API_KEY` 不一致。
- token 为 0：升级 `@runmarks/opencode-plugin`，使用 `/reload`，并确认 assistant turn 已完成。
