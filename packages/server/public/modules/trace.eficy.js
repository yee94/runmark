/**
 * 调用链时间线：messages / turns / tools / subagent / fork / Cursor 对账展示
 */

const FORK_TITLE_RE = /\(fork\s*#\d+\)/i

function isCursorUsageTurnId(id) {
  return id && String(id).indexOf('cursor-usage-') === 0
}

/** 工厂：注入 index 侧格式化与 signals */
export function createTraceHelpers(ctx) {
  const {
    formatMessageContent,
    isGarbageMessage,
    parseSessionMetadata,
    formatTokens,
    formatCost,
    formatDuration,
    formatSessionDuration,
    expandedSubagents,
  } = ctx

  /** OpenCode fork 会话：title 含 (fork #N) 或 API 返回 is_fork */
  function isForkSession(session) {
    if (!session) return false
    if (session.is_fork) return true
    return FORK_TITLE_RE.test(session.title || session.summary || '')
  }

  function forkParentSessionId(session) {
    if (!session) return null
    return session.fork_parent_session_id || null
  }

  /** fork 会话仅展示 fork 创建后的 event */
  function isEventAfterFork(session, createdAt) {
    if (!isForkSession(session) || !session.started_at || !createdAt) return true
    return String(createdAt) >= String(session.started_at)
  }

  /** fork 调用链顶部：来源会话 + 父会话首条消息 */
  function buildForkTracePrelude(detail) {
    if (!detail?.forkParent) return []
    const parent = detail.forkParent
    const parentId = parent.id
    const parentTitle = (parent.title && String(parent.title).trim()) || parent.summary || parentId
    const items = [{
      key: 'fork-from-' + parentId,
      kind: 'fork-from',
      role: 'fork-from',
      summary: 'Fork from · ' + parentTitle,
      fullText: '来源会话：' + parentTitle + '\n点击跳转到来源会话调用链。',
      parentSessionId: parentId,
      created_at: parent.started_at || parent.last_activity_at || '',
      depth: 0,
    }]
    const msg = detail.forkParentFirstMessage
    if (msg && !isGarbageMessage(msg.content)) {
      const text = formatMessageContent(msg.content)
      if (text) {
        items.push({
          key: 'fork-origin-msg-' + msg.id,
          kind: 'message',
          role: msg.role || 'user',
          summary: text.length > 120 ? text.slice(0, 120) + '…' : text,
          fullText: text,
          model: msg.model,
          created_at: msg.created_at || parent.started_at || '',
          depth: 0,
          forkOrigin: true,
        })
      }
    }
    return items
  }

  /** subagent 行展示文案（含 agent / model） */
  function formatSubagentHead(child) {
    const meta = parseSessionMetadata(child.metadata)
    const parts = []
    if (meta.opencode_agent) parts.push(meta.opencode_agent)
    if (child.model) parts.push(child.model)
    else if (child.provider) parts.push(child.provider)
    return parts.join(' · ')
  }

  function formatSubagentLabel(child) {
    const title = (child.title && String(child.title).trim()) || child.summary
    const head = formatSubagentHead(child)
    if (title && title !== child.id) {
      const short = title.length > 72 ? title.slice(0, 72) + '…' : title
      return head ? head + ' · ' + short : short
    }
    return head || 'Subagent'
  }

  function buildSubagentDetail(child) {
    const meta = parseSessionMetadata(child.metadata)
    const lines = []
    if (meta.opencode_agent) lines.push('Agent: ' + meta.opencode_agent)
    if (child.model) {
      lines.push('Model: ' + child.model + (child.provider ? ' (' + child.provider + ')' : ''))
    } else if (child.provider) {
      lines.push('Provider: ' + child.provider)
    }
    const title = (child.title && String(child.title).trim()) || child.summary
    if (title && title !== child.id) lines.push('Task: ' + title)
    lines.push('Tokens: ' + formatTokens(child.total_tokens))
    lines.push('Cost: ' + formatCost(child.total_cost_cny ?? 0))
    if (child.duration_ms != null) lines.push('Duration: ' + formatSessionDuration(child.duration_ms))
    lines.push('Session: ' + child.id)
    return lines.join('\n')
  }

  /** 用户主动 Abort（非 API Error） */
  function isUserAbortTurn(turn) {
    if (!turn) return false
    const err = String(turn.error || '').toLowerCase()
    const finish = String(turn.finish_reason || '').toLowerCase()
    return (
      err === 'aborted' ||
      finish === 'aborted' ||
      // OpenCode：session.error → MessageAbortedError
      err.includes('messageaborted') ||
      err.includes('interrupted by user') ||
      err.includes('aborted by user')
    )
  }

  function summarizeTurn(turn) {
    const parts = [turn.model || 'turn']
    if (isUserAbortTurn(turn)) parts.push('Abort')
    else if (turn.error) parts.push('Error')
    else if (turn.finish_reason) parts.push(turn.finish_reason)
    return parts.join(' · ')
  }

  function buildTurnDetail(turn) {
    const lines = [
      'Model: ' + (turn.model || '—') + ' (' + (turn.provider || '—') + ')',
      'Tokens: in ' + formatTokens(turn.input_tokens) +
        ' · out ' + formatTokens(turn.output_tokens) +
        (turn.cache_read_tokens ? ' · cache读 ' + formatTokens(turn.cache_read_tokens) : '') +
        (turn.reasoning_tokens ? ' · reason ' + formatTokens(turn.reasoning_tokens) : ''),
      'Duration: ' + formatDuration(turn.duration_ms),
      'Cost: ' + formatCost(turn.cost_cny ?? 0),
    ]
    if (isUserAbortTurn(turn)) {
      lines.push('Status: 用户 Abort')
      if (turn.finish_reason && turn.finish_reason !== 'aborted') {
        lines.push('Finish: ' + turn.finish_reason)
      }
      if (turn.error && String(turn.error).toLowerCase() !== 'aborted') {
        lines.push('Detail: ' + turn.error)
      }
    } else {
      if (turn.finish_reason) lines.push('Finish: ' + turn.finish_reason)
      if (turn.error) lines.push('Error: ' + turn.error)
    }
    return lines.join('\n')
  }

  function isCursorAgentSession(detail, sessionCtx) {
    const agent = (sessionCtx && sessionCtx.agent) || (detail && detail.session && detail.session.agent)
    return agent === 'cursor'
  }

  /** Hook turn 或 cursor-usage 对账行（按 message_id 索引，供展示合并） */
  function indexCursorTurnsByMessage(turns) {
    const hookByMsg = {}
    const billingByMsg = {}
    for (const turn of turns || []) {
      const msgId = turn.message_id || (turn.id && String(turn.id).indexOf('assistant-') === 0 ? turn.id : null)
      if (!msgId) continue
      if (isCursorUsageTurnId(turn.id)) billingByMsg[msgId] = turn
      else hookByMsg[msgId] = turn
    }
    return { hookByMsg, billingByMsg }
  }

  function cursorDisplayTurn(hookTurn, billingTurn, msg) {
    const src = hookTurn || billingTurn || {}
    return {
      model: src.model || msg.model,
      provider: src.provider || msg.provider,
      input_tokens: src.input_tokens ?? 0,
      output_tokens: src.output_tokens ?? 0,
      cache_read_tokens: src.cache_read_tokens ?? 0,
      cache_write_tokens: src.cache_write_tokens ?? 0,
      reasoning_tokens: src.reasoning_tokens ?? 0,
      total_tokens: src.total_tokens ?? 0,
      duration_ms: src.duration_ms ?? 0,
      cost_cny: src.cost_cny ?? 0,
      finish_reason: src.finish_reason,
      error: src.error,
    }
  }

  function pushTurnTraceItem(items, turn, createdAt, depth) {
    const aborted = isUserAbortTurn(turn)
    items.push({
      key: 'turn-' + turn.id,
      kind: 'turn',
      role: aborted ? 'turn-abort' : (turn.error ? 'turn-fail' : 'turn'),
      abort: aborted,
      summary: summarizeTurn(turn),
      fullText: buildTurnDetail(turn),
      model: turn.model,
      tokens: turn.total_tokens,
      cost_cny: turn.cost_cny,
      created_at: createdAt,
      depth,
    })
  }

  /** 合并 messages / turns / tools / subagent 为时间线 */
  function buildTraceItems(detail, depth, sessionCtx) {
    if (!detail) return []
    depth = depth || 0
    const items = []
    const messages = detail.messages || []
    const turns = detail.turns || []
    const tools = detail.tools || []
    const children = detail.children || []

    for (const msg of messages) {
      if (sessionCtx && !isEventAfterFork(sessionCtx, msg.created_at)) continue
      if (isGarbageMessage(msg.content)) continue
      const text = formatMessageContent(msg.content)
      if (!text) continue
      items.push({
        key: 'msg-' + msg.id,
        kind: 'message',
        role: msg.role || 'unknown',
        summary: text.length > 120 ? text.slice(0, 120) + '…' : text,
        fullText: text,
        model: msg.model,
        created_at: msg.created_at,
        depth,
      })
    }

    const cursorTurnIdx = isCursorAgentSession(detail, sessionCtx) ? indexCursorTurnsByMessage(turns) : null

    for (const turn of turns) {
      if (sessionCtx && !isEventAfterFork(sessionCtx, turn.created_at)) continue
      // cursor-usage-* 为对账数据，不单独占一行（展示合并到 assistant 锚点）
      if (isCursorUsageTurnId(turn.id)) continue
      const hookAnchor = cursorTurnIdx && turn.message_id && messages.find((m) => m.id === turn.message_id)
      const createdAt = hookAnchor ? hookAnchor.created_at : turn.created_at
      pushTurnTraceItem(items, turn, createdAt, depth)
    }

    // Cursor：每条 assistant 无 Hook turn 时补 LLM 节点（时间=消息，cost 取自对账 turn）
    if (cursorTurnIdx) {
      for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        if (sessionCtx && !isEventAfterFork(sessionCtx, msg.created_at)) continue
        if (cursorTurnIdx.hookByMsg[msg.id]) continue
        const display = cursorDisplayTurn(null, cursorTurnIdx.billingByMsg[msg.id], msg)
        pushTurnTraceItem(items, { id: msg.id, ...display }, msg.created_at, depth)
      }
    }

    for (const tool of tools) {
      if (sessionCtx && !isEventAfterFork(sessionCtx, tool.created_at)) continue
      const title = tool.output_title ? ': ' + tool.output_title : ''
      items.push({
        key: 'tool-' + tool.call_id,
        kind: 'tool',
        role: 'tool',
        summary: (tool.tool_name || 'tool') + title,
        fullText: tool.output_text || tool.output_title || '',
        created_at: tool.created_at,
        depth,
      })
    }

    for (const child of children) {
      items.push({
        key: 'subagent-' + child.id,
        kind: 'subagent',
        role: 'subagent',
        summary: formatSubagentLabel(child),
        fullText: buildSubagentDetail(child),
        model: child.model,
        provider: child.provider,
        childSessionId: child.id,
        childSession: child,
        tokens: child.total_tokens,
        cost_cny: child.total_cost_cny,
        created_at: child.started_at,
        depth,
      })
    }

    // 同时间戳时：user → turn（计量）→ assistant → tool → 其它，避免「回复压在推理上面」
    const tieBreak = (it) => {
      if (it.kind === 'fork-from') return 0
      if (it.kind === 'message' && (it.role === 'user' || it.role === 'system')) return 1
      if (it.kind === 'turn') return 2
      if (it.kind === 'message' && it.role === 'assistant') return 3
      if (it.kind === 'message') return 4
      if (it.kind === 'tool') return 5
      if (it.kind === 'subagent') return 6
      return 7
    }
    items.sort((a, b) => {
      const ta = new Date(a.created_at).getTime()
      const tb = new Date(b.created_at).getTime()
      if (ta !== tb) return ta - tb
      const oa = tieBreak(a)
      const ob = tieBreak(b)
      if (oa !== ob) return oa - ob
      return String(a.key || '').localeCompare(String(b.key || ''))
    })
    items.forEach((it, i) => { it.seq = i + 1 })
    return items
  }

  /** 展开 subagent 后扁平化 trace（含嵌套子项） */
  function flattenTraceItems(rootSessionId, items, detail, sessionCtx) {
    const flat = []
    const expanded = expandedSubagents.value
    const childDetails = (detail && detail.childDetails) || {}
    for (const it of items) {
      flat.push(it)
      if (it.kind === 'subagent' && expanded[it.childSessionId]) {
        const childDetail = childDetails[it.childSessionId]
        if (childDetail) {
          const nested = buildTraceItems(childDetail, (it.depth || 0) + 1, null)
          flat.push(...nested.map((n) => ({ ...n, nested: true })))
        }
      }
    }
    return flat
  }

  function mergeForkTraceItems(session, detail) {
    const prelude = buildForkTracePrelude(detail)
    const body = flattenTraceItems(
      session?.id,
      buildTraceItems(detail, 0, isForkSession(session) ? session : null),
      detail,
      session,
    )
    const merged = [...prelude, ...body]
    merged.forEach((it, i) => { it.seq = i + 1 })
    return merged
  }

  return {
    isForkSession,
    forkParentSessionId,
    mergeForkTraceItems,
  }
}
