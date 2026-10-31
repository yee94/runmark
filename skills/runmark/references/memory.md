# 分层长期记忆

用户要求回忆约定、保存稳定偏好、纠正或忘记旧事实时使用；寻找历史命令、配置是否执行成功仍走历史搜索与原文取证。一个 Runmark 实例对应一个用户，记忆区分适用范围和内容类型。

## 先确定范围

`scope=global` 跨项目；`scope=project` 针对当前仓库，两者都跨机器共享。`agent_key` 是独立维度，省略为通用，指定如 `opencode/build` 为该真实命名 Agent 专属，不能把客户端产品名当成 Agent。旧调用不传 scope 仍按共享 project 处理。

稳定跨项目偏好可用 global，项目约束用 project。机器和目录只是事实内容，不划分记忆空间。用户明确指定的范围优先；不确定时不扩大到 global。type=user 不等于 scope=global。

先判断是否值得长期留存，再确定事实对象与来源仓库是否匹配。单次交付要求、定时任务正文和 Skill 既有流程保留在原处；身份矛盾或范围无依据时跳过，不用全局兜底。详情 sources.assessment 提供自动提取的原文片段、留存理由、范围理由；历史记录可能为空。提取任务 output_json.batches[].skipped 提供跳过原因。

## 读取与应用

1. 先执行 `runmark_health` 核对服务可用；新接口返回 404 时核对部署版本，不解释为没有记忆。
2. 用真实会话的 `session_id` 或 `repo_url` 定位仓库；没有仓库身份时读取全局。读取当前适用的全部层时传 `view=effective`，只有可靠的命名 Agent 身份才传 agent_key；否则只读通用记忆。
3. 读取短索引，按 hook 找相关记忆。用户明确要求回忆时读取详情；索引不包含完整事实与适用条件，不能单凭标题应用约定。
4. 索引超限时继续查询列表。读取详情后，结合当前用户要求与当前代码事实应用；来源失效或事实冲突要明确指出。用户要求本次忽略记忆时，停止应用历史约定。

```bash
runmark_get /v1/memories/index -G --data-urlencode "session_id=$SESSION_ID" \
  --data-urlencode 'view=effective'
runmark_get /v1/memories -G --data-urlencode "session_id=$SESSION_ID" \
  --data-urlencode 'view=effective' --data-urlencode 'query=发布'
runmark_get "/v1/memories/$MEMORY_ID" -G --data-urlencode "session_id=$SESSION_ID" \
  --data-urlencode 'view=effective'
```

接口复用全站 Cookie、API Key 与公开 Dashboard 策略，不设置独立登录。`GET /v1/memories/scopes` 返回全部可管理空间及可直接使用的 context；旧 `/projects` 保留通用项目目录。需要精确范围时使用目录的 context，不自行拼接 namespace ID。内容类型过滤用 `type`，由服务端在分页前过滤。

## 保存、纠正与遗忘

一条记忆只表达一个可复用事实。保存前搜索已有记录：已有事实用其稳定 ID 更新，新事实才创建。正文用 Markdown，metadata 中的 `type` 区分：

| 类型 | 保存内容 |
|---|---|
| user | 用户背景、稳定偏好；适用范围由 scope 决定 |
| feedback | 用户纠正或认可的协作方式 |
| project | 无法仅从代码推导的动机、约束和决策 |
| reference | 外部文档、工单、看板等查询入口 |

`description` 写成“何时应当读取”的单行 hook。feedback/project 正文包含事实、`Why:` 与 `How to apply:`；缺少依据的原因写未知。已有仓库指令、当前任务进度、凭据和完整工具输出不作为长期记忆保存。

写入必须指定精确 scope/agent_key，不使用 view=effective；携带真实原始会话与消息作为来源。global 可来自任意真实会话，project 必须匹配来源仓库，专属 Agent 必须匹配来源消息的 agent_key。更新前读取当前范围与 revision，不能默认把全局条目当项目条目更新；冲突后重读再判断。只有接口确认成功后才回复“已记住”或“已忘记”。具体请求字段见 [OpenAPI](../openapi.yaml)。

创建时提交 `operation_id`、`source: {session_id,message_id}`、`name`、`description`、`type` 与不带 frontmatter 的 `body`；项目定位同读取。`operation_id` 对同一操作保持不变，重放会返回当前记录状态，状态若为 forgotten 不能声称已重新保存。更新用 `runmark_patch`，遗忘用 `runmark_delete`，均提交 `expected_revision` 与真实来源。恢复须使用新的明确用户消息，并在更新时设置 `restore:true`。

遗忘让记录停止参与后续索引与读取，不会抹除已经进入当前模型上下文的文字，也不删除原始会话。对话中说明旧事实已失效；不把失败的删除当作完成。旧消息重放不能恢复被遗忘的事实，重新保存需要之后的新用户明确要求。

新会话用户明确要求恢复时，用列表的 `status=forgotten` 按 name 查询原 ID 与 revision，再更新并提交完整事实；该查询只返回遗忘记录的元数据，不返回旧正文。普通查询和自动索引始终使用默认 active 范围。

## 格式与生效边界

SQLite 是唯一权威来源，MEMORY.md 是服务端生成的短索引表示，不是需要在工作目录创建的文件。详情 frontmatter 描述 name、description、metadata.type、scope、agent_key、node_type 与首次 originSessionId；以 API 的 ID、revision、状态及完整来源关系核实修订。

OpenCode 新会话一次加载适用的通用与当前 Agent 专属各层索引，正文由工具按需读取；同会话同 Agent 复用快照，切换 Agent 使用对应快照，需最新索引时显式刷新。其余客户端可用本 Skill 查询。当前要求与当前事实优先；历史同主题冲突时 project 比 global 更具体，同范围内 Agent 专属更具体。自动提取与客户端注入分别启用，关闭功能不删除已存记忆。
