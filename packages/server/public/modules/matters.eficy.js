import { component, computed, signal, effect } from 'eficy'
import { marked } from 'marked'
import moment from 'moment'

async function copyText(text) {
  const value = String(text || '')
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch (err) {}
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('copy failed')
}

function formatMatterUpdated(iso) {
  if (!iso) return '—'
  const m = moment(iso)
  if (!m.isValid()) return '—'
  const diffMin = moment().diff(m, 'minutes')
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return diffMin + ' m ago'
  const diffH = moment().diff(m, 'hours')
  if (diffH < 24) return diffH + ' h ago'
  return m.format('MMM D, HH:mm')
}

function formatMatter(row) {
  return {
    ...row,
    statusLabel: row.status === 'archived'
      ? '已归档'
      : row.status === 'summarizing'
        ? '重新归档中'
        : row.status === 'failed'
          ? '总结失败'
          : (row.status === 'done' || row.status === 'active')
            ? '已完成'
            : '总结中',
    summary: row.summary || row.topic || '',
    modules: Array.isArray(row.dependency_refs) && row.dependency_refs.length ? row.dependency_refs.slice(0, 3) : [row.effort_level || 'Matter'],
    updated: formatMatterUpdated(row.updated_at),
    updatedTitle: row.updated_at ? moment(row.updated_at).format('YYYY-MM-DD HH:mm:ss') : '',
  }
}

function matterUpdatedMs(matter) {
  const ms = new Date(matter?.updated_at || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function sessionTime(session) {
  return session.last_activity_at || session.ended_at || session.started_at || ''
}

function sessionTitle(session) {
  return session.summary || session.title || session.id
}

function formatSessionDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const MatterIcon = component(({ variant }) => (
  <span className={'matter-icon matter-icon--' + (variant || 'doc')}>
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {variant === 'spark' ? (
        <>
          <path d="M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8L12 3z" />
          <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
        </>
      ) : variant === 'archive' ? (
        <>
          <rect width="18" height="4" x="3" y="4" rx="1" />
          <path d="M5 8v11h14V8" />
          <path d="M10 12h4" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </>
      )}
    </svg>
  </span>
))

marked.setOptions({ gfm: true, breaks: false })

const MarkdownView = component(({ markdown }) => {
  const html = marked.parse(String(markdown || ''))
  return <div className="markdown-body matter-markdown" dangerouslySetInnerHTML={{ __html: html }} />
})

function badgeClass(type) {
  const key = String(type || '').toLowerCase()
  if (key === 'feature') return 'matter-badge matter-badge--feature'
  if (key === 'api') return 'matter-badge matter-badge--api'
  if (key === 'fix') return 'matter-badge matter-badge--api'
  return 'matter-badge'
}

const RESUMMARIZE_SESSION_PAGE_SIZE = 50
const MATTER_PAGE_SIZE = 50

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createMattersPage(ctx) {
  const {
    apiFetch,
    selectedMatterId,
    selectedMatterTab,
    focusMatterRoute,
    activeTab,
    SectionTitle,
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } = ctx
  const matters = signal([])
  const loading = signal(true)
  const matterOffset = signal(0)
  const matterHasMore = signal(false)
  const matterQuery = signal('')
  const matterSearchInput = signal('')
  const aiSearchLoading = signal(false)
  const aiResultsMode = signal(false)
  const aiResultsQuery = signal('')
  const aiResultIds = signal([])
  const aiMatchedCount = signal(0)
  const busy = signal(false)
  const runningMatterId = signal(null)
  const archivedCount = signal(0)
  const copiedMatterId = signal(null)
  const message = signal('')
  const resummarizeDialogOpen = signal(false)
  const resummarizeSessions = signal([])
  const resummarizeSessionsLoading = signal(false)
  const resummarizeSessionPage = signal(0)
  const resummarizeSessionHasMore = signal(false)
  const selectedResummarizeSessionIds = signal([])
  const resummarizeMatterDraft = signal(null)
  let loadedMatterTab = null
  let matterLoadVersion = 0
  let aiSearchVersion = 0

  async function loadArchivedCount() {
    const archiveRows = await apiFetch('/v1/matters?tab=archive').then((r) => r.json()).catch(() => [])
    archivedCount.value = Array.isArray(archiveRows) ? archiveRows.length : 0
  }

  function mattersQueryString(tab = selectedMatterTab.value, offset = matterOffset.value) {
    const params = new URLSearchParams()
    params.set('tab', tab === 'archive' ? 'archive' : 'summary')
    params.set('limit', String(MATTER_PAGE_SIZE))
    params.set('offset', String(Math.max(0, Number(offset) || 0)))
    const q = String(matterQuery.value || '').trim()
    if (q) params.set('q', q)
    return '?' + params.toString()
  }

  async function loadMatters(tab = selectedMatterTab.value) {
    const loadVersion = ++matterLoadVersion
    loading.value = true
    try {
      const rows = await apiFetch('/v1/matters' + mattersQueryString(tab)).then((r) => r.json()).catch(() => [])
      if (loadVersion !== matterLoadVersion) return
      const list = Array.isArray(rows) ? rows : []
      matters.value = list.map(formatMatter).sort((a, b) => matterUpdatedMs(b) - matterUpdatedMs(a))
      matterHasMore.value = list.length >= MATTER_PAGE_SIZE
      loadArchivedCount()
      if (!matters.value.find((m) => m.id === selectedMatterId.value) && matters.value[0]) {
        selectedMatterId.value = matters.value[0].id
        focusMatterRoute?.(matters.value[0].id, { tab })
      }
    } finally {
      if (loadVersion === matterLoadVersion) loading.value = false
    }
  }

  function restoreNormalListMode() {
    aiSearchVersion += 1
    aiSearchLoading.value = false
    aiResultsMode.value = false
    aiResultsQuery.value = ''
    aiResultIds.value = []
    aiMatchedCount.value = 0
  }

  effect(() => {
    if (activeTab?.value !== 'matters') {
      loadedMatterTab = null
      return
    }
    const tab = selectedMatterTab.value
    if (tab === loadedMatterTab) return
    loadedMatterTab = tab
    restoreNormalListMode()
    matterOffset.value = 0
    loadMatters(tab)
  })

  function openMatterTab(tab) {
    restoreNormalListMode()
    matterOffset.value = 0
    matterHasMore.value = false
    loadedMatterTab = tab
    selectedMatterTab.value = tab
    loadMatters(tab)
    if (selectedMatterId.value) focusMatterRoute?.(selectedMatterId.value, { tab })
  }

  function runMatterSearch() {
    restoreNormalListMode()
    matterQuery.value = String(matterSearchInput.value || '').trim()
    matterOffset.value = 0
    loadMatters(selectedMatterTab.value)
  }

  function clearMatterSearch() {
    restoreNormalListMode()
    matterSearchInput.value = ''
    matterQuery.value = ''
    matterOffset.value = 0
    loadMatters(selectedMatterTab.value)
  }

  function prevMatterPage() {
    if (matterOffset.value <= 0 || loading.value) return
    matterOffset.value = Math.max(0, matterOffset.value - MATTER_PAGE_SIZE)
    loadMatters(selectedMatterTab.value)
  }

  function nextMatterPage() {
    if (!matterHasMore.value || loading.value) return
    matterOffset.value = matterOffset.value + MATTER_PAGE_SIZE
    loadMatters(selectedMatterTab.value)
  }

  function matterPageLabel() {
    if (aiResultsMode.value) {
      return 'AI 结果 · ' + aiMatchedCount.value + ' 条 · 「' + aiResultsQuery.value + '」'
    }
    const page = Math.floor((matterOffset.value || 0) / MATTER_PAGE_SIZE) + 1
    const q = String(matterQuery.value || '').trim()
    const base = '第 ' + page + ' 页 · ' + matters.value.length + ' 条'
    return q ? base + ' · 搜索「' + q + '」' : base
  }

  function parseAgentSearchOutput(data) {
    let output = data?.output_json ?? data?.output ?? data
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output)
      } catch (err) {
        return null
      }
    }
    return output && Array.isArray(output.matter_ids) ? output : null
  }

  async function fetchAiMatterRows(ids) {
    const rows = await Promise.all(ids.map(async (id) => {
      const res = await apiFetch('/v1/matters/' + encodeURIComponent(id)).catch(() => null)
      if (!res?.ok) return null
      return res.json().catch(() => null)
    }))
    return rows.filter(Boolean).map(formatMatter)
  }

  async function showAiSearchResults(output, query, searchVersion) {
    const ids = output.matter_ids.map((id) => String(id)).filter(Boolean)
    const rows = await fetchAiMatterRows(ids)
    if (searchVersion !== aiSearchVersion) return false
    if (ids.length && !rows.length) throw new Error('AI 搜索已完成，事项详情加载失败')
    matterLoadVersion += 1
    matterOffset.value = 0
    matterHasMore.value = false
    aiResultIds.value = ids
    aiMatchedCount.value = Number.isFinite(Number(output.matched_count)) ? Number(output.matched_count) : ids.length
    aiResultsQuery.value = String(output.query || query)
    aiResultsMode.value = true
    matters.value = rows
    if (rows[0]) {
      selectedMatterId.value = rows[0].id
      focusMatterRoute?.(rows[0].id, { tab: selectedMatterTab.value })
    } else {
      selectedMatterId.value = null
    }
    const missingCount = Math.max(0, ids.length - rows.length)
    message.value = missingCount
      ? 'AI 搜索完成：找到 ' + aiMatchedCount.value + ' 个事项，已载入 ' + rows.length + ' 个'
      : 'AI 搜索完成：找到 ' + aiMatchedCount.value + ' 个事项'
    return true
  }

  async function pollAiSearchJob(jobId, query, searchVersion) {
    for (let i = 0; i < 90; i++) {
      if (searchVersion !== aiSearchVersion) return false
      const res = await apiFetch('/v1/agent-runs/' + encodeURIComponent(jobId)).catch(() => null)
      const run = res?.ok ? await res.json().catch(() => null) : null
      if (searchVersion !== aiSearchVersion) return false
      if (run?.status === 'success') {
        const output = parseAgentSearchOutput(run)
        if (!output) throw new Error('AI 搜索结果格式异常')
        return showAiSearchResults(output, query, searchVersion)
      }
      if (run?.status === 'failed') throw new Error(run.error || 'AI 搜索失败')
      await sleep(2000)
    }
    if (searchVersion === aiSearchVersion) message.value = 'AI 搜索等待超时：任务 ' + jobId + ' 仍在运行，可在调用记录查看进度'
    return false
  }

  async function runAiMatterSearch() {
    const query = String(matterSearchInput.value || '').trim()
    if (!query) {
      message.value = '请输入要查找的事项描述'
      return
    }
    restoreNormalListMode()
    const searchVersion = aiSearchVersion
    matterLoadVersion += 1
    loading.value = false
    aiSearchLoading.value = true
    message.value = ''
    try {
      const res = await apiFetch('/v1/matters/agent-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json().catch(() => ({}))
      if (searchVersion !== aiSearchVersion) return
      if (!res.ok) throw new Error(data.error || data.summary || 'AI 搜索启动失败')
      if (res.status === 202) {
        if (!data.id) throw new Error('AI 搜索任务缺少任务 ID')
        await pollAiSearchJob(data.id, query, searchVersion)
        return
      }
      const output = parseAgentSearchOutput(data)
      if (!output) throw new Error('AI 搜索结果格式异常')
      await showAiSearchResults(output, query, searchVersion)
    } catch (err) {
      if (searchVersion === aiSearchVersion) message.value = err?.message || 'AI 搜索失败，请稍后重试'
    } finally {
      if (searchVersion === aiSearchVersion) aiSearchLoading.value = false
    }
  }

  async function refreshAiResults() {
    if (!aiResultsMode.value) {
      loadMatters(selectedMatterTab.value)
      return
    }
    const loadVersion = ++matterLoadVersion
    loading.value = true
    try {
      const rows = await fetchAiMatterRows(aiResultIds.value)
      if (loadVersion !== matterLoadVersion) return
      matters.value = rows
      loadArchivedCount()
      if (!rows.find((matter) => matter.id === selectedMatterId.value) && rows[0]) {
        selectedMatterId.value = rows[0].id
        focusMatterRoute?.(rows[0].id, { tab: selectedMatterTab.value })
      }
      message.value = 'AI 搜索结果已刷新'
    } finally {
      if (loadVersion === matterLoadVersion) loading.value = false
    }
  }

  const selectedMatter = computed(() => {
    return matters.value.find((m) => m.id === selectedMatterId.value) || matters.value[0] || null
  })

  const selectedResummarizeCount = computed(() => selectedResummarizeSessionIds.value.length)

  function setSelectedSessionIds(ids) {
    selectedResummarizeSessionIds.value = Array.from(new Set((ids || []).map((id) => String(id)).filter(Boolean)))
  }

  function toggleSession(id) {
    const key = String(id)
    const current = selectedResummarizeSessionIds.value
    setSelectedSessionIds(current.includes(key) ? current.filter((v) => v !== key) : [...current, key])
  }

  function navigateToSession(id) {
    if (!id) return
    location.hash = '#/sessions/' + encodeURIComponent(String(id))
  }

  function selectSessionRange(range) {
    const rows = resummarizeSessions.value
    const now = Date.now()
    const shifted = new Date(now + 8 * 60 * 60 * 1000)
    const todayStartMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000
    if (range === 'linked') {
      setSelectedSessionIds(resummarizeMatterDraft.value?.relatedSessionIds || [])
      return
    }
    if (range === 'all') {
      setSelectedSessionIds(rows.map((s) => s.id))
      return
    }
    const from = range === 'today'
      ? todayStartMs
      : range === '24h'
        ? now - 24 * 60 * 60 * 1000
        : range === '7d'
          ? now - 7 * 24 * 60 * 60 * 1000
          : 0
    setSelectedSessionIds(rows.filter((s) => {
      const t = new Date(sessionTime(s)).getTime()
      return Number.isFinite(t) && t >= from
    }).map((s) => s.id))
  }

  async function loadResummarizeSessions(matter, page = resummarizeSessionPage.value) {
    resummarizeSessionsLoading.value = true
    try {
      const safePage = Math.max(0, Number(page) || 0)
      const offset = safePage * RESUMMARIZE_SESSION_PAGE_SIZE
      const rows = await apiFetch('/v1/sessions?limit=' + RESUMMARIZE_SESSION_PAGE_SIZE + '&offset=' + offset)
        .then((r) => r.json())
        .catch(() => [])
      const list = Array.isArray(rows) ? rows : []
      resummarizeSessions.value = list
      resummarizeSessionPage.value = safePage
      resummarizeSessionHasMore.value = list.length === RESUMMARIZE_SESSION_PAGE_SIZE
    } finally {
      resummarizeSessionsLoading.value = false
    }
  }

  async function gotoResummarizeSessionPage(page) {
    if (page < 0) return
    await loadResummarizeSessions(resummarizeMatterDraft.value, page)
  }

  function prevResummarizeSessionPage() {
    if (resummarizeSessionPage.value <= 0 || resummarizeSessionsLoading.value) return
    gotoResummarizeSessionPage(resummarizeSessionPage.value - 1)
  }

  function nextResummarizeSessionPage() {
    if (!resummarizeSessionHasMore.value || resummarizeSessionsLoading.value) return
    gotoResummarizeSessionPage(resummarizeSessionPage.value + 1)
  }

  async function openResummarizeDialog(matter) {
    resummarizeMatterDraft.value = matter || null
    setSelectedSessionIds(matter?.relatedSessionIds || [])
    resummarizeSessionPage.value = 0
    resummarizeSessionHasMore.value = false
    resummarizeDialogOpen.value = true
    await loadResummarizeSessions(matter || null, 0)
  }

  async function pollMatterJob(jobId, sessionCount) {
    if (!jobId) return null
    for (let i = 0; i < 90; i++) {
      const run = await apiFetch('/v1/agent-runs/' + encodeURIComponent(jobId)).then((r) => r.json()).catch(() => null)
      if (run?.status === 'success') {
        const tokenText = run.total_tokens ? ' · Tokens ' + run.total_tokens : ''
        message.value = '重新归档完成：' + (run.summary || run.id || 'Agent run 已完成') + tokenText
        await refreshAiResults()
        return run
      }
      if (run?.status === 'failed') {
        message.value = run.error || '重新归档失败'
        return run
      }
      message.value = '正在重新归档：已创建任务 ' + jobId + '，Matter Archive Agent 正在处理 ' + sessionCount + ' 个 Session。'
      await sleep(2000)
    }
    message.value = '重新归档仍在运行：' + jobId + '。可在调用记录继续查看进度。'
    return null
  }

  async function resummarizeMatter() {
    const matter = resummarizeMatterDraft.value
    const sessionIds = selectedResummarizeSessionIds.value
    if (!sessionIds.length) {
      message.value = '请至少选择 1 个 Session 再重新归档'
      return
    }
    busy.value = true
    runningMatterId.value = matter?.id || '__standalone__'
    resummarizeDialogOpen.value = false
    message.value = '正在重新归档：Matter Archive Agent 将只关注已选择的 ' + sessionIds.length + ' 个 Session，并把新事项追加进事项管理。'
    try {
      const endpoint = matter?.id
        ? '/v1/matters/' + encodeURIComponent(matter.id) + '/resummarize'
        : '/v1/matters/resummarize'
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: sessionIds, append_matters: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        message.value = data.error || data.summary || '重新归档失败'
        return
      }
      if (res.status === 202) {
        message.value = '已创建重新归档任务：' + (data.id || 'Agent run') + '。正在等待处理结果。'
        await pollMatterJob(data.id, sessionIds.length)
        return
      }
      const tokenText = data.total_tokens ? ' · Tokens ' + data.total_tokens : ''
      message.value = '重新归档完成：' + (data.summary || data.id || 'Agent run 已完成') + tokenText
      await refreshAiResults()
    } finally {
      busy.value = false
      runningMatterId.value = null
    }
  }

  async function archiveMatter(matter) {
    if (!matter || busy.value) return
    busy.value = true
    try {
      const res = await apiFetch('/v1/matters/' + encodeURIComponent(matter.id) + '/archive', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        message.value = data.error || '归档失败'
        return
      }
      message.value = '已归档'
      if (aiResultsMode.value) {
        await refreshAiResults()
      } else {
        await loadMatters(selectedMatterTab.value)
      }
    } finally {
      busy.value = false
    }
  }

  const MatterRow = component(({ item }) => {
    const selected = selectedMatterId.value === item.id
    const statusText = runningMatterId.value === item.id ? '重新归档中' : item.statusLabel
    const canArchive = item.status !== 'archived' && item.status !== 'summarizing' && runningMatterId.value !== item.id
    const focusMatter = () => {
      selectedMatterId.value = item.id
      focusMatterRoute?.(item.id, { tab: selectedMatterTab.value })
    }
    const onArchive = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!canArchive || busy.value) return
      archiveMatter(item)
    }
    return (
      <div tabIndex="0" role="button" className={'matter-row' + (selected ? ' matter-row--active' : '')} onFocus={focusMatter} onClick={focusMatter}>
        <div className="matter-col matter-col--type"><span className={badgeClass(item.type)}>{item.type}</span></div>
        <div className="matter-col matter-col--main">
          <div className="matter-title-line">{item.title}</div>
          <div className="matter-summary-line">{item.summary}</div>
        </div>
        <div className="matter-col matter-col--status"><span className="matter-status">{statusText}</span></div>
        <div className="matter-col matter-col--time" title={item.updatedTitle || undefined}>{item.updated}</div>
        <div className="matter-col matter-col--actions">
          {canArchive ? (
            <span
              className={'matter-row-action' + (busy.value ? ' matter-row-action--disabled' : '')}
              role="button"
              tabIndex="0"
              title="归档"
              aria-label="归档"
              onClick={onArchive}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                onArchive(event)
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="4" x="3" y="4" rx="1" />
                <path d="M5 8v11h14V8" />
                <path d="M10 12h4" />
              </svg>
            </span>
          ) : null}
        </div>
      </div>
    )
  })

  const ResummarizeDialog = component(() => {
    const draft = resummarizeMatterDraft.value
    const linked = draft?.relatedSessionIds || []
    return (
      <Dialog open={resummarizeDialogOpen.value} onOpenChange={(v) => { resummarizeDialogOpen.value = v }}>
        <DialogContent style={{ maxWidth: '860px' }}>
          <DialogHeader>
            <DialogTitle>重新归档</DialogTitle>
            <DialogDescription>
              选择本次 Matter Archive Agent 只允许关注的 Session 范围；结果会追加为新的事项，允许合理冗余。
            </DialogDescription>
          </DialogHeader>

          <div className="matter-resummarize-dialog">
            <div className="matter-range-actions">
              <button className="matter-range-btn" disabled={!draft} onClick={() => selectSessionRange('linked')}>当前关联</button>
              <button className="matter-range-btn" onClick={() => selectSessionRange('today')}>今天</button>
              <button className="matter-range-btn" onClick={() => selectSessionRange('24h')}>过去 24 小时</button>
              <button className="matter-range-btn" onClick={() => selectSessionRange('7d')}>过去一周</button>
              <button className="matter-range-btn" onClick={() => selectSessionRange('all')}>本页全选</button>
              <button className="matter-range-btn matter-range-btn--ghost" onClick={() => setSelectedSessionIds([])}>清空</button>
            </div>

            <div className="matter-resummarize-summary">
              <span>已选择 <b className="digits">{selectedResummarizeCount.value}</b> 个 Session</span>
              <small>{draft ? <>默认选中当前事项关联的 <b className="digits">{linked.length}</b> 个 Session</> : '当前未传入事项，可直接选择 Session 范围进行归档'}</small>
            </div>

            <div className="matter-session-picker">
              <div className="matter-session-picker-head">
                <span></span>
                <span>Session</span>
                <span>最近活动</span>
                <span>Cost</span>
              </div>
              <div className="matter-session-picker-list">
                {resummarizeSessionsLoading.value ? <div className="empty-state">Loading sessions…</div> : resummarizeSessions.value.length ? resummarizeSessions.value.map((session) => {
                  const checked = selectedResummarizeSessionIds.value.includes(session.id)
                  const isLinked = linked.includes(session.id)
                  return (
                    <label className={'matter-session-row' + (checked ? ' matter-session-row--selected' : '')} key={session.id}>
                      <span className="matter-session-check">
                        <input type="checkbox" checked={checked} onChange={() => toggleSession(session.id)} />
                      </span>
                      <span className="matter-session-main">
                        <b>{sessionTitle(session)}</b>
                        <small className="digits">{session.id}</small>
                        {isLinked ? <em>当前关联</em> : null}
                      </span>
                      <span className="matter-session-time digits">{formatSessionDate(sessionTime(session))}</span>
                      <span className="matter-session-cost digits">${Number(session.total_cost_usd || 0).toFixed(4)}</span>
                    </label>
                  )
                }) : <div className="empty-state">当前页暂无 Session</div>}
              </div>
              <div className="matter-session-picker-pager">
                <span>第 <b className="digits">{resummarizeSessionPage.value + 1}</b> 页 · 每页 {RESUMMARIZE_SESSION_PAGE_SIZE} 条</span>
                <div className="matter-session-picker-pager-actions">
                  <button className="matter-range-btn matter-range-btn--ghost" disabled={resummarizeSessionPage.value <= 0 || resummarizeSessionsLoading.value} onClick={() => prevResummarizeSessionPage()}>上一页</button>
                  <button className="matter-range-btn matter-range-btn--ghost" disabled={!resummarizeSessionHasMore.value || resummarizeSessionsLoading.value} onClick={() => nextResummarizeSessionPage()}>下一页</button>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter style={{ gap: '8px', flexWrap: 'wrap' }}>
            <Button onClick={() => resummarizeMatter()} disabled={busy.value || !selectedResummarizeCount.value}>
              {busy.value ? '归档中…' : '运行重新归档'}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost">关闭</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  })

  const MattersPage = component(() => {
    const m = selectedMatter.value
    const activeMatterTab = selectedMatterTab.value
    return (
      <div className="mock-page fade-up">
        <ResummarizeDialog />
        <div className="mock-page-head">
          <h2 className="mock-title">事项归档</h2>
          <div className="mock-head-actions">
            <button className="mock-action-btn" disabled={busy.value} onClick={() => openResummarizeDialog(m)} title={'选择 Session 范围后触发 Matter Archive Agent 重新归档，结果会追加或整合为事项'}>
              <MatterIcon variant="spark" />
              {runningMatterId.value === (m?.id || '__standalone__') ? '重新归档中' : '重新归档'}
            </button>
            <button className="mock-action-btn" disabled={loading.value || aiSearchLoading.value} onClick={() => refreshAiResults()}>刷新</button>
          </div>
        </div>

        <div className="matter-tabs">
          <button className={activeMatterTab === 'summary' ? 'matter-tab matter-tab--active' : 'matter-tab'} onClick={() => openMatterTab('summary')}>
            <MatterIcon variant="spark" />
            事项总结
          </button>
          <button className={activeMatterTab === 'archive' ? 'matter-tab matter-tab--active' : 'matter-tab'} onClick={() => openMatterTab('archive')}>
            <MatterIcon variant="archive" />
            已归档
            <span className="matter-tab-count digits">{archivedCount.value}</span>
          </button>
        </div>

        <div className="matter-layout">
          <section className="matter-table-panel panel-card">
            <div className="matter-table-head">
              <SectionTitle title={activeMatterTab === 'archive' ? '已归档事项' : '独立事项'} subtitle={message.value || ''} />
              <span className="count-chip">{matterPageLabel()}</span>
            </div>
            <div className="session-list-toolbar">
              <input
                className="session-search-input"
                type="search"
                placeholder="搜索事项标题、摘要、结果或归档正文…"
                value={matterSearchInput.value}
                disabled={aiSearchLoading.value}
                onInput={(e) => { matterSearchInput.value = e.target.value }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runMatterSearch()
                }}
              />
              <div className="session-list-toolbar-actions">
                <button className="mock-action-btn mock-action-btn--primary" disabled={loading.value || aiSearchLoading.value} onClick={runMatterSearch}>搜索</button>
                <button className="mock-action-btn" disabled={loading.value || aiSearchLoading.value} onClick={runAiMatterSearch}>
                  <MatterIcon variant="spark" />
                  AI 搜索
                </button>
                {matterQuery.value || aiResultsMode.value || matterSearchInput.value
                  ? <button className="mock-action-btn" disabled={loading.value || aiSearchLoading.value} onClick={clearMatterSearch}>清除</button>
                  : null}
              </div>
            </div>
            {aiSearchLoading.value ? (
              <div className="matter-ai-thinking" role="status" aria-live="polite">
                <MatterIcon variant="spark" />
                <span className="matter-ai-thinking-text">思考中</span>
              </div>
            ) : null}
            <div className="matter-header">
              <div className="matter-col matter-col--type">类型</div>
              <div className="matter-col matter-col--main">事项</div>
              <div className="matter-col matter-col--status">状态</div>
              <div className="matter-col matter-col--time">更新</div>
              <div className="matter-col matter-col--actions">操作</div>
            </div>
            <div className="matter-list">
              {loading.value && matters.value.length === 0
                ? <div className="empty-state">Loading matters…</div>
                : matters.value.length
                  ? matters.value.map((item) => <MatterRow key={item.id} item={item} />)
                  : <div className="empty-state">{aiResultsMode.value ? 'AI 未找到匹配事项' : matterQuery.value ? '没有匹配的事项' : '暂无事项归档'}</div>}
            </div>
            <div className="session-list-footer">
              <span className="count-chip">{matterPageLabel()}</span>
              {aiResultsMode.value ? null : (
                <div className="session-list-pagination">
                  <button className="mock-action-btn" disabled={matterOffset.value <= 0 || loading.value} onClick={prevMatterPage}>上一页</button>
                  <button className="mock-action-btn" disabled={!matterHasMore.value || loading.value} onClick={nextMatterPage}>下一页</button>
                </div>
              )}
            </div>
          </section>

          <aside className="matter-dossier panel-card">
            {m ? (
              <>
                <div className="matter-doc-head">
                  <div className="matter-dossier-kicker">Markdown</div>
                  <button className="btn-ghost-sm" onClick={async () => {
                    try {
                      await copyText(m.markdown)
                      copiedMatterId.value = m.id
                      setTimeout(() => {
                        if (copiedMatterId.value === m.id) copiedMatterId.value = null
                      }, 1200)
                    } catch (err) {
                      console.error(err)
                    }
                  }}>{copiedMatterId.value === m.id ? '已复制' : '复制'}</button>
                </div>
                <h3>{m.title}</h3>
                <div className="matter-dossier-meta">
                  <span className={badgeClass(m.type)}>{m.type}</span>
                  <span>{m.statusLabel}</span>
                </div>
                {Array.isArray(m.relatedSessions) && m.relatedSessions.length ? (
                  <div className="matter-linked-sessions">
                    <div className="matter-linked-sessions-label">Sessions</div>
                    <div className="matter-linked-sessions-grid">
                      {m.relatedSessions.map((session) => (
                        <button className="matter-linked-session-chip" key={session.id} onClick={() => navigateToSession(session.id)} title={session.id}>
                          {session.title || session.id}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <MarkdownView markdown={m.markdown} />
              </>
            ) : <div className="empty-state">暂无事项归档。可通过调用 Matter Archive Agent 生成。</div>}
          </aside>
        </div>
      </div>
    )
  })

  return MattersPage
}
