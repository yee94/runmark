import { component, computed, effect, signal } from 'eficy'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

const SESSION_SUMMARY_STATUS = Object.freeze({
  Idle: 'Idle',
  Thinking: 'Thinking',
  Success: 'Success',
  Error: 'Error',
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function copyText(text, host) {
  const value = String(text || '')
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch (err) {
      // Fall through to the textarea fallback for permission or protocol issues.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  const container = host || document.body
  container.appendChild(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('copy failed')
  } finally {
    textarea.remove()
  }
}

/** 从可能截断的 JSON 文本中提取某个 string 字段（支持常见转义） */
function extractJsonStringField(content, field) {
  const key = `"${field}":"`
  const start = String(content || '').indexOf(key)
  if (start < 0) return null
  let i = start + key.length
  let out = ''
  while (i < content.length) {
    const ch = content[i]
    if (ch === '\\') {
      const next = content[i + 1]
      if (next == null) break
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === '"' || next === '\\' || next === '/') out += next
      else if (next === 'u' && /^[0-9a-fA-F]{4}/.test(content.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(content.slice(i + 2, i + 6), 16))
        i += 6
        continue
      } else out += next
      i += 2
      continue
    }
    if (ch === '"') break
    out += ch
    i += 1
  }
  return out || null
}

/** 历史脏数据：AISummary 误存了 ReAct tool_calls JSON 时，尽量还原真正的 Markdown */
function coerceSessionSummaryMarkdown(raw) {
  const text = String(raw || '')
  if (!text) return ''
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') && (/"tool_calls"\s*:/.test(trimmed) || /"thought"\s*:/.test(trimmed)))) {
    return text
  }
  try {
    const parsed = JSON.parse(trimmed)
    const calls = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : []
    const writeCall = calls.find((call) => (call?.name || call?.tool) === 'session.summary.write')
    const args = writeCall?.arguments || writeCall?.args || parsed
    if (typeof args?.markdown === 'string' && args.markdown.trim()) return args.markdown
    if (typeof args?.summary === 'string' && args.summary.trim() && !String(args.summary).trim().startsWith('{')) {
      return args.summary
    }
  } catch (err) {
    // 截断 JSON：尽量捞出 markdown 字段
  }
  return extractJsonStringField(trimmed, 'markdown')
    || extractJsonStringField(trimmed, 'summary')
    || ''
}

/**
 * SessionDetailView 模块 — 会话详情与密集 trace 视图
 * 时间线合并逻辑见 modules/trace.eficy.js（经 index 注入 mergeForkTraceItems）
 */
export function createSessionDetailView(ctx) {
  const {
    apiFetch,
    sessions, sessionDetails, routeSessionId, routeTraceChild, selectedTraceKey, traceAutoFocusKey, expandedSubagents,
    traceTypes, traceDeepLinkFocus,
    publicShareTraceItems, publicShareTraceLoading, publicShareTraceLoadingMore,
    publicShareTraceError, publicShareTraceNextOffset, routeShareToken, fetchPublicShareTrace,
    sanitizeHtml,
    navigate, openSession, toggleSubagent,
    selectTraceItem, toggleTraceCategory,
    formatDateTime, formatSessionDuration, formatDuration, formatTokens, formatCost,
    forkParentSessionId, mergeForkTraceItems,
    TRACE_CATEGORIES, TRACE_FILTER_LABELS, TRACE_FILTER_DOTS,
    filterTraceItems, ChevronIcon,
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button,
  } = ctx

  const shareDialogOpen = signal(false)
  const shareDuration = signal('6h')
  const shareCreating = signal(false)
  const shareError = signal('')
  const shareCopyError = signal('')
  const shareResult = signal(null)
  const shareLinkCopied = signal(false)
  const sharePromptCopied = signal(false)
  const copiedActiveShareId = signal(null)
  const expandedActiveShareId = signal(null)
  const agentPromptCopied = signal(false)
  let copiedAgentPromptValue = ''
  const activeShares = signal([])
  const activeSharesLoading = signal(false)
  const activeSharesError = signal('')
  const revokingShareId = signal(null)
  let activeSharesRequestVersion = 0

  const SHARE_DURATION_OPTIONS = [
    { value: '1h', label: '1 小时' },
    { value: '6h', label: '6 小时' },
    { value: '12h', label: '12 小时' },
    { value: '3d', label: '3 天' },
    { value: '7d', label: '7 天' },
  ]

  function sharedTraceItem(item, index) {
    const category = item.category || 'user'
    const role = item.kind === 'turn'
      ? (category === 'abort' ? 'turn-abort' : category === 'error' ? 'turn-fail' : 'turn')
      : item.kind === 'tool' || item.kind === 'subagent' ? item.kind : (item.role || category)
    let summary = item.key || ''
    let fullText = ''
    if (item.kind === 'message') {
      fullText = String(item.content || '')
      summary = fullText.length > 120 ? fullText.slice(0, 120) + '…' : (fullText || role)
    } else if (item.kind === 'turn') {
      const suffix = category === 'abort' ? ' · Abort' : category === 'error' ? ' · Error' : (item.finish_reason ? ' · ' + item.finish_reason : '')
      summary = (item.model || 'Turn') + suffix
      fullText = [
        'Model: ' + (item.model || '—') + ' (' + (item.provider || '—') + ')',
        'Tokens: in ' + formatTokens(item.input_tokens) + ' · out ' + formatTokens(item.output_tokens)
          + (item.cache_read_tokens ? ' · cache读 ' + formatTokens(item.cache_read_tokens) : '')
          + (item.reasoning_tokens ? ' · reason ' + formatTokens(item.reasoning_tokens) : ''),
        'Duration: ' + formatDuration(item.duration_ms),
        'Cost: ' + formatCost(item.cost_cny),
        item.finish_reason ? 'Finish: ' + item.finish_reason : '',
        item.error ? 'Error: ' + item.error : '',
      ].filter(Boolean).join('\n')
    } else if (item.kind === 'tool') {
      summary = (item.tool_name || 'tool') + (item.output_title ? ': ' + item.output_title : '')
      fullText = [
        item.file_path ? 'File: ' + item.file_path : '',
        item.args || '',
        item.output_text || item.output_title || '',
        item.error ? 'Error: ' + item.error : '',
      ].filter(Boolean).join('\n\n')
    } else if (item.kind === 'subagent') {
      summary = item.summary || item.title || item.id || 'Subagent'
      fullText = [
        item.agent ? 'Agent: ' + item.agent : '',
        item.model ? 'Model: ' + item.model + (item.provider ? ' (' + item.provider + ')' : '') : '',
        item.id ? 'Session: ' + item.id : '',
      ].filter(Boolean).join('\n')
    }
    return {
      ...item,
      role,
      summary,
      fullText,
      tokens: item.total_tokens,
      cost_cny: item.cost_cny,
      childSessionId: item.kind === 'subagent' ? item.id : null,
      childSession: item.kind === 'subagent' ? item : null,
      seq: index + 1,
      depth: 0,
    }
  }

  function escapeTraceKeySelector(key) {
    const text = String(key || '')
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text)
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function displayedShareUrl(share) {
    return share?.share_url || ''
  }

  const SessionDetailView = component(({ sessionId, readOnly = false, shareMode = false, shareCategories = [], shareRestricted = false, agentPrompt = '' }) => {
    let traceListEl = null
    let traceAreaEl = null
    let autoSummarySessionId = null
    const summaryStatus = signal(SESSION_SUMMARY_STATUS.Idle)
    const summaryCopied = signal(false)
    const summaryMessage = signal('')

    const detail = computed(() => sessionDetails.value[sessionId] || null)
    const session = computed(() => {
      if (shareMode) return detail.value?.session || null
      return sessions.value.find(s => s.id === sessionId) || detail.value?.session || null
    })
    const forkParentId = computed(() => forkParentSessionId(session.value))
    const forkParent = computed(() => {
      const id = forkParentId.value
      if (!id) return null
      return detail.value?.forkParent
        || sessions.value.find(s => s.id === id)
        || { id }
    })
    const forkParentLabel = computed(() => {
      const p = forkParent.value
      if (!p) return ''
      return (p.title && String(p.title).trim()) || p.summary || p.id?.slice(0, 12) || ''
    })
    const parentSession = computed(() => session.value?.parent_session_id
      ? (sessions.value.find(s => s.id === session.value.parent_session_id) || { id: session.value.parent_session_id })
      : null)
    const parentLabel = computed(() => {
      const p = parentSession.value
      if (!p) return ''
      return p.title || p.summary || p.id?.slice(0, 12) || ''
    })
    const traceItems = computed(() => shareMode
      ? (publicShareTraceItems?.value || []).map(sharedTraceItem)
      : mergeForkTraceItems(session.value, detail.value))
    const visibleTraceItems = computed(() => filterTraceItems(traceItems.value, traceTypes.value))
    const filterCategories = computed(() => {
      if (!shareMode) return TRACE_CATEGORIES
      if (shareCategories.length) return shareCategories
      if (shareRestricted) {
        return TRACE_CATEGORIES.filter((category) => traceItems.value.some((item) => item.category === category))
      }
      return TRACE_CATEGORIES
    })
    const activeTraceCategory = computed(() => traceTypes.value[0] || null)
    const actualSummaryMarkdown = computed(() => {
      const raw = session.value?.AISummary
        || session.value?.ai_summary
        || detail.value?.AISummary
        || detail.value?.ai_summary
        || detail.value?.session?.AISummary
        || detail.value?.session?.ai_summary
        || ''
      return coerceSessionSummaryMarkdown(raw)
    })
    const summaryMarkdown = computed(() => {
      return actualSummaryMarkdown.value || '暂无 AI 总结'
    })
    const summaryHtml = computed(() => sanitizeHtml(marked.parse(summaryMarkdown.value)))
    const summaryThinking = computed(() => summaryStatus.value === SESSION_SUMMARY_STATUS.Thinking)
    const duration = computed(() => formatSessionDuration(session.value?.duration_ms))
    const endedAt = computed(() => session.value?.ended_at || session.value?.last_activity_at || null)
    const endedAtLabel = computed(() => session.value?.ended_at ? 'Ended' : 'Last')
    const selected = computed(() => {
      const items = visibleTraceItems.value
      const key = selectedTraceKey.value
      if (!key) return null
      return items.find(it => it.key === key) || null
    })

    let traceFocusRafId = 0
    /** 焦点 rAF 最多重试帧数，等行或列表挂上 */
    const TRACE_FOCUS_RAF_RETRY = 8
    /** 进入调用链后滚动到底部并聚焦默认选中项 */
    effect(() => {
      const focusKey = traceAutoFocusKey.value
      const routeId = routeSessionId ? routeSessionId.value : null
      if (!focusKey || selectedTraceKey.value !== focusKey) {
        if (traceFocusRafId) {
          cancelAnimationFrame(traceFocusRafId)
          traceFocusRafId = 0
        }
        return
      }
      const items = visibleTraceItems.value
      if (!items.some((it) => it.key === focusKey)) {
        if (traceFocusRafId) {
          cancelAnimationFrame(traceFocusRafId)
          traceFocusRafId = 0
        }
        return
      }
      const deepLink = !!(traceDeepLinkFocus && traceDeepLinkFocus.value)
      if (traceFocusRafId) cancelAnimationFrame(traceFocusRafId)
      const expectedSessionId = sessionId
      const expectedRouteId = routeId
      const expectedFocusKey = focusKey
      let tries = 0
      /** 校验当前会话/焦点 key，行未挂载则有限重试 */
      const runTraceFocus = () => {
        traceFocusRafId = 0
        if (sessionId !== expectedSessionId) return
        const currentRouteId = routeSessionId ? routeSessionId.value : null
        if (currentRouteId !== expectedRouteId) return
        if (traceAutoFocusKey.value !== expectedFocusKey) return
        const row = traceListEl?.querySelector('[data-trace-key="' + escapeTraceKeySelector(expectedFocusKey) + '"]')
        const reduceMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        const behavior = reduceMotion ? 'auto' : (deepLink ? 'smooth' : 'auto')
        if (deepLink) {
          const area = traceAreaEl || traceListEl
          if (!row) {
            if (tries < TRACE_FOCUS_RAF_RETRY) {
              tries += 1
              traceFocusRafId = requestAnimationFrame(runTraceFocus)
            }
            return
          }
          if (area && area.scrollIntoView) area.scrollIntoView({ block: 'start', behavior })
          row.scrollIntoView({ block: 'center', behavior })
          traceAutoFocusKey.value = null
          if (traceDeepLinkFocus) traceDeepLinkFocus.value = false
          return
        }
        if (row) {
          row.scrollIntoView({ block: 'end' })
          traceAutoFocusKey.value = null
          if (traceDeepLinkFocus) traceDeepLinkFocus.value = false
          return
        }
        if (tries < TRACE_FOCUS_RAF_RETRY) {
          tries += 1
          traceFocusRafId = requestAnimationFrame(runTraceFocus)
          return
        }
        if (traceListEl) {
          traceListEl.scrollTop = traceListEl.scrollHeight
          traceAutoFocusKey.value = null
          if (traceDeepLinkFocus) traceDeepLinkFocus.value = false
        }
      }
      traceFocusRafId = requestAnimationFrame(runTraceFocus)
    })

    effect(() => {
      if (readOnly || shareMode) return
      const currentSession = session.value
      if (!currentSession?.id) return
      if (actualSummaryMarkdown.value) return
      if (summaryThinking.value) return
      if (autoSummarySessionId === currentSession.id) return
      autoSummarySessionId = currentSession.id
      resummarizeSession({ auto: true })
    })

    const detailLabel = computed(() => {
      const it = selected.value
      if (!it) return ''
      if (it.kind === 'turn') {
        if (it.abort || it.role === 'turn-abort') {
          return '用户 Abort' + (it.model ? ' · ' + it.model : '')
        }
        if (it.role === 'turn-fail') {
          return 'LLM Error' + (it.model ? ' · ' + it.model : '')
        }
        return 'LLM Turn' + (it.model ? ' · ' + it.model : '')
      }
      if (it.kind === 'tool') return 'Tool · ' + (it.summary || '')
      if (it.kind === 'subagent') {
        const model = it.model || it.childSession?.model
        const provider = it.provider || it.childSession?.provider
        return 'Subagent' + (model ? ' · ' + model : '') + (provider ? ' (' + provider + ')' : '')
      }
      if (it.kind === 'fork-from') return 'Fork 来源'
      if (it.role === 'reasoning') return '思考' + (it.model ? ' · ' + it.model : '')
      return (it.role || '') + (it.model ? ' · ' + it.model : '')
    })
    const detailHtml = computed(() => sanitizeHtml(marked.parse(String(selected.value?.fullText || ''))))

    function updateSessionSummary(nextSession) {
      const markdown = nextSession?.AISummary || nextSession?.ai_summary || ''
      sessions.value = sessions.value.map((row) => row.id === sessionId ? { ...row, ...nextSession, AISummary: markdown } : row)
      const prev = sessionDetails.value[sessionId] || {}
      const prevSession = prev.session || {}
      sessionDetails.value = {
        ...sessionDetails.value,
        [sessionId]: {
          ...prev,
          session: { ...prevSession, ...nextSession, AISummary: markdown },
          AISummary: markdown,
          ai_summary: markdown,
        },
      }
    }

    async function pollSummaryJob(jobId, options = {}) {
      if (!jobId) return null
      for (let i = 0; i < 90; i++) {
        const run = await apiFetch('/v1/agent-runs/' + encodeURIComponent(jobId)).then((r) => r.json()).catch(() => null)
        if (run?.status === 'success') {
          const nextSession = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId)).then(r => r.json()).catch(() => null)
          if (nextSession) updateSessionSummary(nextSession)
          summaryMessage.value = options.auto ? '' : (run.summary ? '重新总结完成：' + run.summary : '重新总结完成')
          summaryStatus.value = SESSION_SUMMARY_STATUS.Success
          return run
        }
        if (run?.status === 'failed') {
          summaryMessage.value = run.error || '重新总结失败'
          summaryStatus.value = SESSION_SUMMARY_STATUS.Error
          return run
        }
        summaryMessage.value = options.auto ? '' : ('正在重新总结：已创建任务 ' + jobId + '，Session Summary Agent 正在处理。')
        await sleep(2000)
      }
      summaryMessage.value = options.auto ? '' : ('重新总结仍在运行：' + jobId + '。可在调用记录继续查看进度。')
      summaryStatus.value = SESSION_SUMMARY_STATUS.Idle
      return null
    }

    async function resummarizeSession(options = {}) {
      if (summaryStatus.value === SESSION_SUMMARY_STATUS.Thinking) return
      summaryMessage.value = ''
      summaryStatus.value = SESSION_SUMMARY_STATUS.Thinking
      updateSessionSummary({ id: sessionId, AISummary: '' })
      try {
        const res = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/resummarize', { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          summaryMessage.value = data.error || data.summary || '重新总结失败'
          summaryStatus.value = SESSION_SUMMARY_STATUS.Error
          return
        }
        if (res.status === 202) {
          summaryMessage.value = options.auto ? '' : ('已创建重新总结任务：' + (data.id || 'Agent run') + '。正在等待处理结果。')
          await pollSummaryJob(data.id, options)
          return
        }
        const nextSession = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId)).then(r => r.json()).catch(() => null)
        if (nextSession) updateSessionSummary(nextSession)
        summaryMessage.value = options.auto ? '' : (data.summary ? '重新总结完成：' + data.summary : '重新总结完成')
        summaryStatus.value = SESSION_SUMMARY_STATUS.Success
      } catch (err) {
        console.error(err)
        summaryMessage.value = '重新总结失败'
        summaryStatus.value = SESSION_SUMMARY_STATUS.Error
      } finally {
        if (summaryStatus.value === SESSION_SUMMARY_STATUS.Thinking) {
          summaryStatus.value = SESSION_SUMMARY_STATUS.Idle
        }
      }
    }

    function formatShareRemaining(expiresAt) {
      const remainingMs = new Date(expiresAt).getTime() - Date.now()
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '即将到期'
      const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000))
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days) return '剩余 ' + days + ' 天' + (hours ? ' ' + hours + ' 小时' : '')
      if (hours) return '剩余 ' + hours + ' 小时' + (minutes ? ' ' + minutes + ' 分钟' : '')
      return '剩余 ' + minutes + ' 分钟'
    }

    async function fetchActiveShares() {
      const requestVersion = ++activeSharesRequestVersion
      activeSharesLoading.value = true
      activeSharesError.value = ''
      try {
        const res = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/shares')
        const data = await res.json().catch(() => ({}))
        if (requestVersion !== activeSharesRequestVersion) return
        if (!res.ok) {
          activeSharesError.value = data.error || '有效分享加载失败'
          return
        }
        activeShares.value = Array.isArray(data.shares) ? data.shares : []
      } catch (err) {
        console.error(err)
        if (requestVersion === activeSharesRequestVersion) activeSharesError.value = '有效分享加载失败'
      } finally {
        if (requestVersion === activeSharesRequestVersion) activeSharesLoading.value = false
      }
    }

    function openShareDialog() {
      shareDuration.value = '6h'
      shareCreating.value = false
      shareError.value = ''
      shareCopyError.value = ''
      shareResult.value = null
      shareLinkCopied.value = false
      sharePromptCopied.value = false
      copiedActiveShareId.value = null
      expandedActiveShareId.value = null
      activeShares.value = []
      activeSharesError.value = ''
      revokingShareId.value = null
      shareDialogOpen.value = true
      fetchActiveShares()
    }

    async function createShare() {
      if (shareCreating.value) return
      shareCreating.value = true
      shareError.value = ''
      shareCopyError.value = ''
      copiedActiveShareId.value = null
      expandedActiveShareId.value = null
      try {
        const res = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/shares', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            duration: shareDuration.value,
            types: traceTypes.value,
            node: selectedTraceKey.value,
            child: routeTraceChild?.value || null,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          shareError.value = data.error || '创建分享链接失败'
          return
        }
        shareResult.value = data
        await fetchActiveShares()
      } catch (err) {
        console.error(err)
        shareError.value = '创建分享链接失败'
      } finally {
        shareCreating.value = false
      }
    }

    async function revokeShare(shareId) {
      if (!shareId || revokingShareId.value) return
      revokingShareId.value = shareId
      activeSharesError.value = ''
      shareCopyError.value = ''
      copiedActiveShareId.value = null
      expandedActiveShareId.value = null
      try {
        const res = await apiFetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/shares/' + encodeURIComponent(shareId), { method: 'DELETE' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.revoked) {
          activeSharesError.value = data.error || '撤回分享失败'
          return
        }
        activeShares.value = activeShares.value.filter((share) => share.id !== shareId)
        if (shareResult.value?.id === shareId) {
          shareResult.value = null
          shareLinkCopied.value = false
          sharePromptCopied.value = false
        }
      } catch (err) {
        console.error(err)
        activeSharesError.value = '撤回分享失败'
      } finally {
        revokingShareId.value = null
      }
    }

    async function copyShareValue(value, copiedSignal, host, copiedValue = true, resetValue = false, errorMessage = '复制失败，请手动选择上方内容复制') {
      copiedSignal.value = resetValue
      shareCopyError.value = ''
      try {
        await copyText(value, host)
        copiedSignal.value = copiedValue
        setTimeout(() => {
          if (copiedSignal.value === copiedValue) copiedSignal.value = resetValue
        }, 1200)
        return true
      } catch (err) {
        console.error(err)
        copiedSignal.value = resetValue
        shareCopyError.value = errorMessage
        return false
      }
    }

    async function copyActiveShare(share, host) {
      expandedActiveShareId.value = null
      const copied = await copyShareValue(displayedShareUrl(share), copiedActiveShareId, host, share.id, null, '')
      if (copied) return
      expandedActiveShareId.value = share.id
      requestAnimationFrame(() => {
        const input = host?.querySelector('[data-active-share-link]')
        if (!input) return
        input.focus({ preventScroll: true })
        input.select()
        input.setSelectionRange(0, input.value.length)
      })
    }

    function selectShareLinkInput(event) {
      const input = event.currentTarget
      input.select()
      input.setSelectionRange(0, input.value.length)
    }

    function closeShareDialog() {
      shareCopyError.value = ''
      copiedActiveShareId.value = null
      expandedActiveShareId.value = null
      shareDialogOpen.value = false
    }

    async function copyAgentPrompt() {
      copiedAgentPromptValue = agentPrompt
      agentPromptCopied.value = true
      try {
        await copyText(agentPrompt)
        setTimeout(() => { agentPromptCopied.value = false }, 1200)
      } catch (err) {
        console.error(err)
        agentPromptCopied.value = false
      }
    }

    function handleSelectTraceItem(it) {
      if (!shareMode && it.kind === 'fork-from' && it.parentSessionId) {
        openSession(it.parentSessionId)
        return
      }
      selectTraceItem(it, sessionId)
    }

    function handleTraceRowKeyDown(event, it) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        handleSelectTraceItem(it)
      }
    }

    return (
      <div className="fade-up">
        {!shareMode ? (
          <button className="trace-back" onClick={() => navigate('sessions')}>
            ← 返回会话列表
          </button>
        ) : null}
        <section className="session-summary-card panel-card">
          <div className="session-summary-head">
            <div>
              <div className="session-summary-kicker">Summary</div>
              <h3>会话总结</h3>
            </div>
            <div className="session-summary-actions">
              {!readOnly && !shareMode ? (
                <button
                  className="btn-ghost-sm session-summary-ai-action"
                  disabled={summaryThinking.value}
                  onClick={() => resummarizeSession()}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m15 4 5 5" />
                    <path d="M13 6 4 15l5 5 9-9" />
                    <path d="m6 13 5 5" />
                    <path d="M19 2v4" />
                    <path d="M21 4h-4" />
                    <path d="M3 4h2" />
                    <path d="M4 3v2" />
                  </svg>
                  {summaryThinking.value ? SESSION_SUMMARY_STATUS.Thinking : '重新总结'}
                </button>
              ) : null}
              <button
                className="btn-ghost-sm"
                onClick={async () => {
                  try {
                    await copyText(actualSummaryMarkdown.value)
                    summaryCopied.value = true
                    setTimeout(() => { summaryCopied.value = false }, 1200)
                  } catch (err) {
                    console.error(err)
                  }
                }}
                disabled={!actualSummaryMarkdown.value || summaryThinking.value}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="18" x="5" y="3" rx="2" />
                  <path d="M9 3h6v4H9z" />
                </svg>
                {summaryCopied.value ? '已复制' : '复制 Markdown'}
              </button>
              {!readOnly && !shareMode ? (
                <button className="btn-ghost-sm" onClick={() => openShareDialog()}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <path d="m8.6 13.5 6.8 4" />
                    <path d="m15.4 6.5-6.8 4" />
                  </svg>
                  分享
                </button>
              ) : null}
            </div>
          </div>
          {summaryMessage.value ? <div className="session-summary-status">{summaryMessage.value}</div> : null}
          {summaryThinking.value ? (
            <div className="session-summary-thinking" role="status" aria-live="polite">
              <span className="session-summary-spinner" />
              <span>{SESSION_SUMMARY_STATUS.Thinking}</span>
            </div>
          ) : (
            <div className="markdown-body session-summary-markdown" dangerouslySetInnerHTML={{ __html: summaryHtml.value }} />
          )}
        </section>
        <div className="panel-card" style={{ padding: 0, overflow: 'hidden' }} ref={(el) => { traceAreaEl = el }}>
          <div className="trace-meta-bar">
            {session.value?.model ? (
              <span className="trace-meta-item">
                <span className="trace-meta-label">Model</span>
                <span className="trace-meta-val">{session.value.model}</span>
              </span>
            ) : null}
            {session.value?.agent ? (
              <span className="trace-meta-item">
                <span className="trace-meta-label">Agent</span>
                <span className="trace-meta-val">{session.value.agent}</span>
              </span>
            ) : null}
            <span className="trace-meta-item">
              <span className="trace-meta-label">Started</span>
              <span className="trace-meta-val">{formatDateTime(session.value?.started_at)}</span>
            </span>
            <span className="trace-meta-item">
              <span className="trace-meta-label">{endedAtLabel}</span>
              <span className="trace-meta-val">{formatDateTime(endedAt.value)}</span>
            </span>
            <span className="trace-meta-item">
              <span className="trace-meta-label">Duration</span>
              <span className="trace-meta-val">{duration}</span>
            </span>
            <span className="trace-meta-item">
              <span className="trace-meta-label">Tokens</span>
              <span className="trace-meta-val">{formatTokens(session.value?.total_tokens)}</span>
            </span>
            <span className="trace-meta-item">
              <span className="trace-meta-label">Cost</span>
              <span className="trace-meta-val">{formatCost(session.value?.total_cost_cny)}</span>
            </span>
            {!shareMode && forkParentId.value
              ? <span className="trace-meta-item">
                  <span className="trace-meta-label">Fork from</span>
                  <span
                    className="trace-meta-val"
                    style={{ color: 'var(--brand-blue)', cursor: 'pointer' }}
                    onClick={() => openSession(forkParentId.value)}
                    title={forkParentId.value}
                  >{forkParentLabel}</span>
                </span>
              : null}
            {!shareMode && session.value?.parent_session_id
              ? <span className="trace-meta-item">
                  <span className="trace-meta-label">Subagent of</span>
                  <span
                    className="trace-meta-val"
                    style={{ color: 'var(--brand-blue)', cursor: 'pointer' }}
                    onClick={() => openSession(session.value.parent_session_id)}
                    title={session.value.parent_session_id}
                  >{parentLabel}</span>
                </span>
              : null}
          </div>
          {shareMode && publicShareTraceLoading?.value && traceItems.value.length === 0
            ? <div className="empty-state" style={{ padding: '32px 20px' }}><p>正在加载共享调用链…</p></div>
            : shareMode && publicShareTraceError?.value && traceItems.value.length === 0
              ? <div className="empty-state" style={{ padding: '32px 20px' }}>
                  <p>{publicShareTraceError.value}</p>
                  <button type="button" className="btn-ghost-sm" onClick={() => fetchPublicShareTrace(routeShareToken.value)}>重试</button>
                </div>
              : traceItems.value.length === 0
                ? <div className="empty-state" style={{ padding: '32px 20px' }}><p>暂无调用记录</p></div>
            : <div className="trace-shell">
                <div className="trace-panel">
                  <div className="trace-panel-head">
                    <span className="trace-panel-head-title">调用链</span>
                    <div
                      className="trace-filter-group"
                      role="group"
                      aria-label={activeTraceCategory.value
                        ? '调用链筛选，当前分类：' + (TRACE_FILTER_LABELS[activeTraceCategory.value] || activeTraceCategory.value)
                        : '调用链筛选，当前显示全部分类'}
                    >
                      {filterCategories.value.map((cat) => {
                        const pressed = activeTraceCategory.value === cat
                        return (
                          <button
                            key={cat}
                            type="button"
                            className={'trace-filter-chip trace-filter-chip--' + cat}
                            aria-pressed={pressed}
                            aria-label={'按' + (TRACE_FILTER_LABELS[cat] || cat) + '筛选调用链'}
                            onClick={() => toggleTraceCategory(cat, traceItems.value, sessionId)}
                          >
                            <span className={'trace-role-dot trace-role-dot--' + (TRACE_FILTER_DOTS[cat] || cat)} aria-hidden="true" />
                            {TRACE_FILTER_LABELS[cat] || cat}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {visibleTraceItems.value.length === 0 ? (
                    <div className="empty-state" style={{ padding: '32px 20px' }}>
                      <p>当前分类没有可见记录，可切换分类或再次点击取消筛选</p>
                    </div>
                  ) : (
                  <div className="trace-list" role="listbox" aria-label="调用链" ref={(el) => { traceListEl = el }}>
                    {visibleTraceItems.value.map((it, index) => (
                      <div
                        key={it.key + (it.nested ? '-n' : '')}
                        role="option"
                        tabIndex={selected.value ? (selected.value.key === it.key ? 0 : -1) : (index === 0 ? 0 : -1)}
                        aria-selected={selected.value?.key === it.key}
                        aria-label={(selected.value?.key === it.key ? '取消选择：' : '选择：') + it.summary}
                        title={selected.value?.key === it.key ? '再次点击取消选择' : it.summary}
                        data-trace-key={it.key}
                        className={'trace-row' +
                          (selected.value?.key === it.key ? ' trace-row--sel' : '') +
                          (it.nested ? ' trace-row--nested' : '') +
                          (it.kind === 'subagent' ? ' trace-row--subagent' : '') +
                          (it.kind === 'fork-from' ? ' trace-row--fork-from' : '')}
                        style={{ paddingLeft: (8 + (it.depth || 0) * 14) + 'px' }}
                        onClick={() => handleSelectTraceItem(it)}
                        onKeyDown={(event) => handleTraceRowKeyDown(event, it)}
                      >
                        <span className="trace-seq">{it.seq || ''}</span>
                        {it.kind === 'subagent' && !shareMode ? (
                          <button
                            className="trace-expand-btn"
                            aria-label={expandedSubagents.value[it.childSessionId] ? '收起子代理' : '展开子代理'}
                            aria-expanded={!!expandedSubagents.value[it.childSessionId]}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSubagent(sessionId, it.childSessionId)
                            }}
                          >
                            <ChevronIcon direction={expandedSubagents.value[it.childSessionId] ? 'down' : 'right'} />
                          </button>
                        ) : (
                          <span className={'trace-role-dot trace-role-dot--' + it.role} aria-hidden="true" />
                        )}
                        <span className="trace-summary" title={it.summary}>{it.summary}</span>
                        <span className="trace-meta trace-time" title={formatDateTime(it.created_at)}>{formatDateTime(it.created_at)}</span>
                        <span className="trace-meta">{it.tokens != null ? formatTokens(it.tokens) : ''}</span>
                        <span className="trace-meta">{it.cost_cny != null ? formatCost(it.cost_cny) : ''}</span>
                      </div>
                    ))}
                    {shareMode && publicShareTraceNextOffset?.value != null ? (
                      <button
                        type="button"
                        className="trace-load-more"
                        disabled={publicShareTraceLoadingMore?.value}
                        onClick={() => fetchPublicShareTrace(routeShareToken.value, true)}
                      >
                        {publicShareTraceLoadingMore?.value ? '正在加载…' : '加载更多'}
                      </button>
                    ) : null}
                  </div>
                  )}
                </div>
                <div className="trace-panel">
                  <div className="trace-panel-head">详情</div>
                  {selected.value ? (
                    <div className="trace-detail">
                      <div className="trace-detail-label">
                        <span>{detailLabel.value}</span>
                        <span className="trace-detail-label-time">{formatDateTime(selected.value.created_at)}</span>
                      </div>
                      {selected.value.kind === 'turn' ? (
                        <div className="trace-turn-grid">
                          <div className="trace-turn-stat">Tokens<b>{formatTokens(selected.value.tokens)}</b></div>
                          <div className="trace-turn-stat">Cost<b>{formatCost(selected.value.cost_cny)}</b></div>
                          <div className="trace-turn-stat">Model<b>{selected.value.model || '—'}</b></div>
                        </div>
                      ) : null}
                      {selected.value.kind === 'subagent' ? (
                        <div className="trace-turn-grid">
                          <div className="trace-turn-stat">Model<b>{selected.value.model || selected.value.childSession?.model || '—'}</b></div>
                          <div className="trace-turn-stat">Tokens<b>{formatTokens(selected.value.tokens)}</b></div>
                          <div className="trace-turn-stat">Cost<b>{formatCost(selected.value.cost_cny)}</b></div>
                        </div>
                      ) : null}
                      <div
                        className="markdown-body trace-detail-markdown"
                        dangerouslySetInnerHTML={{ __html: detailHtml.value }}
                      />
                    </div>
                  ) : (
                    <div className="trace-detail" style={{ color: 'var(--text-muted)' }}>选择左侧条目查看详情</div>
                  )}
                </div>
              </div>
          }
        </div>
        {shareMode ? (
          <section className="panel-card share-agent-prompt-card">
            <div>
              <div className="session-summary-kicker">Agent prompt</div>
              <h3>需要更深上下文时再检索</h3>
              <p>{shareRestricted
                ? 'Agent 可按页读取当前分享范围内经过过滤和脱敏的调用链。'
                : 'Agent 可使用搜索与分页资源读取经过过滤和脱敏的分享内容。'}</p>
            </div>
            <textarea readOnly defaultValue={agentPrompt} rows={5} />
            <button className="btn-ghost-sm" disabled={!agentPrompt} onClick={() => copyAgentPrompt()}>
              {agentPromptCopied.value && copiedAgentPromptValue === agentPrompt ? '已复制' : '复制给 Agent'}
            </button>
          </section>
        ) : null}
        {!readOnly && !shareMode && shareDialogOpen.value ? (
          <Dialog open={true} onOpenChange={(value) => { if (!value) closeShareDialog() }}>
            <DialogContent style={{ width: 'calc(100vw - 32px)', maxWidth: '700px', maxHeight: '90vh', overflowX: 'hidden', overflowY: 'auto', boxSizing: 'border-box', padding: 'clamp(18px, 3vw, 26px)' }}>
              <DialogHeader>
                <DialogTitle>分享会话</DialogTitle>
                <DialogDescription>生成只读链接。当前调用链筛选与指定节点会固化到分享凭据，页面和 Agent 只能读取该范围内经过脱敏的内容。</DialogDescription>
              </DialogHeader>
              <div style={{ display: 'grid', gap: '18px', minWidth: 0 }}>
                <fieldset style={{ minWidth: 0, margin: 0, padding: 0, border: 0 }}>
                  <legend style={{ marginBottom: '8px', fontSize: '12px', fontWeight: 650, color: 'var(--text-secondary)' }}>有效期</legend>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', minWidth: 0 }}>
                    {SHARE_DURATION_OPTIONS.map((option) => {
                      const selectedDuration = shareDuration.value === option.value
                      return (
                        <label
                          key={option.value}
                          style={{ display: 'flex', flex: '1 1 104px', alignItems: 'center', justifyContent: 'center', gap: '7px', minWidth: 0, boxSizing: 'border-box', padding: '9px 10px', borderRadius: '9px', border: selectedDuration ? '1px solid rgba(59,158,255,0.72)' : '1px solid var(--control-stroke)', background: selectedDuration ? 'rgba(59,158,255,0.13)' : 'rgba(255,255,255,0.025)', color: selectedDuration ? '#dbeafe' : 'var(--text-secondary)', fontSize: '12px', fontWeight: selectedDuration ? 650 : 500, cursor: shareCreating.value || !!shareResult.value ? 'default' : 'pointer', transition: 'border-color 160ms ease, background 160ms ease, color 160ms ease' }}
                        >
                          <input
                            type="radio"
                            name="session-share-duration"
                            value={option.value}
                            checked={selectedDuration}
                            disabled={shareCreating.value || !!shareResult.value}
                            onChange={() => { shareDuration.value = option.value }}
                            style={{ width: '14px', height: '14px', margin: 0, flexShrink: 0, accentColor: 'var(--brand-blue)' }}
                          />
                          <span>{option.label}</span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
                {shareError.value ? <div style={{ color: '#f87171', fontSize: '12px' }}>{shareError.value}</div> : null}
                {shareResult.value ? (
                  <div style={{ display: 'grid', gap: '14px', minWidth: 0, padding: '14px', boxSizing: 'border-box', borderRadius: '12px', border: '1px solid rgba(59,158,255,0.2)', background: 'rgba(59,158,255,0.055)' }}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>有效至 {formatDateTime(shareResult.value.expires_at)}</div>
                    <div style={{ display: 'grid', gap: '7px', minWidth: 0 }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>分享链接</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'stretch', minWidth: 0 }}>
                        <input readOnly value={displayedShareUrl(shareResult.value)} style={{ width: '100%', minWidth: 0, flex: '1 1 360px', boxSizing: 'border-box', borderRadius: '8px', border: '1px solid var(--control-stroke)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', padding: '9px 10px', fontSize: '12px' }} />
                        <Button variant="outline" style={{ flex: '0 0 auto' }} onClick={(event) => copyShareValue(displayedShareUrl(shareResult.value), shareLinkCopied, event.currentTarget.closest('[role="dialog"]'))}>{shareLinkCopied.value ? '已复制' : '复制链接'}</Button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: '7px', minWidth: 0 }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Agent Prompt</span>
                      <pre style={{ width: '100%', margin: 0, maxHeight: '180px', overflow: 'auto', boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', borderRadius: '10px', border: '1px solid var(--control-stroke)', background: 'rgba(0,0,0,0.22)', padding: '12px', color: 'var(--text-primary)', fontSize: '11px', lineHeight: 1.6 }}>{shareResult.value.agent_prompt || ''}</pre>
                      <Button variant="outline" style={{ justifySelf: 'start' }} onClick={(event) => copyShareValue(shareResult.value.agent_prompt, sharePromptCopied, event.currentTarget.closest('[role="dialog"]'))}>{sharePromptCopied.value ? '已复制' : '复制 Agent Prompt'}</Button>
                    </div>
                  </div>
                ) : null}
                {shareCopyError.value ? <div role="alert" style={{ color: '#f87171', fontSize: '12px' }}>{shareCopyError.value}</div> : null}
                <section style={{ display: 'grid', gap: '9px', minWidth: 0, paddingTop: '2px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 650, color: 'var(--text-secondary)' }}>有效分享</div>
                    {!activeSharesLoading.value ? <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{activeShares.value.length} 个</span> : null}
                  </div>
                  {activeSharesLoading.value ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '54px', color: 'var(--text-muted)', fontSize: '12px' }}><span className="session-summary-spinner" />正在加载有效分享…</div>
                  ) : activeShares.value.length ? (
                    <div style={{ display: 'grid', gap: '8px', maxHeight: '210px', overflowY: 'auto', paddingRight: '2px' }}>
                      {activeShares.value.map((share) => (
                        <div key={share.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px 12px', minWidth: 0, padding: '10px 11px', boxSizing: 'border-box', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.075)', background: 'rgba(255,255,255,0.025)' }}>
                          <div style={{ minWidth: 0, flex: '1 1 220px', display: 'grid', gap: '3px', fontSize: '11px' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>创建于 {formatDateTime(share.created_at)}</span>
                            <span style={{ color: 'var(--text-muted)' }}>到期 {formatDateTime(share.expires_at)} · {formatShareRemaining(share.expires_at)}</span>
                            {expandedActiveShareId.value === share.id ? (
                              <div style={{ display: 'grid', gap: '5px', minWidth: 0, marginTop: '5px' }}>
                                <input data-active-share-link readOnly autoFocus={true} aria-label="分享链接，点击后按 ⌘C 或 Ctrl+C 复制" value={displayedShareUrl(share)} onFocus={selectShareLinkInput} onClick={selectShareLinkInput} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', borderRadius: '7px', border: '1px solid var(--control-stroke)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', padding: '7px 8px', fontSize: '11px' }} />
                                <span role="status" style={{ color: '#fbbf24' }}>链接已展开，请手动按 ⌘C / Ctrl+C 复制</span>
                              </div>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', flex: '0 1 auto', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '6px', marginLeft: 'auto' }}>
                            <Button variant="outline" size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flex: '0 0 auto' }} disabled={!share.share_url} onClick={(event) => copyActiveShare(share, event.currentTarget.closest('[role="dialog"]'))}>
                              <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                              {share.share_url ? (copiedActiveShareId.value === share.id ? '已复制' : '复制链接') : '链接不可用'}
                            </Button>
                            <Button variant="outline" size="sm" style={{ flex: '0 0 auto', color: '#fca5a5' }} disabled={!!revokingShareId.value} onClick={() => revokeShare(share.id)}>{revokingShareId.value === share.id ? '撤回中…' : '撤回'}</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : activeSharesError.value ? (
                    <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px', borderRadius: '10px', border: '1px solid rgba(248,113,113,0.24)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '12px' }}>
                      <span>{activeSharesError.value}</span>
                      <Button variant="outline" size="sm" onClick={() => fetchActiveShares()}>重新加载</Button>
                    </div>
                  ) : (
                    <div style={{ padding: '16px 12px', borderRadius: '10px', border: '1px dashed rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>当前没有有效分享</div>
                  )}
                  {activeSharesError.value && activeShares.value.length ? <div role="alert" style={{ color: '#f87171', fontSize: '12px' }}>{activeSharesError.value}</div> : null}
                </section>
              </div>
              <DialogFooter style={{ gap: '8px', flexWrap: 'wrap' }}>
                {!shareResult.value ? <Button onClick={() => createShare()} disabled={shareCreating.value}>{shareCreating.value ? '创建中…' : '创建分享链接'}</Button> : null}
                <Button variant="ghost" onClick={() => closeShareDialog()}>关闭</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    )
  })

  return SessionDetailView
}
