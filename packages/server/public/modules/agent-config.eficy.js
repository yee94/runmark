import { component, computed, effect, signal } from 'eficy'

const TOOL_CATALOG = [
  { id: 'memory.list', label: '项目记忆查询', scope: 'GET /v1/memories', description: '查询当前项目的记忆元数据，判断是否已有同一事实。' },
  { id: 'memory.read', label: '项目记忆详情', scope: 'GET /v1/memories/:id', description: '读取记忆正文、修订号与来源。' },
  { id: 'memory.extraction.write', label: '记忆提取写入', scope: 'WRITE memories', description: '原子提交事实变更和本批提取进度；无可保存内容时提交空变更。' },
  { id: 'sessions.query', label: '会话列表查询', scope: 'GET /v1/sessions', description: '按 limit、offset、user_email 拉取候选会话列表。' },
  { id: 'session.context.read', label: '会话上下文包', scope: 'GET /v1/sessions/:id/*', description: '读取 session、messages、turns、children 与 tool-calls。' },
  { id: 'session.summary.write', label: '会话摘要写入', scope: 'WRITE sessions/session_summaries', description: '更新 Session 标题、AISummary，并写入 session_summaries。' },
  { id: 'matters.query', label: '未归档事项查询', scope: 'GET /v1/matters', description: '读取未归档事项候选，用于判断新会话是否应整合进既有事项。' },
  { id: 'matter.detail.read', label: '事项详情读取', scope: 'GET /v1/matters/:id', description: '读取 matter 正文、依赖、时间线和关联 SessionId，用于整合更新。' },
  { id: 'matter.archive.write', label: '事项归档写入', scope: 'WRITE matter_archives/matter_sessions', description: '新增或更新事项归档，并维护事项与 Session 的关联。' },
  { id: 'turns.query', label: 'Turn 明细查询', scope: 'GET /v1/turns', description: '按 model 或 provider 查询最近 LLM turn。' },
  { id: 'stats.window.read', label: '时间窗口统计', scope: 'GET /v1/stats/*', description: '读取 summary、daily、by-model、by-agent 聚合结果。' },
  { id: 'pricing.read', label: '模型单价读取', scope: 'GET /v1/pricing', description: '读取 provider/model 单价表。' },
  { id: 'cursor.usage.sync', label: 'Cursor 用量同步', scope: 'POST /v1/cursor/sync', description: '触发 Cursor Usage API 对账。' },
]

const TRIGGER_DEFS = [
  { id: 'chat_event', label: '有新对话', description: '使用 schedule 配置触发机制与等待时长。token 顺序不限，例如 debounce:1m、throttle:5m，或按会话防抖 session:debounce:1m / debounce:session:1m。' },
  { id: 'schedule', label: '定时任务', description: '使用 CRON 表达式配置自动运行时间。' },
]

function normalizeAgent(agent) {
  return {
    ...agent,
    tools: Array.isArray(agent?.tools) ? agent.tools : [],
    triggers: Array.isArray(agent?.triggers) ? agent.triggers : [],
  }
}

function triggerById(agent, id) {
  return (agent.triggers || []).find((trigger) => trigger.id === id)
}

function isValidChatEventSchedule(schedule) {
  const tokens = String(schedule || '').trim().split(/\s*:\s*/).filter(Boolean)
  if (!tokens.length) return false
  const hasMode = tokens.some((t) => /^(debounce|throttle)$/i.test(t))
  const hasDuration = tokens.some((t) => /^\d+(?:\.\d+)?\s*(ms|s|m|h)?$/i.test(t))
  return hasMode && hasDuration
}

function parseChatEventSchedule(schedule) {
  const tokens = String(schedule || '').trim().split(/\s*:\s*/).filter(Boolean)
  let mode = null
  let scope = 'agent'
  let waitRaw = null
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'debounce' || lower === 'throttle') mode = lower
    else if (lower === 'session') scope = 'session'
    else if (lower === 'agent' || lower === 'global') scope = 'agent'
    else if (/^\d+(?:\.\d+)?\s*(ms|s|m|h)?$/i.test(token)) waitRaw = token
  }
  return { mode, scope, waitRaw }
}

function formatScheduleDuration(waitRaw) {
  const match = String(waitRaw || '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
  if (!match) return waitRaw || ''
  const amount = match[1]
  const unit = (match[2] || 'ms').toLowerCase()
  if (unit === 'ms') return amount + ' 毫秒'
  if (unit === 's') return amount + ' 秒'
  if (unit === 'm') return amount + ' 分钟'
  if (unit === 'h') return amount + ' 小时'
  return waitRaw
}

/** 根据当前 schedule 协议生成输入框下方的小字说明 */
function chatEventScheduleHint(schedule) {
  const raw = String(schedule || '').trim()
  if (!raw) return '示例：session:debounce:5m · throttle:10m'
  const { mode, scope, waitRaw } = parseChatEventSchedule(raw)
  if (!mode || !waitRaw) return '格式：mode:时长，可加 session，如 debounce:session:5m'
  const duration = formatScheduleDuration(waitRaw)
  if (mode === 'debounce' && scope === 'session') {
    return '按会话防抖：各会话独立计时，安静 ' + duration + ' 后触发'
  }
  if (mode === 'debounce') {
    return '全局防抖：任意会话新事件都会重置，安静 ' + duration + ' 后触发'
  }
  if (mode === 'throttle' && scope === 'session') {
    return '按会话节流：每个会话最多每 ' + duration + ' 触发一次'
  }
  return '全局节流：全部会话共用窗口，最多每 ' + duration + ' 触发一次'
}

function triggerSummary(agent) {
  const labels = []
  for (const trigger of agent.triggers || []) {
    if (!trigger.enabled) continue
    if (trigger.id === 'chat_event') labels.push('新对话 ' + (String(trigger.schedule || '').trim() || '未配置'))
    if (trigger.id === 'schedule') labels.push('定时 ' + (trigger.cron || '* * * * *'))
  }
  return labels.join(' / ') || 'OpenAPI 默认'
}

export function createAgentConfigPage(ctx) {
  const {
    apiFetch,
    selectedAgentId,
    activeTab,
    navigate,
    SectionTitle,
    Button, Input, Textarea, Label,
  } = ctx

  const agents = signal([])
  const models = signal([])
  const loading = signal(true)
  const saving = signal(false)
  const message = signal('')
  const draft = signal(null)
  const saveBarStuck = signal(false)
  let agentEditorEl = null
  let saveBarEl = null
  let saveBarWatchBound = false
  let saveBarCheckQueued = false

  function updateSaveBarStuck() {
    if (!agentEditorEl || !saveBarEl || activeTab?.value !== 'agent-config') {
      saveBarStuck.value = false
      return
    }
    const editorRect = agentEditorEl.getBoundingClientRect()
    const barRect = saveBarEl.getBoundingClientRect()
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    saveBarStuck.value = editorRect.bottom > viewportHeight + 2 && barRect.bottom >= viewportHeight - 2
  }

  function scheduleSaveBarCheck() {
    if (saveBarCheckQueued) return
    saveBarCheckQueued = true
    requestAnimationFrame(() => {
      saveBarCheckQueued = false
      updateSaveBarStuck()
    })
  }

  async function loadAgents() {
    loading.value = true
    try {
      const [agentRows, systemConfig] = await Promise.all([
        apiFetch('/v1/agents').then((r) => r.json()).catch(() => []),
        apiFetch('/v1/system-config').then((r) => r.json()).catch(() => ({ models: [] })),
      ])
      agents.value = agentRows.map(normalizeAgent)
      models.value = systemConfig.models || []
      const selected = agents.value.find((a) => a.id === selectedAgentId.value) || agents.value[0] || null
      if (selected) {
        selectedAgentId.value = selected.id
        draft.value = normalizeAgent(selected)
      }
    } finally {
      loading.value = false
    }
  }

  effect(() => {
    if (activeTab?.value !== 'agent-config') return
    loadAgents()
    if (!saveBarWatchBound) {
      window.addEventListener('scroll', scheduleSaveBarCheck, true)
      window.addEventListener('resize', scheduleSaveBarCheck)
      saveBarWatchBound = true
    }
    scheduleSaveBarCheck()
  })

  const selectedAgent = computed(() => {
    return draft.value || agents.value.find((a) => a.id === selectedAgentId.value) || agents.value[0] || null
  })

  function selectAgent(agent) {
    selectedAgentId.value = agent.id
    draft.value = normalizeAgent(agent)
    message.value = ''
  }

  function patchDraft(patch) {
    draft.value = { ...(draft.value || {}), ...patch }
  }

  function patchTrigger(id, patch) {
    const agent = normalizeAgent(draft.value)
    const triggers = [...agent.triggers]
    const idx = triggers.findIndex((trigger) => trigger.id === id)
    const current = idx >= 0 ? triggers[idx] : { id, enabled: false }
    const next = { ...current, ...patch }
    if (idx >= 0) triggers[idx] = next
    else triggers.push(next)
    patchDraft({ triggers })
  }

  function patchTool(id, enabled) {
    const agent = normalizeAgent(draft.value)
    const tools = new Set(agent.tools)
    if (enabled) tools.add(id)
    else tools.delete(id)
    patchDraft({ tools: [...tools] })
  }

  function publicToolIds(tools) {
    return (tools || []).filter((id) => id !== 'trigger.session_changes' && id !== 'matter.content_filter')
  }

  async function saveAgent() {
    const agent = selectedAgent.value
    if (!agent) return
    const chatTrigger = (agent.triggers || []).find((trigger) => trigger.id === 'chat_event')
    if (chatTrigger?.enabled && !isValidChatEventSchedule(chatTrigger.schedule)) {
      message.value = 'Schedule 格式无效，示例：debounce:1m、throttle:10m、session:debounce:5m'
      return
    }
    saving.value = true
    message.value = ''
    try {
      const res = await apiFetch('/v1/agents/' + encodeURIComponent(agent.id) + '/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !!agent.enabled,
          model_id: agent.model_id,
          tools: publicToolIds(agent.tools),
          triggers: agent.triggers,
          system_prompt: agent.system_prompt,
          task_brief: agent.task_brief,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        message.value = data.error || '保存失败'
        return
      }
      message.value = '已保存'
      await loadAgents()
    } finally {
      saving.value = false
    }
  }

  const AgentGlyph = component(({ active }) => (
    <span className={'config-glyph config-glyph--bot' + (active ? ' config-glyph--active' : '')}>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M12 8V4H8" />
        <path d="M9 13v2" />
        <path d="M15 13v2" />
      </svg>
    </span>
  ))

  const ToolGlyph = component(() => (
    <span className="config-glyph config-glyph--tool">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.8 7.8l-5.7 5.7a2.1 2.1 0 0 1-3-3l5.7-5.7a6 6 0 0 1 7.8-7.8z" />
      </svg>
    </span>
  ))

  const AgentRow = component(({ agent }) => {
    const active = selectedAgentId.value === agent.id
    return (
      <div className={'agent-row' + (active ? ' agent-row--active' : '')} onClick={() => selectAgent(agent)}>
        <div className="agent-row-top">
          <div className="agent-row-main">
            <AgentGlyph active={active} />
            <div className="agent-row-copy">
              <div className="agent-row-name">{agent.label}</div>
              <div className="agent-row-sub">{triggerSummary(agent)}</div>
            </div>
          </div>
          <span className={'agent-row-dot' + (agent.enabled ? ' agent-row-dot--on' : '')} title={agent.enabled ? '启用' : '停用'} />
        </div>
      </div>
    )
  })

  const ToolRow = component(({ tool, enabled }) => (
    <label className={'agent-tool-row' + (enabled ? ' agent-tool-row--enabled' : '')}>
      <input type="checkbox" checked={enabled} onChange={(e) => patchTool(tool.id, e.target.checked)} />
      <ToolGlyph />
      <span className="agent-tool-content">
        <span className="agent-tool-title-line">
          <b>{tool.label}</b>
          <small>{tool.scope}</small>
        </span>
        <em>{tool.description}</em>
      </span>
    </label>
  ))

  const TriggerRow = component(({ agent, def }) => {
    const trigger = triggerById(agent, def.id) || { id: def.id, enabled: false }
    return (
      <div className={'agent-trigger-row' + (trigger.enabled ? ' agent-trigger-row--enabled' : '')}>
        <label className="agent-trigger-row-main">
          <input type="checkbox" checked={!!trigger.enabled} onChange={(e) => patchTrigger(def.id, { enabled: e.target.checked })} />
          <span className="agent-trigger-dot" />
          <span>
            <b>{def.label}</b>
            <small>{def.description}</small>
          </span>
        </label>
        {def.id === 'chat_event' ? (
          <div className="agent-trigger-control agent-trigger-control--compact">
            <Label>Schedule</Label>
            <Input value={trigger.schedule || ''} placeholder="session:debounce:5m" onInput={(e) => patchTrigger(def.id, { schedule: e.target.value })} />
          </div>
        ) : null}
        {def.id === 'chat_event' ? (
          <p className="agent-trigger-schedule-hint">{chatEventScheduleHint(trigger.schedule)}</p>
        ) : null}
        {def.id === 'schedule' ? (
          <div className="agent-trigger-control">
            <Label>CRON 表达式</Label>
            <Input value={trigger.cron || ''} placeholder="30 23 * * *" onInput={(e) => patchTrigger(def.id, { cron: e.target.value })} />
          </div>
        ) : null}
      </div>
    )
  })

  const AgentConfigPage = component(() => {
    const agent = selectedAgent.value
    const model = models.value.find((m) => m.id === agent?.model_id) || models.value[0] || {}
    if (loading.value && !agent) return <div className="mock-page fade-up"><div className="panel-card">Loading agents…</div></div>
    if (!agent) return <div className="mock-page fade-up"><div className="panel-card">暂无智能体配置</div></div>
    return (
      <div className="mock-page fade-up">
        <div className="mock-page-head">
          <h2 className="mock-title">智能体配置</h2>
          <div className="mock-head-actions">
            <button className="mock-action-btn" onClick={() => navigate('agent-runs')}>查看调用记录</button>
            <button className="mock-action-btn" onClick={() => loadAgents()}>刷新</button>
          </div>
        </div>

        <div className="agent-config-layout">
          <aside className="agent-list-panel panel-card">
            <div className="compact-list-head">
              <span>智能体</span>
              <small>{agents.value.length}</small>
            </div>
            {agents.value.map((item) => <AgentRow key={item.id} agent={item} />)}
          </aside>

          <section className="agent-editor panel-card" ref={(el) => { agentEditorEl = el; scheduleSaveBarCheck() }}>
            <div className="agent-editor-head">
              <div>
                <div className="agent-editor-kicker">{agent.label}</div>
                <h3>{agent.name}</h3>
                <p>{agent.description}</p>
              </div>
              <span className={'agent-switch agent-switch--large' + (agent.enabled ? ' agent-switch--on' : '')} onClick={() => patchDraft({ enabled: !agent.enabled })}><span /></span>
            </div>

            <div className="agent-editor-grid">
              <div className="agent-setting-block">
                <h4>模型</h4>
                <div className="mock-field">
                  <Label>Model</Label>
                  <select className="mock-select" value={agent.model_id} onChange={(e) => patchDraft({ model_id: e.target.value })}>
                    {models.value.map((m) => <option key={m.id} value={m.id}>{(m.label || m.model) + ' · ' + (m.purpose || '默认')}</option>)}
                  </select>
                </div>
                <div className="agent-model-note">
                  当前模型为 {model.model || agent.model_id}，运行时通过 model_id 解析 Provider。
                </div>
              </div>

              <div className="agent-setting-block">
                <h4>触发器</h4>
                <div className="agent-trigger-list">
                  {TRIGGER_DEFS.map((def) => <TriggerRow key={def.id} agent={agent} def={def} />)}
                </div>
              </div>
            </div>

            <div className="agent-tool-panel">
              <div className="agent-block-head">
                <SectionTitle title="OpenAPI Tools" subtitle="基于当前服务端 API 暴露的可调用能力" />
              </div>
              <div className="agent-tool-grid">
                {TOOL_CATALOG.map((tool) => <ToolRow key={tool.id} tool={tool} enabled={agent.tools.includes(tool.id)} />)}
              </div>
            </div>

            <div className="agent-prompt-grid agent-prompt-grid--wide">
              <div className="mock-field">
                <Label>Built-in Prompt</Label>
                <Textarea value={agent.system_prompt || ''} rows={8} className="agent-prompt-textarea" onInput={(e) => patchDraft({ system_prompt: e.target.value })} />
              </div>
              <div className="mock-field">
                <Label>布置任务</Label>
                <Textarea value={agent.task_brief || ''} rows={8} className="agent-prompt-textarea" onInput={(e) => patchDraft({ task_brief: e.target.value })} />
              </div>
            </div>

            <div
              className={'agent-save-bar' + (saveBarStuck.value ? ' agent-save-bar--stuck' : '')}
              ref={(el) => { saveBarEl = el; scheduleSaveBarCheck() }}
            >
              <span>{message.value || '保存后将更新当前智能体的触发器、Prompt、Tool 授权与任务布置。'}</span>
              <Button onClick={() => saveAgent()} disabled={saving.value}>{saving.value ? '保存中…' : '保存'}</Button>
            </div>
          </section>
        </div>
      </div>
    )
  })

  return AgentConfigPage
}
