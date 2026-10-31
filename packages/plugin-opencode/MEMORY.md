# OpenCode 分层记忆适配

在 `~/.config/opencode/opencode.jsonc` 中以对象形式声明插件并设置 `options.memoryEnabled=true`；
也可在 `~/.config/runmark/env` 设置 `RUNMARK_MEMORY_ENABLED=true`，或设置同名环境变量。
插件 options 优先于 env 文件，环境变量仍最高，默认关闭；端点和凭据沿用遥测配置。
服务端提取开关独立管理。本模块不会写本地记忆镜像。

## 宿主接口

实现目标为 OpenCode V2，使用 `session.hook("context")` 和 `tool.transform`。
已核对官方 V2 文档、Context7 v2.1.2、当前二进制 `opencode v2.2.1` 及本机源码
`packages/plugin/src/promise/{session,tool}.ts`。旧 npm 依赖 `@opencode-ai/plugin@1.17.15`
的 V2 类型不包含当前接口，所以使用独立窄接口，并在运行时检测能力。
V1 入口保留采集，启用记忆时日志明确提示不支持；不以 `chat.message` 注入。

自动请求使用 repo_url 定位仓库，避免新会话尚未入库的竞态；无仓库时仍能获取全局记忆。
同会话按真实命名 Agent 分开保留内存快照；重新加载插件后冷恢复重新读取；失败一秒后略过且不逐轮重试。
`context` 每轮替换单个带标记区块，不更改持久化消息。刷新显式替换当前快照。

工具：`runmark_memory_read/list/refresh/write/update/forget`。
写操作默认从宿主会话上下文中选取当前工具所属 assistant 消息之前最近的真实 user 消息；
缺失或找不到 assistant messageID 时拒绝写入，不能退回到未来的用户消息。
排除 synthetic、不可见标记及空正文；显式 `source_message_id` 也必须匹配此前的有效 user 消息。
等待采集 flush 后才发写请求。
服务端仍须验证来源是否已入库、属于当前项目、revision、幂等性和恢复条件。

`context` hook 的 `event.agent` 与工具执行上下文 `context.agent` 直接转为
`opencode/<agent>`；未知时仅读取共享记忆，不把客户端产品名当 Agent。
用户 `inbox.enqueued` 尚无实际 Agent，暂存后按 `inbox.delivered` 与对应
`step.started.agent` 绑定 `IngestMessageEvent.agent_key`；未 delivered 的排队消息不会被提前归属。
assistant 来源沿用该 step 捕获的 Agent。切换不会用当前会话字段回填历史消息。

`ctx.location` 是插件实例的 location，而事件订阅来自公共总线。首个会话事件使用
`session.get` 核对真实 location，并补发 `session.updated` 元信息（含 hostname），不依赖
插件加载前可能已经错过的 `session.created`。其他 location 的事件不使用本实例 remote；
`session.moved` 使缓存失效。依据是宿主 `core/src/plugin/host.ts` 的 Location.Service /
Bus.Service 与 `session.get` 实际返回值。

包显式声明 `exports` 供 V2 加载，六个记忆工具声明 `options.codemode=false`，与协议中的普通工具名一致。

## HTTP 契约

- 所有请求携带 `X-API-Key`。
- GET 的项目字段放 query；写请求放 JSON body。
- 自动索引只发一次 `/index?view=effective&agent_key=opencode/<agent>`，组合共享与当前 Agent 的 global/project。
- 无 repo 仍能读取 global。不构造后端 opaque namespace ID。
- context hook 和工具执行先核对 session.location；插件实例目录不代表所有可见会话。跨目录 hook 保留其他实例的索引，跨目录工具拒绝执行。采集确认无 remote 时用空字符串清除服务端旧归属。
- `scope` 与内容 `type` 独立。global 跨项目；project 按仓库。全部记忆跨机器共享，主机与目录不参与空间划分。
- write 默认共享 project，可显式指定 scope 和当前真实 agent_key。空 agent_key 表示共享，不能冒用另一 Agent。
- read 默认 effective 按稳定 ID；list 默认 effective，可限定 scope/agent_key/type，分页与 forgotten 过滤保持可用。
- update/forget 先 effective read 确认记录 scope/agent_key，再发送精确范围写请求；410 时分页查询 forgotten 元数据，支持恢复与幂等重试，不读取旧正文。
- index 消费 `{markdown:string, has_more?:boolean}`；详情、列表及写入响应原样以 JSON 返回模型。
- 写入字段：`operation_id`, `source:{session_id,message_id,explicit:true}`, `name`, `description`, `type`, `body`。
- 更新/遗忘：稳定 ID 放 URL，`expected_revision` 放 body；更新支持 `restore`。
- list 支持 `status:active|forgotten`，默认 active；forgotten 仅用于用户明确恢复时查 ID/revision，不召回旧正文。
- HTTP 错误直接失败，不使用旧详情兜底。索引裁剪保留整行并提示 list 分页。

## 验证

```sh
bun run typecheck
bun run build
bun test
bun run test:host
# 可指定独立二进制路径：
OPENCODE_TEST_BINARY=/path/to/opencode bun run test:host
```

普通测试覆盖真实 HTTP 请求的鉴权、项目字段、快照、刷新、冷重建、1 秒超时、
失败不重试、读写工具及 revision 冲突。hook 输出测试只是辅助证据。

`test:host` 先构建插件，再启用 `memory-host.test.ts`：使用 PATH 中的 OpenCode V2 二进制，以 `run --standalone`
启动私有服务。HOME、XDG、配置、DB 全部位于测试临时目录，不读写当前用户宿主。
运行真实发布入口、Memory/ingest 路由和 SQLite，仅 provider 是本地受控 SSE 服务。
普通 `bun test` 跳过这项外部宿主验收，避免要求所有仓库测试环境全局安装 OpenCode；`test:host` 缺宿主时明确失败，不允许跳过。
2026-10-29 在已安装 OpenCode v2.2.1 上实测通过，捕获真实 HTTP provider JSON：

- 初次请求只有一个短索引区块，无详情正文；read 工具结果进入下一轮请求。
- read→write→最终回复三轮仍只有一个索引，后台写入不改变同会话快照。
- 用户来源通过真实宿主事件→ingest 入库，write 成功且来源是 user 原文，仓库身份一致。
- 冷恢复同一会话及新会话重新读取最新索引；旧区块不堆叠。
- 关闭时最终请求无索引、无记忆工具；索引延迟 3 秒时，约 1 秒即继续发送 provider 请求且无过期注入。
- Memory API 单独集成测试覆盖 409、410、forgotten 元数据发现。
- 分层 API 集成覆盖共享与 build 专属四个 namespace 的 write/read/update/forget、幂等遗忘重试、global 跨项目、project 跨机器及 checkout、无身份 global 读取。
- 真实宿主 write 使用 `agent_key=opencode/build`，验证真实 user 来源 `messages.agent_key`，通过服务端来源检查。
- 同一宿主/同一会话通过真实 `session.switchAgent` 从 build 切换 plan，捕获 provider 请求确认移除 build 专属索引并加入 plan 索引；连续请求无额外 index 网络调用。
- 无仓库身份的另一个工作目录的真实 provider 请求包含共享 global，不包含原仓库 project。

早先源码 SDK 因 `effect/http` 缺失未能启动，现已由上述真实二进制验收替代。
受控 provider 验证的是传输和工具闭环，不代表已测真实模型的语义召回率。
预置跨客户端来源用于 HTTP 读取验证；真实其他客户端采集来源场景仍需单独产品验收。
