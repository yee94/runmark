import { component, computed } from 'eficy'

export function createSessionRow(ctx) {
  const { formatTokens, formatCost, formatDateTime, formatRelativeTime, formatSessionDuration, routeSessionId, openSession, peek, ChevronIcon, resolveAgentIconUrl, formatAgentLabel, resolveModelIconUrl } = ctx

  /** 从 sessions.model 逗号串或 models[] 解出展示列表 */
  function sessionModelList(s) {
    if (Array.isArray(s.models) && s.models.length) {
      return s.models.map((m) => (typeof m === 'string' ? m : m?.model)).filter(Boolean)
    }
    const raw = String(s.model || '')
    if (!raw) return []
    const parts = []
    const seen = new Set()
    for (const piece of raw.split(',')) {
      const name = piece.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(name)
    }
    return parts
  }

  const SessionRow = component(({ session }) => {
    const summaryText = computed(() => session.value.summary || session.value.title || session.value.id || '—')
    const agent = computed(() => formatAgentLabel?.(session.value.agent) || session.value.agent || '—')
    const agentIcon = computed(() => resolveAgentIconUrl?.(session.value.agent) || null)
    const modelItems = computed(() => {
      const names = sessionModelList(session.value)
      if (!names.length) return [{ name: '—', icon: null }]
      return names.map((name) => {
        const url = resolveModelIconUrl?.(name, session.value.provider) || null
        return {
          name,
          icon: url && !url.endsWith('/unknown.svg') ? url : null,
        }
      })
    })
    const updatedAt = computed(() => session.value.last_activity_at || session.value.started_at)
    const updated = computed(() => formatRelativeTime(updatedAt.value))
    const updatedTitle = computed(() => formatDateTime(updatedAt.value))
    const duration = computed(() => formatSessionDuration(session.value.duration_ms))
    const tokens = computed(() => formatTokens(session.value.total_tokens))
    const cost = computed(() => formatCost(session.value.total_cost_cny))
    const isActive = computed(() => routeSessionId.value === session.value.id)

    return (
      <div
        className={'session-row' + (isActive.value ? ' session-row--active' : '')}
        onClick={() => openSession(peek(session).id)}
      >
        <div className="session-summary-col">
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <ChevronIcon direction="right" />
            <span className="session-summary-text" title={summaryText}>{summaryText}</span>
          </div>
        </div>
        <div className="session-agent-col">
          {agentIcon.value ? (
            <span className="agent-label">
              <img className="agent-label-icon" src={agentIcon.value} alt="" />
              {agent}
            </span>
          ) : (
            <span className="badge badge-agent">{agent}</span>
          )}
        </div>
        <div className="session-model-col">
          <div className="session-model-list" title={modelItems.value.map((m) => m.name).join(', ')}>
            {modelItems.value.map((item, i) => (
              <span className="agent-label session-model-item" key={item.name + '-' + i}>
                {item.icon ? <img className="agent-label-icon" src={item.icon} alt="" /> : null}
                <span className="session-model-text">{item.name}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="session-muted-col" title={updatedTitle}>{updated}</div>
        <div className="session-muted-col">{duration}</div>
        <div className="session-number-col digits">{tokens}</div>
        <div className="session-number-col session-cost-col digits">{cost}</div>
      </div>
    )
  })

  return SessionRow
}

const SparkIcon = component(() => (
  <span className="matter-icon matter-icon--spark">
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8L12 3z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </svg>
  </span>
))

export function createSessionsListPage(ctx) {
  const {
    sessions,
    sessionLimit,
    sessionOffset,
    sessionHasMore,
    sessionQuery,
    sessionSearchInput,
    sessionsLoading,
    sessionAiSearchLoading,
    sessionAiResultsMode,
    sessionAiResultsQuery,
    sessionAiMatchedCount,
    runSessionSearch,
    runAiSessionSearch,
    clearSessionSearch,
    prevSessionPage,
    nextSessionPage,
    SectionTitle,
    EmptyState,
    signal,
    SessionRow,
  } = ctx

  function pageLabel() {
    if (sessionAiResultsMode.value) {
      return 'AI 结果 · ' + sessionAiMatchedCount.value + ' 条 · 「' + sessionAiResultsQuery.value + '」'
    }
    const page = Math.floor((sessionOffset.value || 0) / sessionLimit) + 1
    const q = String(sessionQuery.value || '').trim()
    const base = '第 ' + page + ' 页 · ' + sessions.value.length + ' 条'
    return q ? base + ' · 搜索「' + q + '」' : base
  }

  function emptyMessage() {
    if (sessionAiResultsMode.value) return 'AI 未找到匹配会话'
    if (sessionQuery.value) return '没有匹配的会话'
    return '暂无会话数据'
  }

  const SessionsListPage = component(() => (
    <div className="session-table-panel panel-card fade-up">
      <div className="session-table-head">
        <SectionTitle title="最近会话" subtitle="支持标题 / 摘要 / 消息正文搜索" />
        <span className="count-chip">{pageLabel()}</span>
      </div>
      <div className="session-list-toolbar">
        <input
          className="session-search-input"
          type="search"
          placeholder="搜索会话标题、AISummary 或消息正文…"
          value={sessionSearchInput.value}
          disabled={sessionAiSearchLoading.value}
          onInput={(e) => { sessionSearchInput.value = e.target.value }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSessionSearch()
          }}
        />
        <div className="session-list-toolbar-actions">
          <button className="mock-action-btn mock-action-btn--primary" disabled={sessionsLoading.value || sessionAiSearchLoading.value} onClick={runSessionSearch}>
            搜索
          </button>
          <button className="mock-action-btn" disabled={sessionsLoading.value || sessionAiSearchLoading.value} onClick={runAiSessionSearch}>
            <SparkIcon />
            AI 搜索
          </button>
          {sessionQuery.value || sessionAiResultsMode.value || sessionSearchInput.value
            ? <button className="mock-action-btn" disabled={sessionsLoading.value || sessionAiSearchLoading.value} onClick={clearSessionSearch}>清除</button>
            : null}
        </div>
      </div>
      {sessionAiSearchLoading.value ? (
        <div className="matter-ai-thinking" role="status" aria-live="polite">
          <SparkIcon />
          <span className="matter-ai-thinking-text">思考中</span>
        </div>
      ) : null}
      {sessionsLoading.value && sessions.value.length === 0
        ? <EmptyState message="加载会话…" />
        : sessions.value.length === 0
          ? <EmptyState message={emptyMessage()} />
          : <>
              <div className="session-header">
                <div className="session-summary-col">Summary</div>
                <div className="session-agent-col">Agent</div>
                <div className="session-model-col">Model</div>
                <div>Updated</div>
                <div>Duration</div>
                <div className="session-number-col">Tokens</div>
                <div className="session-number-col">Cost</div>
              </div>
              <div className={'session-list' + (sessionsLoading.value ? ' session-list--loading' : '')}>
                {sessions.value.map((s, i) => (
                  <SessionRow key={s.id || i} session={signal(s)} />
                ))}
              </div>
            </>
      }
      <div className="session-list-footer">
        <span className="count-chip">{pageLabel()}</span>
        {sessionAiResultsMode.value ? null : (
          <div className="session-list-pagination">
            <button className="mock-action-btn" disabled={sessionOffset.value <= 0 || sessionsLoading.value} onClick={prevSessionPage}>上一页</button>
            <button className="mock-action-btn" disabled={!sessionHasMore.value || sessionsLoading.value} onClick={nextSessionPage}>下一页</button>
          </div>
        )}
      </div>
    </div>
  ))

  return SessionsListPage
}
