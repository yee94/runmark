import { component, effect, peek, signal } from 'eficy'
import * as shadcnUi from 'shadcn'

const { Button, Input, Badge, Popover, PopoverTrigger, PopoverContent, Command, CommandInput, CommandList, CommandEmpty, CommandItem } = shadcnUi
const { RefreshCw, Settings2, Check, ChevronsUpDown } = shadcnUi.Lucide
const TYPES = { user: '用户偏好', feedback: '协作反馈', project: '项目约束', reference: '资料入口' }
const SCOPES = { global: '全局', project: '项目' }

function spaceLabel(item) {
  if (item.scope === 'global') return '全部项目'
  if (item.context?.repo_url) return item.context.repo_url.replace(/^[a-z]+:\/\//i, '')
  return item.label
}

function createMemoryPicker(label, onChange) {
  const open = signal(false)
  return component(({ value, options, placeholder, className = '' }) => <Popover open={open.value} onOpenChange={value => { open.value = value }}>
    <PopoverTrigger role="combobox" aria-label={label} aria-expanded={open.value} disabled={!options.length} className={'memory-picker ' + className} title={options.find(item => item.value === value)?.label}>
      <span>{options.find(item => item.value === value)?.label || placeholder || label}</span><ChevronsUpDown size={14} />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={4} className="memory-picker-popover">
      <Command>
        <CommandInput aria-label={'搜索' + label} placeholder={'搜索' + label + '…'} />
        <CommandList><CommandEmpty>没有匹配项</CommandEmpty>
          {options.map(item => <CommandItem key={item.value} value={item.label + ' ' + item.value} onSelect={() => { onChange(item.value); open.value = false }}>
            <span className="memory-picker-option" title={item.label}>{item.label}</span><Check size={14} className={item.value === value ? 'memory-picker-check' : 'memory-picker-check invisible'} />
          </CommandItem>)}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>)
}

export function createMemoriesPage({ apiFetch, activeTab, navigate, selectedAgentId, formatDateTime }) {
  const spaces = signal([])
  const scopeKind = signal('global')
  const agentKey = signal('')
  const spaceId = signal('')
  const items = signal([])
  const query = signal('')
  const type = signal('')
  const status = signal('active')
  const cursor = signal(null)
  const detail = signal(null)
  const detailError = signal('')
  const indexText = signal('')
  const mode = signal('detail')
  const config = signal(null)
  const loading = signal(false)
  const detailLoading = signal(false)
  const saving = signal(false)
  const error = signal('')
  let listVersion = 0
  let detailVersion = 0

  async function request(path, options) {
    const response = await apiFetch(path, options)
    const data = await response.json()
    if (response.status === 401) throw new Error('登录已过期，请刷新页面后通过全站入口登录。')
    if (!response.ok) throw new Error(data.error || '请求失败，请重试')
    return data
  }

  function availableSpaces() {
    return peek(spaces).filter(item => item.scope === peek(scopeKind) && (item.agent_key || '') === peek(agentKey))
  }

  function selectSpace() {
    const available = availableSpaces()
    if (peek(scopeKind) === 'project') {
      if (!available.some(item => item.id === peek(spaceId))) spaceId.value = ''
      return
    }
    if (!available.some(item => item.id === peek(spaceId))) spaceId.value = available[0]?.id || ''
  }

  function scope() {
    if (peek(scopeKind) === 'project' && !peek(spaceId)) return new URLSearchParams({view: 'projects', agent_key: peek(agentKey)})
    const space = peek(spaces).find(item => item.id === peek(spaceId))
    return space ? new URLSearchParams(Object.entries(space.context).filter(([, value]) => value != null)) : null
  }

  async function openMemory(item) {
    const version = ++detailVersion
    mode.value = 'detail'
    detail.value = item
    detailError.value = ''
    detailLoading.value = false
    const params = scope()
    if (!params || item.status === 'forgotten') return
    detailLoading.value = true
    try {
      const data = await request('/v1/memories/' + encodeURIComponent(item.id) + '?' + params)
      if (version === detailVersion) detail.value = data
    } catch (e) {
      if (version === detailVersion) detailError.value = e.message
    } finally {
      if (version === detailVersion) detailLoading.value = false
    }
  }

  async function loadMemories(more = false) {
    const version = ++listVersion
    ++detailVersion
    const params = scope()
    error.value = ''
    detailError.value = ''
    detailLoading.value = false
    mode.value = 'detail'
    if (!more) { items.value = []; detail.value = null; cursor.value = null }
    if (!params) { loading.value = false; return }
    params.set('status', peek(status))
    params.set('query', peek(query).trim())
    if (peek(type)) params.set('type', peek(type))
    if (more && peek(cursor)) params.set('cursor', peek(cursor))
    loading.value = true
    try {
      const data = await request('/v1/memories?' + params)
      if (version !== listVersion) return
      items.value = more ? [...peek(items), ...data.items] : data.items
      cursor.value = data.next_cursor
      if (!more && data.items.length) await openMemory(data.items[0])
    } catch (e) { if (version === listVersion) error.value = e.message }
    finally { if (version === listVersion) loading.value = false }
  }

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const catalog = await request('/v1/memories/scopes')
      spaces.value = catalog.items
      if (peek(agentKey) && !catalog.items.some(item => item.agent_key === peek(agentKey))) agentKey.value = ''
      selectSpace()
      config.value = await request('/v1/agents/agent-memory-extraction/config')
      await loadMemories()
    } catch (e) { error.value = e.message; loading.value = false }
  }

  async function toggleExtraction() {
    saving.value = true
    error.value = ''
    try {
      await request('/v1/agents/agent-memory-extraction/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !peek(config)?.enabled }) })
      config.value = await request('/v1/agents/agent-memory-extraction/config')
    } catch (e) { error.value = e.message }
    finally { saving.value = false }
  }

  async function showIndex() {
    const params = scope()
    if (!params) return
    const version = ++detailVersion
    mode.value = 'index'
    detailLoading.value = true
    detailError.value = ''
    indexText.value = ''
    try {
      const data = await request('/v1/memories/index?' + params)
      if (version === detailVersion) indexText.value = data.markdown || '当前范围没有有效记忆。'
    } catch (e) { if (version === detailVersion) detailError.value = e.message }
    finally { if (version === detailVersion) detailLoading.value = false }
  }

  function configureAgent() {
    selectedAgentId.value = 'agent-memory-extraction'
    navigate('agent-config')
  }

  function changeScope(value) {
    scopeKind.value = value
    selectSpace()
    void loadMemories()
  }

  const AgentPicker = createMemoryPicker('Agent 范围', value => { agentKey.value = value; selectSpace(); void loadMemories() })
  const ProjectPicker = createMemoryPicker('项目', value => { spaceId.value = value; void loadMemories() })
  const TypePicker = createMemoryPicker('记忆类型', value => { type.value = value; void loadMemories() })
  const StatusPicker = createMemoryPicker('记忆状态', value => { status.value = value; void loadMemories() })

  effect(() => { if (activeTab.value === 'memories') void load() })

  return component(() => {
    const available = spaces.value.filter(item => item.scope === scopeKind.value && (item.agent_key || '') === agentKey.value)
    const space = available.find(item => item.id === spaceId.value)
    const allProjects = scopeKind.value === 'project' && !spaceId.value
    const counts = allProjects ? available.reduce((total, item) => ({active_count: total.active_count + item.active_count, forgotten_count: total.forgotten_count + item.forgotten_count}), {active_count: 0, forgotten_count: 0}) : space
    const agents = [...new Set(spaces.value.map(item => item.agent_key).filter(Boolean))].sort()
    const current = detail.value
    return <section className="memory-page">
      <header className="memory-heading">
        <div><h1>记忆</h1><p>长期事实，按适用范围复用。</p></div>
        <div className="memory-actions">
          <Button size="sm" variant="ghost" onClick={toggleExtraction} disabled={saving.value || !config.value} aria-pressed={!!config.value?.enabled}>{saving.value ? '保存中…' : '自动提取：' + (config.value?.enabled ? '开启' : '关闭')}</Button>
          <Button size="sm" variant="ghost" onClick={configureAgent} aria-label="记忆提取设置"><Settings2 size={15} /></Button>
          <Button size="sm" variant="ghost" onClick={() => load()} disabled={loading.value} aria-label="刷新记忆"><RefreshCw size={15} /></Button>
        </div>
      </header>
      {error.value ? <div className="memory-error" role="alert">{error.value}</div> : null}
      <div className="memory-toolbar">
        <div className="memory-scope-tabs" role="group" aria-label="记忆范围">{Object.entries(SCOPES).map(([key, label]) => <Button key={key} size="sm" variant={scopeKind.value === key ? 'secondary' : 'ghost'} aria-pressed={scopeKind.value === key} onClick={() => changeScope(key)}>{label}</Button>)}</div>
        <AgentPicker value={agentKey.value} options={[{value: '', label: '通用 · 所有 Agent'}, ...agents.map(key => ({value: key, label: key}))]} />
        {scopeKind.value !== 'global' ? <ProjectPicker className="memory-target" value={spaceId.value} options={[{value: '', label: '全部项目（清除选择）'}, ...available.map(item => ({value: item.id, label: spaceLabel(item)}))]} /> : null}
      </div>
      <div className="memory-filters">
        <form className="memory-search" onSubmit={event => { event.preventDefault(); void loadMemories() }}><Input aria-label="搜索记忆" placeholder="搜索记忆…" value={query.value} onInput={event => { query.value = event.target.value }} /><Button size="sm" type="submit" variant="ghost">搜索</Button></form>
        <TypePicker value={type.value} options={[{value: '', label: '全部类型'}, ...Object.entries(TYPES).map(([value, label]) => ({value, label}))]} />
        <StatusPicker value={status.value} options={[{value: 'active', label: '有效 · ' + (counts?.active_count || 0)}, {value: 'forgotten', label: '已遗忘 · ' + (counts?.forgotten_count || 0)}]} />
        <Button size="sm" variant="ghost" disabled={!space && !allProjects} onClick={showIndex}>索引</Button>
      </div>
      <div className="memory-workspace">
        <div className="memory-list" aria-label="记忆列表">
          {loading.value && !items.value.length ? <p className="memory-placeholder">读取中…</p> : null}
          {!loading.value && !items.value.length ? <div className="memory-placeholder"><h3>{query.value || type.value ? '没有匹配的记忆' : status.value === 'forgotten' ? '暂无已遗忘记录' : '暂无' + SCOPES[scopeKind.value] + '记忆'}</h3><p>{query.value || type.value ? '调整筛选条件后重试。' : scopeKind.value === 'global' ? '跨项目的偏好与通用协作方式会保存在这里。' : '项目特有的约束、决策和资料入口会保存在这里。'}</p></div> : null}
          {items.value.map(item => <button key={item.id} className={'memory-row' + (current?.id === item.id && mode.value === 'detail' ? ' selected' : '')} onClick={() => openMemory(item)}>
            <div className="memory-row-title"><strong>{item.name}</strong><span>{TYPES[item.type]}</span></div>
            <p>{item.status === 'forgotten' ? '正文已移除' : item.description}</p>
            <small>r{item.revision} · {formatDateTime(item.updated_at)}</small>
            {allProjects ? <small className="memory-project-label">{spaceLabel(available.find(space => space.id === item.project_id) || {label: item.project_id})}</small> : null}
          </button>)}
          {cursor.value ? <Button size="sm" variant="ghost" disabled={loading.value} onClick={() => loadMemories(true)}>加载更多</Button> : null}
        </div>
        <article className="memory-detail" aria-live="polite">
          {detailLoading.value ? <p className="memory-placeholder">读取中…</p> : detailError.value ? <div role="alert" className="memory-error">{detailError.value}</div> : mode.value === 'index' ? <><h2>MEMORY.md</h2><p className="memory-muted">当前范围的短索引，正文按需读取。</p><pre className="memory-code">{indexText.value}</pre></> : current ? <>
            <div className="memory-detail-title"><Badge variant="secondary">{TYPES[current.type]}</Badge><span className="memory-muted">{SCOPES[current.scope] || SCOPES[scopeKind.value]}{current.agent_key ? ' / ' + current.agent_key : ''} · r{current.revision}</span></div>
            <h2>{current.name}</h2><p className="memory-muted">{current.description}</p>
            {current.status === 'forgotten' ? <p className="memory-muted">已失效。需要恢复时，在新对话中明确要求重新保存完整事实。</p> : <>
              <div className="memory-body">{current.body}</div>
              <h3>来源与修订</h3><div className="memory-sources">{(current.sources || []).map(source => <div key={source.revision}><span>r{source.revision} · {formatDateTime(source.created_at)}</span>{source.available ? <a href={'#/sessions/' + encodeURIComponent(source.session_id)}>来源会话</a> : <span className="memory-muted">来源已不可用</span>}{source.assessment ? <details className="memory-assessment"><summary>判断依据</summary><blockquote>{source.assessment.quote}</blockquote><p>留存：{source.assessment.retention_reason}</p><p>范围：{source.assessment.scope_reason}</p></details> : null}</div>)}</div>
            </>}
          </> : <p className="memory-placeholder">选择记忆，查看正文与来源。</p>}
        </article>
      </div>
      <details className="memory-help"><summary>范围与使用方式</summary><p>记忆跨机器共享。全局适用于所有项目；项目随仓库共享。选择命名 Agent 后，只查看它的专属记忆。内容类型与适用范围相互独立。</p><p>自动提取处理开启后的新增对话。OpenCode V2 配置 <code>memoryEnabled=true</code> 后，新会话一次加载适用范围的短索引，详情按需读取。当前明确要求和当前事实始终优先。</p></details>
    </section>
  })
}
