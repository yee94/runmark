import { component, effect, peek, signal } from 'eficy'
import * as shadcnUi from 'shadcn'

const { Button, Input, Popover, PopoverTrigger, PopoverContent, Command, CommandInput, CommandList, CommandEmpty, CommandItem, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } = shadcnUi
const { RefreshCw, Settings2, Check, ChevronsUpDown, Search, SlidersHorizontal, ChevronDown, ArrowUpRight, Globe2, Folder, X } = shadcnUi.Lucide
const TYPES = { user: '用户偏好', feedback: '协作反馈', project: '项目约束', reference: '资料入口' }

function spaceLabel(item) {
  if (item.scope === 'global') return '全局记忆'
  if (item.context?.repo_url) return item.context.repo_url.replace(/^[a-z]+:\/\//i, '')
  return item.label
}

function shortProjectLabel(item) {
  return spaceLabel(item)?.split('/').filter(Boolean).pop() || '项目记忆'
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
          {options.map(item => <CommandItem key={item.value} className={item.separatorBefore ? 'memory-picker-project-start' : undefined} value={item.label + ' ' + item.value} onSelect={() => { onChange(item.value); open.value = false }}>
            <span className="memory-picker-option" title={item.label}>{item.label}</span><Check size={14} className={item.value === value ? 'memory-picker-check' : 'memory-picker-check invisible'} />
          </CommandItem>)}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>)
}

export function createMemoriesPage({ apiFetch, activeTab, navigate, selectedAgentId, formatDateTime }) {
  const spaces = signal([])
  const scopeKind = signal('all')
  const agentKey = signal('')
  const spaceId = signal('')
  const items = signal([])
  const query = signal('')
  const appliedQuery = signal('')
  const type = signal('')
  const status = signal('active')
  const cursor = signal(null)
  const detail = signal(null)
  const detailOpen = signal(false)
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
  let searchTimer = null
  let composing = false
  let detailTrigger = null

  function cancelSearch() {
    clearTimeout(searchTimer)
    searchTimer = null
  }

  function searchInput(event) {
    query.value = event.target.value
    cancelSearch()
    if (composing || event.isComposing || event.nativeEvent?.isComposing) return
    searchTimer = setTimeout(() => {
      searchTimer = null
      if (peek(activeTab) === 'memories' && !peek(detailOpen)) void loadMemories()
    }, 300)
  }

  async function request(path, options) {
    const response = await apiFetch(path, options)
    const data = await response.json()
    if (response.status === 401) throw new Error('登录已过期，请刷新页面后通过全站入口登录。')
    if (!response.ok) throw Object.assign(new Error(data.error || '请求失败，请重试'), {status: response.status})
    return data
  }

  function availableSpaces() {
    return peek(spaces).filter(item => (item.agent_key || '') === peek(agentKey))
  }

  function selectSpace() {
    if (!availableSpaces().some(item => item.id === peek(spaceId))) spaceId.value = ''
  }

  function scope() {
    if (peek(scopeKind) === 'all') return new URLSearchParams({view: 'all', agent_key: peek(agentKey)})
    if (peek(scopeKind) === 'global') return new URLSearchParams({scope: 'global', agent_key: peek(agentKey)})
    if (peek(scopeKind) === 'project' && !peek(spaceId)) return new URLSearchParams({view: 'projects', agent_key: peek(agentKey)})
    const space = peek(spaces).find(item => item.id === peek(spaceId))
    return space ? new URLSearchParams(Object.entries(space.context).filter(([, value]) => value != null)) : null
  }

  function openMemory(item, event) {
    cancelSearch()
    detailTrigger = event?.currentTarget || null
    detailOpen.value = true
    void readMemory(item)
  }

  function setDetailOpen(open) {
    detailOpen.value = open
    if (!open) {
      ++detailVersion
      detailLoading.value = false
      if (peek(activeTab) === 'memories' && peek(query).trim() !== peek(appliedQuery)) searchInput({target: {value: peek(query)}})
    }
  }

  async function readMemory(item) {
    const version = ++detailVersion
    mode.value = 'detail'
    detail.value = item
    detailError.value = ''
    detailLoading.value = false
    const params = new URLSearchParams({view: 'all', agent_key: item.agent_key || ''})
    if (item?.status === 'forgotten') return
    detailLoading.value = true
    try {
      const data = await request('/v1/memories/' + encodeURIComponent(item.id) + '?' + params)
      if (version === detailVersion) detail.value = data
    } catch (e) {
      if (version === detailVersion) detailError.value = e.status === 410 ? '这条记忆已被遗忘，正文已移除。' : e.status === 404 ? '未找到这条记忆，请返回列表重新选择。' : e.message
    } finally {
      if (version === detailVersion) detailLoading.value = false
    }
  }

  async function loadMemories(more = false) {
    if (!more) { cancelSearch(); appliedQuery.value = peek(query).trim() }
    const version = ++listVersion
    if (!more) ++detailVersion
    const params = scope()
    error.value = ''
    if (!more) { detailError.value = ''; detailLoading.value = false }
    if (!more) { mode.value = 'detail'; items.value = []; detail.value = null; cursor.value = null }
    if (!params) { loading.value = false; return }
    params.set('status', peek(status))
    params.set('query', peek(appliedQuery))
    if (peek(type)) params.set('type', peek(type))
    if (more && peek(cursor)) params.set('cursor', peek(cursor))
    loading.value = true
    try {
      const data = await request('/v1/memories?' + params)
      if (version !== listVersion) return
      items.value = more ? [...peek(items), ...data.items] : data.items
      cursor.value = data.next_cursor
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
      await Promise.all([
        loadMemories(),
        request('/v1/agents/agent-memory-extraction/config').then(data => { config.value = data }).catch(e => { error.value = e.message }),
      ])
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
    scopeKind.value = value === 'all' || value === 'global' ? value : 'project'
    spaceId.value = value === 'all' || value === 'global' || value === 'projects' ? '' : value
    void loadMemories()
  }

  function resetFilters() {
    scopeKind.value = 'all'
    spaceId.value = ''
    agentKey.value = ''
    type.value = ''
    status.value = 'active'
    query.value = ''
    void loadMemories()
  }

  const ScopePicker = createMemoryPicker('适用范围', changeScope)
  const AgentPicker = createMemoryPicker('Agent 范围', value => { agentKey.value = value; selectSpace(); void loadMemories() })
  const TypePicker = createMemoryPicker('记忆类型', value => { type.value = value; void loadMemories() })
  const StatusPicker = createMemoryPicker('记忆状态', value => { status.value = value; void loadMemories() })

  effect(() => { if (activeTab.value === 'memories') void load(); else { cancelSearch(); setDetailOpen(false) } })

  return component(() => {
    const available = spaces.value.filter(item => (item.agent_key || '') === agentKey.value)
    const selectedSpaces = available.filter(item => (scopeKind.value === 'all' || item.scope === scopeKind.value) && (!spaceId.value || item.id === spaceId.value))
    const counts = selectedSpaces.reduce((total, item) => ({active_count: total.active_count + item.active_count, forgotten_count: total.forgotten_count + item.forgotten_count}), {active_count: 0, forgotten_count: 0})
    const agents = [...new Set(spaces.value.map(item => item.agent_key).filter(Boolean))].sort()
    const current = detail.value
    const currentSpace = spaces.value.find(space => space.id === current?.project_id)
    const filterCount = Number(!!agentKey.value) + Number(!!type.value) + Number(status.value !== 'active')
    const hasFilters = scopeKind.value !== 'all' || filterCount > 0 || !!appliedQuery.value
    return <section className="memory-page">
      <header className="memory-heading">
        <div><h1>记忆<span className="memory-total">{counts.active_count}</span></h1><p>已记住的偏好、协作约定与项目知识。</p></div>
        <div className="memory-actions">
          {config.value ? <span className={'memory-extraction-state' + (config.value.enabled ? ' enabled' : '')}><i />{config.value.enabled ? '自动提取已开启' : '自动提取已关闭'}</span> : null}
          <Button size="sm" variant="ghost" onClick={() => load()} disabled={loading.value} aria-label="刷新记忆"><RefreshCw size={15} /></Button>
          <Popover><PopoverTrigger className="memory-tool-trigger" aria-label="记忆管理"><Settings2 size={15} /><span>管理</span></PopoverTrigger><PopoverContent align="end" className="memory-manage-popover">
            <Button size="sm" variant="ghost" onClick={toggleExtraction} disabled={saving.value || !config.value} aria-pressed={!!config.value?.enabled}>{saving.value ? '保存中…' : config.value?.enabled ? '关闭自动提取' : '开启自动提取'}</Button>
            <Button size="sm" variant="ghost" onClick={configureAgent}>记忆提取设置</Button>
            <Button size="sm" variant="ghost" onClick={showIndex}>查看短索引</Button>
          </PopoverContent></Popover>
        </div>
      </header>
      {error.value ? <div className="memory-error" role="alert">{error.value}</div> : null}
      <div className="memory-toolbar">
        <form className="memory-search" onSubmit={event => { event.preventDefault(); if (!composing) void loadMemories() }}><Search size={16} /><Input aria-label="搜索记忆" placeholder="搜索偏好、约定或项目知识…" value={query.value} onInput={searchInput} onCompositionStart={() => { composing = true; cancelSearch() }} onCompositionEnd={event => { composing = false; searchInput(event) }} /><Button size="sm" type="submit" variant="ghost">搜索</Button></form>
        <ScopePicker className="memory-scope-picker" value={spaceId.value || (scopeKind.value === 'project' ? 'projects' : scopeKind.value)} options={[{value: 'all', label: '所有范围'}, {value: 'global', label: '全局记忆'}, {value: 'projects', label: '所有项目'}, ...available.filter(item => item.scope === 'project').map((item, index) => ({value: item.id, label: spaceLabel(item), separatorBefore: index === 0}))]} />
        <Popover><PopoverTrigger className={'memory-tool-trigger' + (filterCount ? ' active' : '')}><SlidersHorizontal size={15} />筛选{filterCount ? <span className="memory-filter-count">{filterCount}</span> : null}</PopoverTrigger><PopoverContent align="end" className="memory-filter-popover">
          <label>归属 Agent</label><AgentPicker value={agentKey.value} options={[{value: '', label: '共享记忆'}, ...agents.map(key => ({value: key, label: key}))]} />
          <label>内容类型</label><TypePicker value={type.value} options={[{value: '', label: '全部类型'}, ...Object.entries(TYPES).map(([value, label]) => ({value, label}))]} />
          <label>记忆状态</label><StatusPicker value={status.value} options={[{value: 'active', label: '有效记忆 · ' + counts.active_count}, {value: 'forgotten', label: '已遗忘 · ' + counts.forgotten_count}]} />
        </PopoverContent></Popover>
      </div>
      <div className="memory-feed-heading">
        <h2>{status.value === 'forgotten' ? '已遗忘的记忆' : hasFilters ? '筛选结果' : '最近记住的事'}<span>{items.value.length ? '已显示 ' + items.value.length + ' 条' : ''}</span></h2>
        {hasFilters ? <Button size="sm" variant="ghost" onClick={resetFilters}><X size={13} />清除筛选</Button> : <span>按最近更新排序</span>}
      </div>
      {mode.value === 'index' ? <section className="memory-index" aria-label="记忆短索引"><div><h2>记忆短索引</h2><Button size="sm" variant="ghost" aria-label="关闭短索引" onClick={() => { ++detailVersion; detailLoading.value = false; mode.value = 'detail'; detail.value = null }}><X size={15} /></Button></div>{detailLoading.value ? <p className="memory-muted">读取中…</p> : detailError.value ? <p role="alert" className="memory-error">{detailError.value}</p> : <pre className="memory-code">{indexText.value}</pre>}</section> : null}
      <div className="memory-feed" aria-label="记忆列表" aria-busy={loading.value}>
        {loading.value && !items.value.length ? <div className="memory-placeholder" role="status">正在读取记忆…</div> : null}
        {!loading.value && !items.value.length ? <div className="memory-placeholder"><h3>{hasFilters ? '没有匹配的记忆' : '还没有记忆'}</h3><p>{hasFilters ? '试试其他关键词，或清除筛选条件。' : '在对话中说「请记住」，把值得下次继续使用的偏好和约定留在这里。'}</p></div> : null}
        {items.value.map(item => {
          const space = spaces.value.find(space => space.id === item.project_id)
          const project = space || {label: item.project_id}
          return <article key={item.id} className="memory-card" data-type={item.type}>
            <button className="memory-card-summary" aria-haspopup="dialog" onClick={event => openMemory(item, event)}>
              <div className="memory-card-top"><span className="memory-type"><i />{TYPES[item.type]}</span><span className="memory-card-scope" title={item.scope === 'global' ? '适用于所有项目' : spaceLabel(project)}>{item.scope === 'global' ? <Globe2 size={12} /> : <Folder size={12} />}{item.scope === 'global' ? '全局记忆' : shortProjectLabel(project)}</span></div>
              <h3>{item.status === 'forgotten' ? item.name : item.description}</h3>
              <div className="memory-card-id" title={item.name}>{item.name}</div>
              <div className="memory-card-footer"><time dateTime={item.updated_at}>{formatDateTime(item.updated_at)}</time><span>{item.agent_key || ''}</span><span className="memory-read-label">查看详情<ArrowUpRight size={13} /></span></div>
            </button>
          </article>
        })}
      </div>
      {cursor.value ? <div className="memory-load-more"><Button size="sm" variant="outline" disabled={loading.value} onClick={() => loadMemories(true)}>{loading.value ? '正在读取…' : '查看更多记忆'}<ChevronDown size={14} /></Button></div> : null}
      <Dialog open={detailOpen.value} onOpenChange={setDetailOpen}><DialogContent className="memory-detail-dialog" data-type={current?.type} onCloseAutoFocus={event => { if (detailTrigger?.isConnected) { event.preventDefault(); detailTrigger.focus({preventScroll: true}) } }}>
        <DialogHeader className="memory-dialog-header">
          {current ? <div className="memory-card-top"><span className="memory-type"><i />{TYPES[current.type]}</span><span className="memory-card-scope" title={currentSpace ? spaceLabel(currentSpace) : ''}>{current.scope === 'global' ? <Globe2 size={13} /> : <Folder size={13} />}{current.scope === 'global' ? '全局记忆' : shortProjectLabel(currentSpace || {label: current.project_id})}</span></div> : null}
          <DialogTitle className="memory-dialog-title">{current ? current.status === 'forgotten' ? current.name : current.description : '记忆详情'}</DialogTitle>
          <DialogDescription className="memory-dialog-id">{current?.name}</DialogDescription>
          {current ? <div className="memory-dialog-meta"><time dateTime={current.updated_at}>{formatDateTime(current.updated_at)}</time><span>r{current.revision}</span>{current.agent_key ? <span>{current.agent_key}</span> : null}</div> : null}
        </DialogHeader>
        <div className="memory-dialog-content" aria-live="polite" aria-busy={detailLoading.value}>
          {detailLoading.value ? <p className="memory-muted" role="status">正在读取正文…</p> : detailError.value ? <div className="memory-error" role="alert">{detailError.value}<Button size="sm" variant="ghost" onClick={() => readMemory(current)}>重试</Button></div> : current?.status === 'forgotten' ? <p className="memory-muted">正文已移除。如需恢复，请在新对话中明确要求重新保存完整事实。</p> : current ? <><div className="memory-body">{current.body}</div><section className="memory-dialog-sources"><h3>来源与修订<span>{current.sources?.length || 0} 条记录</span></h3><div className="memory-sources">{(current.sources || []).map(source => <div key={source.revision}><span>r{source.revision} · {formatDateTime(source.created_at)}</span>{source.available ? <a href={'#/sessions/' + encodeURIComponent(source.session_id)}>查看来源会话<ArrowUpRight size={12} /></a> : <span className="memory-muted">来源已不可用</span>}{source.assessment ? <details className="memory-assessment"><summary>判断依据</summary><blockquote>{source.assessment.quote}</blockquote><p>留存：{source.assessment.retention_reason}</p><p>范围：{source.assessment.scope_reason}</p></details> : null}</div>)}</div></section></> : null}
        </div>
        <div className="memory-dialog-footer"><DialogClose asChild><Button size="sm" variant="outline">关闭</Button></DialogClose></div>
      </DialogContent></Dialog>
      <details className="memory-help"><summary>范围与使用方式</summary><p>记忆跨机器共享。全局适用于所有项目；项目随仓库共享。选择命名 Agent 后，只查看它的专属记忆。内容类型与适用范围相互独立。</p><p>自动提取处理开启后的新增对话。OpenCode V2 配置 <code>memoryEnabled=true</code> 后，新会话一次加载适用范围的短索引，详情按需读取。当前明确要求和当前事实始终优先。</p></details>
    </section>
  })
}
