# 统一接入配置

所有客户端插件都读取同一个配置文件：`~/.config/agent-tracker/env`。Cursor、OpenCode、Codex、Claude Code、CodeBuddy、WorkBuddy、Grok Build 等客户端在安装插件之前，建议先完成这一处配置。

配置文件支持 `endpoint` / `apiKey` 这类短键别名，但本文统一使用真实环境变量名 `AGENT_TRACKER_*`。

## 一键写入配置

下面命令会把当前 Dashboard 对应的服务地址和 API Key 写入本机配置文件：

```bash
{{CLIENT_ENV_COMMAND}}
```

配置文件路径：

```text
{{CLIENT_ENV_PATH}}
```

写入后的内容等价于：

```bash
AGENT_TRACKER_ENDPOINT="{{ENDPOINT}}"
AGENT_TRACKER_API_KEY="{{API_KEY}}"
```

## 之后安装客户端插件

完成统一配置后，用品牌包 **一键安装**（推荐）：

```bash
npx @runmarks/runmark
# 无交互只装已探测到的：npx @runmarks/runmark --clients detected
# 或按需：npx @runmarks/runmark --clients cursor,codex,workbuddy,grok
```

也可按产品分篇手动安装：Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build。

插件安装完成后需要重启对应客户端（或 `/reload-plugins`），让插件重新读取 `~/.config/agent-tracker/env`。

## 使用 magpie 等 OTLP 工具

如果使用 magpie 等已有上报能力的工具，无需安装 Runmark 插件。请打开 [OTLP 接入（magpie 等）](#/help/otlp)，按页面给出的服务地址和 API Key 配置。magpie 的配置需在工具内单独填写，不会读取上述客户端配置文件。
