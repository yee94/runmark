# 分层记忆

Runmark 的一个实例对应一个用户。记忆让不同会话、不同客户端复用用户已经解释过的偏好、约束与决策原因，并区分适用范围。

## 范围与分类

自动提取依次判断留存价值、适用对象与仓库身份、已有事实、内容分类，最后原子提交。单次交付要求和定时任务正文保留在原任务中，不扩写成长期偏好；事实对象与来源仓库矛盾时跳过，既不猜项目，也不改存全局。明确的稳定通用偏好可自动存全局，无须等待用户说“记住”。

每次自动变更记录原文片段、留存理由和范围理由，在详情「来源与修订 → 判断依据」查看。跳过候选的理由保存在提取任务结果中；历史记录没有这些依据时不补造。

| 适用范围 | 保存什么 | 共享边界 |
|---|---|---|
| 全局 `global` | 跨项目的稳定偏好与通用协作方式 | 当前 Runmark 用户的所有项目 |
| 项目 `project` | 项目特有的约束、决策与资料 | 同一仓库，跨机器共享 |

每种范围都可带命名 Agent，例如 `agent_key=opencode/build`，表示该 Agent 专属；省略为通用记忆。它和客户端名称不是一回事：同一个 OpenCode 客户端可以使用不同 Agent。

另一维度 `type=user|feedback|project|reference` 表达内容类别，不决定共享范围。`type=user` 可以是全局偏好，也可以只适用于某个项目。旧记录继续属于通用项目范围，不会自动提升到全局。

## 记忆与已有记录的区别

| 记录 | 回答的问题 |
|---|---|
| 原始 Session | 用户和 Agent 当时具体说了什么、调用了什么？ |
| Session Summary | 这个会话主要完成了什么？ |
| Matter | 这件工作做到哪里，如何交接？ |
| Memory | 下次遇到什么任务，应当记起哪条事实？ |

Memory 不保存当前会话的临时进度，也不重复存储代码或仓库指令已明确记录的信息。需要确认历史命令是否执行成功时，应查询原始会话。

## MEMORY 格式

借鉴 ZCode 的两层格式：短索引用于发现，事实正文按需读取。SQLite 是唯一权威来源，下面是 API 呈现的 Markdown 语义，不要求在仓库内创建同名文件。

索引无 frontmatter，一条记忆一行，包含链接与读取时机。索引链接指向服务端的稳定 ID。它只负责让 Agent 知道“有这条记忆”，不替代事实正文。

事实详情示意（非实际保存记录）：

```markdown
---
name: release-window-reason
description: 安排生产环境发布或紧急修复时读取
metadata:
  node_type: memory
  type: project
  scope: project
  agent_key: ""
  originSessionId: <首次来源会话 ID>
---

生产发布需要与值班人员的可用时间协调。

**Why:** 用户确认发布后需要有人检查关键链路。

**How to apply:** 制定发布计划时先确认值班时间；紧急修复按当前用户指示处理。
```

四种 type 分别是 user（背景与稳定偏好）、feedback（纠正与认可）、project（项目动机与约束）、reference（外部资料入口）。scope 与 agent_key 标明这条事实在哪里适用。

每条记忆只表达一个事实。feedback 和 project 包含 Why 与 How to apply，原因没有来源支持时标为未知。`[[other-memory-name]]` 可提示相关记忆，但不会自动展开正文。

首次 originSessionId 保持不变；完整修订来源由 API 独立记录，不能把首次来源当成最新修改证据。稳定 ID、revision、状态和时间以 API 返回的元数据为准。

## 项目与生效边界

记忆统一跨机器共享。同一规范化仓库 remote 的多个 worktree、不同机器使用同一份项目记忆；不同 remote 不自动合并。没有仓库身份时使用全局记忆，不以主机或目录划分空间。旧 local 记录迁入来源仓库的项目范围，无法确定仓库时归入全局，保留 ID、正文、修订、来源与遗忘状态；同名事实保留为独立记录。

OpenCode 在会话初始化时一次获取适用的通用与当前 Agent 专属全局、项目索引，相关任务再读取正文。整体预算仍为 200 条、25,000 字符。后台新增记忆不自动改写已有上下文；新会话和冷恢复读取新索引，当前会话可主动刷新。切换 Agent 使用对应快照，不能带入上一个 Agent 的专属记忆。其他客户端可通过 `skills/runmark` 查询。

记忆是历史参考，不覆盖当前用户要求与当前代码事实。历史约定冲突时，项目比全局更具体，同范围内 Agent 专属约定更具体；同名不表示同一事实，不自动互相覆盖。用户要求本次忽略记忆时停止应用。索引超限可继续分页，服务暂不可达不妨碍正常对话和遥测。

## 修订与遗忘

相同事实更新原记录，保留修订来源；revision 冲突时重读再决定，避免覆盖较新的用户纠正。遗忘后该条记忆不再进入索引或详情召回，旧来源重放不能将其恢复。

遗忘不会删除原始会话，也无法抹除已经进入当前上下文的文本；执行后要明确旧事实已失效。重新保存需要新的明确用户要求。

## 接口与操作

Dashboard 侧栏「记忆」用工具栏切换范围、Agent、内容类型及状态；项目默认展示全部，可搜索选定项目，也可选择「全部项目（清除选择）」恢复跨项目浏览。全部项目列表标注所属项目，分页与搜索覆盖所有项目。列表与详情展示正文、修订和来源，索引按钮查看当前范围的 MEMORY.md。自动提取与设置位于页头，使用说明默认折叠。

记忆复用全站登录态和访问策略，不要求第二次输入密码；公开 Dashboard 模式与其他页面一致。客户端沿用 API Key，公开 Session Share 不授予记忆访问权限。具体查询、写入和来源格式见 [Runmark 查询 Skill](../skills/runmark/references/memory.md) 与 [OpenAPI](../skills/runmark/openapi.yaml)。

后台提取默认关闭。在 Agent 配置中启用 `agent-memory-extraction` 后，它沿用现有自动调度开关，对新增原文按 Session 防抖处理。启用时建立已有消息水位，关闭期间的内容不会在重新启用后自动回填。运行状态、模型用量和费用沿用 Agent 任务记录。

通过查询 Skill 的脚本启用：

```bash
runmark_put /v1/agents/agent-memory-extraction/config \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
```

自动执行还要求服务端现有 `AGENT_TRACKER_AGENT_AUTO_RUN_ENABLED` 开关开启。客户端是否使用记忆独立配置；仅开启提取不会自动让未配置的客户端注入索引。

OpenCode V2 插件优先读取 `~/.config/opencode/opencode.jsonc` 中对象形式插件条目的 `options.memoryEnabled`，其次在 `~/.config/runmark/env` 读取 `RUNMARK_MEMORY_ENABLED=true`，同名环境变量优先级最高。端点与 API Key 沿用采集配置。插件重新加载后读取新配置；不另装记忆插件包。

启用后模型可用 `runmark_memory_list/read/refresh/write/update/forget` 六个工具。自动索引查询超过 1 秒即略过，显式工具调用的错误会直接返回；工具写入只有在真实用户来源已采集后才能成功。

OpenCode V1 不提供本期使用的 V2 上下文接口，保留采集功能，记忆可通过查询 Skill 使用。宿主接口与验证证据见[插件记忆适配记录](../packages/plugin-opencode/MEMORY.md)。

分层设计与验收范围见 [分层记忆规格](specs/memory-scopes.md)；基础协议见 [原项目记忆规格](specs/project-memory.md)。

## 开发验收

普通回归使用 `bun test`。真实 OpenCode 宿主验收单独运行：

```bash
cd packages/plugin-opencode
bun run test:host
```

该命令先构建插件，再使用已安装的 OpenCode V2 私有进程、隔离配置和数据库，捕获本地受控 provider 的实际请求。覆盖短索引、读取详情、来源写入、冷恢复、关闭及超时降级；不连接当前用户的宿主服务。可用 `OPENCODE_TEST_BINARY` 指定二进制。
