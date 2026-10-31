# @runmarks/runmark

Runmark **统一客户端安装入口**。未来本机接入都收敛到这一条命令：

```bash
npx @runmarks/runmark
```

无参数时会：**探测本机已装客户端 → 交互勾选（默认勾上已发现的）→ 安装**。

| Client | 实际安装包 |
|--------|------------|
| Cursor | `@runmarks/cursor-hooks` |
| OpenCode | `@runmarks/opencode-plugin` |
| Codex | `@runmarks/codex-plugin` |
| Claude Code / CodeBuddy / WorkBuddy | `@runmarks/claude-compat-plugin`（`runmark-tracker@runmark`） |
| Grok Build | `@runmarks/grok-plugin`（`~/.grok/hooks/runmark-tracker.json`） |

OpenCode 插件自动注册随包附带的 `runmark` Skill，包含查询脚本、参考文档和 OpenAPI。Skill 从仓库唯一的 `skills/runmark/` 源目录打包，随插件版本更新。

## 用法

```bash
# 交互安装 / 更新（推荐）：探测 + 勾选；已装用户再次运行会预选已装项并更新
npx @runmarks/runmark

# 只更新已装 Runmark 的客户端（无交互）
npx @runmarks/runmark --clients installed
npx @runmarks/runmark --yes

# 只装本机已发现的宿主
npx @runmarks/runmark --clients detected

# 一键装齐 / 按需
npx @runmarks/runmark --clients all
npx @runmarks/runmark --clients cursor,codex,workbuddy

# 卸载
npx @runmarks/runmark --clients codebuddy --uninstall

# 若本机 npx 报 runmark: command not found，改用：
npx -p @runmarks/runmark runmark
# 或：bunx @runmarks/runmark
```

安装前请配置 `~/.config/runmark/env`（`RUNMARK_ENDPOINT` / `RUNMARK_API_KEY`）。新文件优先，缺失时只读兼容旧配置；同一来源内新变量名优先于旧前缀。

## 前置条件

- **Bun ≥ 1.1 或 Node ≥ 18**：Claude / CodeBuddy / WorkBuddy / Codex / Grok 的 hook 启动器会优先 bun，缺失时回退 node；两者都没有则安装期报错，运行期 fail-open 并写入 `~/.config/runmark/plugin.log`。
- 服务端已可用：`curl "$ENDPOINT/health"` 返回 ok。

## 写配置原则（重要）

宿主配置（尤其是 `~/.config/opencode/opencode.jsonc`）**必须 patch，禁止整文件覆写**：

- 已有文件：迁移 `plugins` / `plugin` 数组里的 Runmark 新旧包名并去重；缺少时追加 `plugins`
- 保留注释、其它插件、其它顶层字段、以及 Mackup 等 symlink
- 仅当配置文件不存在时，才创建最小骨架

Cursor `hooks.json`、Claude 系 `settings.json` 的 `enabledPlugins` 同样走合并写入。

## 选项

| 参数 | 说明 |
|------|------|
| （无 `--clients`） | 终端内：探测 + 交互勾选（有已装则预选已装并更新） |
| `--clients <list>` | `all` / `installed` / `detected` / 逗号分隔客户端名 |
| `--yes` / `-y` | 无交互：优先更新已装；否则装探测到的宿主 |
| `--uninstall` | 卸载所选客户端 |
| `--cursor-version` / `--opencode-version` / `--codex-version` / `--claude-compat-version` / `--grok-version` | 钉死子包版本，默认 `latest` |

非 TTY（CI / 管道）必须显式传 `--clients` 或 `--yes`。

## 本仓库源码

```bash
cd packages/runmark
bash install.sh
bash install.sh --clients detected
```
