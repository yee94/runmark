import { component, computed, effect, signal } from 'eficy'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

function statusClass(status) {
  if (status === 'success') return 'run-status run-status--success'
  if (status === 'running') return 'run-status run-status--running'
  if (status === 'failed') return 'run-status run-status--failed'
  return 'run-status'
}

function statusLabel(status) {
  if (status === 'success') return '成功'
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  return status || '—'
}

function formatTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm'
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's'
  return ms + 'ms'
}

function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function formatCostUsd(n) {
  const value = Number(n || 0)
  if (value >= 1) return '$' + value.toFixed(2)
  return '$' + value.toFixed(4)
}

function shortText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

function parseJson(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function fencedCode(value, language = '') {
  const text = String(value ?? '')
  const fence = text.includes('```') ? '````' : '```'
  return fence + language + '\n' + text + '\n' + fence
}

function jsonMarkdown(value) {
  const parsed = parseJson(value)
  if (parsed == null) return fencedCode(String(value || ''), '')
  return fencedCode(JSON.stringify(parsed, null, 2), 'json')
}

function toolMarkdown(tool) {
  const sections = []
  if (tool.detail) sections.push(String(tool.detail))
  // llm.complete 仅保留 token / error 元信息，不展示冗长 prompt 正文
  if (tool.tool_name === 'llm.complete') {
    const result = parseJson(tool.result)
    if (result && typeof result === 'object') {
      const lines = [
        'Model: ' + (parseJson(tool.args)?.model || '—'),
        'Tokens: in ' + formatTokens(result.input_tokens) + ' · out ' + formatTokens(result.output_tokens) + ' · total ' + formatTokens(result.total_tokens),
      ]
      if (result.error) lines.push('Error: ' + result.error)
      sections.push(lines.join('\n'))
    }
    return sections.join('\n\n') || '暂无 LLM 调用详情'
  }
  return sections.join('\n\n') || '暂无工具调用详情'
}

function outputMarkdown(run) {
  if (run.output_json != null && run.output_json !== '') return jsonMarkdown(run.output_json)
  return String(run.summary || '暂无输出')
}

function turnMarkdown(run) {
  const lines = [
    'Model: ' + (run.model || '—') + (run.provider_id ? ' (' + run.provider_id + ')' : ''),
    'Tokens: in ' + formatTokens(run.input_tokens) + ' · out ' + formatTokens(run.output_tokens) + ' · total ' + formatTokens(run.total_tokens),
    'Duration: ' + formatDuration(run.duration_ms),
    'Cost: ' + formatCostUsd(run.cost_usd),
    'Status: ' + statusLabel(run.status),
  ]
  if (run.error) lines.push('Error: ' + run.error)
  return lines.join('\n')
}

function buildTraceItems(run) {
  if (!run) return []
  const items = []
  if (run.prompt) {
    items.push({
      key: 'prompt-' + run.id,
      kind: 'prompt',
      role: 'user',
      summary: shortText(run.prompt, 'Prompt'),
      fullText: String(run.prompt),
      created_at: run.started_at,
    })
  }
  for (const tool of run.tools || []) {
    const isLlm = tool.tool_name === 'llm.complete'
    const args = parseJson(tool.args)
    const result = parseJson(tool.result)
    const failed = tool.state === 'error' || tool.state === 'failed'
    items.push({
      key: 'tool-' + tool.id,
      kind: 'tool',
      role: failed ? (isLlm ? 'turn-fail' : 'tool-fail') : (isLlm ? 'turn' : 'tool'),
      summary: (tool.tool_name || 'tool') + (tool.detail ? ' · ' + shortText(tool.detail, '') : ''),
      fullText: toolMarkdown(tool),
      created_at: tool.created_at,
      model: isLlm ? (args?.model || run.model || null) : null,
      tokens: isLlm ? Number(result?.total_tokens || 0) : null,
      tool,
    })
  }
  items.push({
    key: 'turn-' + run.id,
    kind: 'turn',
    role: run.status === 'failed' ? 'turn-fail' : 'turn',
    summary: (run.model || 'LLM') + (run.status === 'failed' ? ' · Error' : run.status === 'running' ? ' · Running' : ' · completed'),
    fullText: turnMarkdown(run),
    model: run.model,
    tokens: run.total_tokens || 0,
    cost_usd: run.cost_usd || 0,
    created_at: run.finished_at || run.started_at,
  })
  if (run.output_json || run.summary) {
    items.push({
      key: 'output-' + run.id,
      kind: 'output',
      role: 'assistant',
      summary: shortText(run.summary, 'Agent output'),
      fullText: outputMarkdown(run),
      created_at: run.finished_at || run.started_at,
    })
  }
  items.forEach((item, index) => { item.seq = index + 1 })
  return items
}

export function createAgentRunsPage(ctx) {
  const {
    apiFetch,
    selectedAgentRunId,
    routeAgentRunId,
    activeTab,
    navigate,
    openAgentRun,
    openSession,
    formatDateTime,
    SectionTitle,
  } = ctx
  const runs = signal([])
  const runDetails = signal({})
  const loading = signal(true)
  const detailLoading = signal(false)
  const selectedAgentTraceKey = signal(null)
  const pageSize = signal(30)
  const offset = signal(0)
  const total = signal(0)
  const hasMore = signal(false)
  const retryingRunId = signal(null)
  const retryMessage = signal('')
  let activeDetailId = null

  async function loadRunDetail(id, force = false) {
    if (!id || (!force && runDetails.value[id])) return
    detailLoading.value = true
    try {
      const detail = await apiFetch('/v1/agent-runs/' + encodeURIComponent(id)).then((r) => r.json()).catch(() => null)
      if (detail && detail.id) {
        runDetails.value = { ...runDetails.value, [detail.id]: detail }
      }
    } finally {
      detailLoading.value = false
    }
  }

  function selectRun(id) {
    selectedAgentRunId.value = id
    openAgentRun(id)
  }

  async function loadRuns(nextOffset = offset.value) {
    loading.value = true
    try {
      const data = await apiFetch('/v1/agent-runs?limit=' + pageSize.value + '&offset=' + nextOffset).then((r) => r.json()).catch(() => [])
      const rows = Array.isArray(data) ? data : (data.items || [])
      runs.value = rows
      offset.value = Array.isArray(data) ? 0 : (data.offset || 0)
      total.value = Array.isArray(data) ? rows.length : (data.total || 0)
      hasMore.value = Array.isArray(data) ? false : !!data.has_more
    } finally {
      loading.value = false
    }
  }

  async function retryRun(run = selectedRun.value) {
    if (!run || run.status !== 'failed' || retryingRunId.value) return
    retryingRunId.value = run.id
    retryMessage.value = '正在创建重试任务…'
    try {
      const res = await apiFetch('/v1/agent-runs/' + encodeURIComponent(run.id) + '/retry', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        retryMessage.value = data.error || '重试失败'
        return
      }
      retryMessage.value = '已创建重试任务：' + (data.id || 'Agent run')
      if (data.id) {
        selectedAgentRunId.value = data.id
        runDetails.value = { ...runDetails.value, [data.id]: data }
        openAgentRun(data.id)
        setTimeout(() => loadRunDetail(data.id, true), 800)
      } else {
        navigate('agent-runs')
        await loadRuns(0)
      }
    } finally {
      retryingRunId.value = null
    }
  }

  effect(() => {
    if (activeTab?.value !== 'agent-runs') return
    const detailId = routeAgentRunId.value
    if (detailId) {
      selectedAgentRunId.value = detailId
      if (activeDetailId !== detailId) {
        activeDetailId = detailId
        selectedAgentTraceKey.value = null
      }
      loadRunDetail(detailId)
      return
    }
    activeDetailId = null
    selectedAgentTraceKey.value = null
    loadRuns(0)
  })

  function prevPage() {
    if (loading.value || offset.value <= 0) return
    loadRuns(Math.max(0, offset.value - pageSize.value))
  }

  function nextPage() {
    if (loading.value || !hasMore.value) return
    loadRuns(offset.value + pageSize.value)
  }

  function pageLabel() {
    if (!total.value) return '0 / 0'
    const start = offset.value + 1
    const end = Math.min(offset.value + runs.value.length, total.value)
    return start + '-' + end + ' / ' + total.value
  }

  const selectedRun = computed(() => {
    const id = routeAgentRunId.value || selectedAgentRunId.value
    const summary = runs.value.find((item) => item.id === id) || null
    const detail = runDetails.value[id] || null
    if (!summary && !detail) return null
    return { ...(summary || {}), ...(detail || {}) }
  })

  const traceItems = computed(() => buildTraceItems(selectedRun.value))
  const selectedTrace = computed(() => {
    const items = traceItems.value
    return items.find((item) => item.key === selectedAgentTraceKey.value) || items[items.length - 1] || null
  })
  const selectedTraceHtml = computed(() => marked.parse(String(selectedTrace.value?.fullText || '')))
  const runSummaryHtml = computed(() => {
    const run = selectedRun.value
    return marked.parse(String(run?.summary || run?.error || (run?.status === 'running' ? 'Agent 正在运行' : '暂无执行摘要')))
  })

  function traceDetailLabel(item) {
    if (!item) return ''
    if (item.kind === 'prompt') return 'Prompt'
    if (item.kind === 'tool') return 'Tool · ' + (item.tool?.tool_name || 'tool')
    if (item.kind === 'turn') return item.role === 'turn-fail' ? 'LLM Error · ' + (item.model || '—') : 'LLM Turn · ' + (item.model || '—')
    if (item.kind === 'output') return 'Assistant · Agent Output'
    return item.kind || ''
  }

  const RunIcon = component(({ state }) => (
    <span className={'run-icon run-icon--' + (state || 'ok')}>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'failed' ? (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="m15 9-6 6" />
            <path d="m9 9 6 6" />
          </>
        ) : state === 'running' ? (
          <>
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
          </>
        ) : (
          <path d="M20 6 9 17l-5-5" />
        )}
      </svg>
    </span>
  ))

  const RunRow = component(({ run }) => (
    <div className="agent-run-row" onClick={() => selectRun(run.id)}>
      <div className="agent-run-main">
        <RunIcon state={run.status === 'success' ? 'ok' : run.status} />
        <div>
          <div className="agent-run-title">{run.agent_label || run.agent_name || run.agent_id}</div>
          <div className="agent-run-sub">{run.summary || run.error || run.run_reason || run.id}</div>
        </div>
      </div>
      <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
      <span className="digits">{formatTime(run.started_at)}</span>
      <span>{run.trigger || 'openapi'}</span>
      <span>{run.model || '—'}</span>
      <span className="digits">{formatDuration(run.duration_ms)}</span>
      <span className="digits agent-run-number">{formatTokens(run.total_tokens)}</span>
    </div>
  ))

  const AgentRunsList = component(() => (
    <div className="mock-page fade-up">
      <div className="mock-page-head">
        <h2 className="mock-title">调用记录</h2>
        <div className="mock-head-actions">
          <button className="mock-action-btn" onClick={() => loadRuns(offset.value)}>刷新</button>
        </div>
      </div>
      <section className="agent-runs-table panel-card">
        <div className="agent-runs-head">
          <SectionTitle title="Runs" subtitle="最近 Agent 调用" />
          <span className="count-chip">{total.value} runs</span>
        </div>
        <div className="agent-run-header">
          <span>Agent</span>
          <span>状态</span>
          <span>开始</span>
          <span>触发</span>
          <span>模型</span>
          <span>耗时</span>
          <span className="agent-run-number">Tokens</span>
        </div>
        {loading.value ? <div className="empty-state">Loading runs…</div> : runs.value.length ? runs.value.map((run) => <RunRow key={run.id} run={run} />) : <div className="empty-state">暂无调用记录</div>}
        <div className="agent-runs-footer">
          <span className="count-chip">{pageLabel()}</span>
          <div className="agent-runs-pagination">
            <button className="mock-action-btn" disabled={offset.value <= 0 || loading.value} onClick={prevPage}>上一页</button>
            <button className="mock-action-btn" disabled={!hasMore.value || loading.value} onClick={nextPage}>下一页</button>
          </div>
        </div>
      </section>
    </div>
  ))

  const AgentRunDetail = component(() => {
    const run = selectedRun.value
    const selected = selectedTrace.value
    if (!run) {
      return (
        <div className="fade-up">
          <button className="trace-back" onClick={() => navigate('agent-runs')}>← 返回调用记录</button>
          <div className="panel-card empty-state">{detailLoading.value ? 'Loading run…' : '调用记录不存在'}</div>
        </div>
      )
    }
    return (
      <div className="fade-up">
        <button className="trace-back" onClick={() => navigate('agent-runs')}>← 返回调用记录</button>
        <section className="session-summary-card agent-run-summary-card panel-card">
          <div className="session-summary-head">
            <div>
              <div className="session-summary-kicker">Agent Run</div>
              <h3>{run.agent_label || run.agent_name || run.agent_id}</h3>
            </div>
            <div className="mock-head-actions">
              <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
              {run.status === 'failed' ? (
                <button className="mock-action-btn mock-action-btn--warning" disabled={retryingRunId.value === run.id} onClick={() => retryRun(run)}>
                  {retryingRunId.value === run.id ? '重试中…' : '重试'}
                </button>
              ) : null}
              <button className="mock-action-btn" onClick={() => loadRunDetail(run.id, true)}>刷新</button>
            </div>
          </div>
          {retryMessage.value ? <div className="session-summary-status">{retryMessage.value}</div> : null}
          <div className="markdown-body session-summary-markdown" dangerouslySetInnerHTML={{ __html: runSummaryHtml.value }} />
        </section>

        <div className="panel-card agent-run-trace-card">
          <div className="trace-meta-bar">
            <span className="trace-meta-item"><span className="trace-meta-label">Agent</span><span className="trace-meta-val">{run.agent_id || '—'}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Model</span><span className="trace-meta-val">{run.model || '—'}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Started</span><span className="trace-meta-val">{formatDateTime(run.started_at)}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Ended</span><span className="trace-meta-val">{formatDateTime(run.finished_at)}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Duration</span><span className="trace-meta-val">{formatDuration(run.duration_ms)}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Tokens</span><span className="trace-meta-val">{formatTokens(run.total_tokens)}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Cost</span><span className="trace-meta-val">{formatCostUsd(run.cost_usd)}</span></span>
            <span className="trace-meta-item"><span className="trace-meta-label">Trigger</span><span className="trace-meta-val">{run.trigger || 'openapi'}</span></span>
            {run.target_session_id ? (
              <span className="trace-meta-item"><span className="trace-meta-label">Session Name</span><span className="trace-meta-val trace-meta-link" onClick={() => openSession(run.target_session_id)}>{run.target_session_name || '未命名会话'}</span></span>
            ) : null}
          </div>
          {traceItems.value.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>暂无调用链数据</div>
          ) : (
            <div className="trace-shell">
              <div className="trace-panel">
                <div className="trace-panel-head">
                  调用链
                  <span className="agent-run-trace-legend">
                    <span><i className="trace-role-dot trace-role-dot--user" />Prompt</span>
                    <span><i className="trace-role-dot trace-role-dot--turn" />LLM</span>
                    <span><i className="trace-role-dot trace-role-dot--assistant" />Output</span>
                    <span><i className="trace-role-dot trace-role-dot--tool" />Tool</span>
                    <span><i className="trace-role-dot trace-role-dot--turn-fail" />Error</span>
                  </span>
                </div>
                <div className="trace-list">
                  {traceItems.value.map((item) => (
                    <div
                      key={item.key}
                      className={'trace-row' + (selected?.key === item.key ? ' trace-row--sel' : '')}
                      onClick={() => { selectedAgentTraceKey.value = item.key }}
                    >
                      <span className="trace-seq">{item.seq}</span>
                      <span className={'trace-role-dot trace-role-dot--' + item.role} />
                      <span className="trace-summary" title={item.summary}>{item.summary}</span>
                      <span className="trace-meta trace-time" title={formatDateTime(item.created_at)}>{formatDateTime(item.created_at)}</span>
                      <span className="trace-meta">{item.tokens != null ? formatTokens(item.tokens) : ''}</span>
                      <span className="trace-meta">{item.cost_usd != null ? formatCostUsd(item.cost_usd) : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="trace-panel">
                <div className="trace-panel-head">详情</div>
                {selected ? (
                  <div className="trace-detail">
                    <div className="trace-detail-label">
                      <span>{traceDetailLabel(selected)}</span>
                      <span className="trace-detail-label-time">{formatDateTime(selected.created_at)}</span>
                    </div>
                    {selected.kind === 'turn' ? (
                      <div className="trace-turn-grid">
                        <div className="trace-turn-stat">Tokens<b>{formatTokens(selected.tokens)}</b></div>
                        <div className="trace-turn-stat">Cost<b>{formatCostUsd(selected.cost_usd)}</b></div>
                        <div className="trace-turn-stat">Model<b>{selected.model || '—'}</b></div>
                      </div>
                    ) : null}
                    {selected.kind === 'tool' ? (
                      <div className="trace-turn-grid">
                        <div className="trace-turn-stat">Tool<b>{selected.tool?.tool_name || '—'}</b></div>
                        <div className="trace-turn-stat">State<b>{selected.tool?.state || '—'}</b></div>
                        <div className="trace-turn-stat">Time<b>{formatTime(selected.created_at)}</b></div>
                      </div>
                    ) : null}
                    <div className="markdown-body trace-detail-markdown" dangerouslySetInnerHTML={{ __html: selectedTraceHtml.value }} />
                  </div>
                ) : <div className="trace-detail" style={{ color: 'var(--text-muted)' }}>选择左侧条目查看详情</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  })

  const AgentRunsPage = component(() => routeAgentRunId.value ? <AgentRunDetail /> : <AgentRunsList />)

  return AgentRunsPage
}
