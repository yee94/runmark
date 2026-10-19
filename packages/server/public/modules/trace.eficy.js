/**
 * 调用链时间线：messages / turns / tools / subagent / fork / Cursor 对账展示
 */

const FORK_TITLE_RE = /\(fork\s*#\d+\)/i

function isCursorUsageTurnId(id) {
  return id && String(id).indexOf('cursor-usage-') === 0
}

/** 调用链筛选分类（固定顺序，与 URL types 一致） */
export const TRACE_CATEGORIES = Object.freeze([
  'user',
  'reasoning',
  'assistant',
  'turn',
  'tool',
  'abort',
  'error',
  'subagent',
])

const TRACE_CATEGORY_SET = new Set(TRACE_CATEGORIES)

/** 工具节点稳定 key：tool_calls 表主键 */
export function toolTraceKey(row) {
  return 'tool-' + row.id
}

/** Cursor 合成 turn：无 Hook turn 时按 messageId 稳定命名 */
export function cursorTurnTraceKey(messageId) {
  return 'cursor-turn-' + messageId
}

/** fork 结构行（来源会话 / 父会话首条）筛选时始终可见 */
export function isForkStructuralItem(item) {
  return !!(item && (item.kind === 'fork-from' || item.forkOrigin))
}

/** 将时间线条目映射到筛选分类；结构行返回 null */
export function traceItemCategory(item) {
  if (!item || isForkStructuralItem(item)) return null
  if (item.kind === 'subagent') return 'subagent'
  if (item.kind === 'tool') return 'tool'
  if (item.kind === 'turn') {
    if (item.abort || item.role === 'turn-abort') return 'abort'
    if (item.role === 'turn-fail') return 'error'
    return 'turn'
  }
  if (item.kind === 'message') {
    if (item.role === 'reasoning') return 'reasoning'
    if (item.role === 'assistant') return 'assistant'
    if (item.role === 'tool') return 'tool'
    return 'user'
  }
  return null
}

function selectedTraceCategories(types) {
  const selected = []
  const seen = new Set()
  for (const raw of types || []) {
    const type = String(raw || '').trim()
    if (!TRACE_CATEGORY_SET.has(type) || seen.has(type)) continue
    seen.add(type)
    selected.push(type)
  }
  return selected
}

/** 分类计数（未筛选时间线；结构行不计入） */
export function countTraceCategories(items) {
  const counts = {}
  for (const cat of TRACE_CATEGORIES) counts[cat] = 0
  for (const it of items || []) {
    const cat = traceItemCategory(it)
    if (cat && TRACE_CATEGORY_SET.has(cat)) counts[cat] += 1
  }
  return counts
}

/** 按选中分类筛选；空选中表示全部分类；fork 结构行始终可见 */
export function filterTraceItems(items, types) {
  const selected = selectedTraceCategories(types)
  const showAll = selected.length === 0 || selected.length === TRACE_CATEGORIES.length
  return (items || []).filter((it) => {
    if (isForkStructuralItem(it)) return true
    if (showAll) return true
    const cat = traceItemCategory(it)
    return !!(cat && selected.indexOf(cat) >= 0)
  })
}

/** 统一解析选中项：显式 pending 保留，筛掉或无 node 时保持未选中 */
export function resolveTraceSelection(items, selectedKey, types) {
  const list = items || []
  const visible = filterTraceItems(list, types)
  const key = selectedKey == null ? '' : String(selectedKey).trim()
  if (key) {
    if (visible.some((it) => it.key === key)) return key
    const inTimeline = list.some((it) => it.key === key)
    if (!inTimeline) return key
    return null
  }
  return null
}

/** 点击当前行取消选择，点击其他行切换选择 */
export function toggleTraceSelectionKey(selectedKey, itemKey) {
  if (itemKey == null || itemKey === '') return null
  return selectedKey === itemKey ? null : itemKey
}

/** child 查询由选中项 ownerSessionId 相对根会话得出；subagent 桩仍属父会话 */
export function traceChildQuery(item, rootSessionId) {
  if (!item || rootSessionId == null || rootSessionId === '') return null
  const ownerId = item.ownerSessionId
  if (ownerId == null || ownerId === '') return null
  if (String(ownerId) === String(rootSessionId)) return null
  return String(ownerId)
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
  function buildForkTracePrelude(detail, ownerSessionId) {
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
      ownerSessionId,
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
          ownerSessionId,
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

  function pushTurnTraceItem(items, turn, createdAt, depth, ownerSessionId, key) {
    const aborted = isUserAbortTurn(turn)
    items.push({
      key: key || ('turn-' + turn.id),
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
      ownerSessionId,
    })
  }

  /** 合并 messages / turns / tools / subagent 为时间线 */
  function buildTraceItems(detail, depth, sessionCtx, ownerSessionId) {
    if (!detail) return []
    depth = depth || 0
    const ownerId = ownerSessionId || (sessionCtx && sessionCtx.id) || (detail.session && detail.session.id) || null
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
        ownerSessionId: ownerId,
      })
    }

    const cursorTurnIdx = isCursorAgentSession(detail, sessionCtx) ? indexCursorTurnsByMessage(turns) : null

    for (const turn of turns) {
      if (sessionCtx && !isEventAfterFork(sessionCtx, turn.created_at)) continue
      // cursor-usage-* 为对账数据，不单独占一行（展示合并到 assistant 锚点）
      if (isCursorUsageTurnId(turn.id)) continue
      const hookAnchor = cursorTurnIdx && turn.message_id && messages.find((m) => m.id === turn.message_id)
      const createdAt = hookAnchor ? hookAnchor.created_at : turn.created_at
      pushTurnTraceItem(items, turn, createdAt, depth, ownerId)
    }

    // Cursor：每条 assistant 无 Hook turn 时补 LLM 节点（时间=消息，cost 取自对账 turn）
    if (cursorTurnIdx) {
      for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        if (sessionCtx && !isEventAfterFork(sessionCtx, msg.created_at)) continue
        if (cursorTurnIdx.hookByMsg[msg.id]) continue
        const display = cursorDisplayTurn(null, cursorTurnIdx.billingByMsg[msg.id], msg)
        pushTurnTraceItem(items, { id: msg.id, ...display }, msg.created_at, depth, ownerId, cursorTurnTraceKey(msg.id))
      }
    }

    for (const tool of tools) {
      if (sessionCtx && !isEventAfterFork(sessionCtx, tool.created_at)) continue
      // 父时间线：子 agent 的 tool.call_id 不要再画一份（PostToolUse 误挂到父会话）
      if (depth === 0 && tool.call_id && detail.childToolCallIds && detail.childToolCallIds[tool.call_id]) continue
      const title = tool.output_title ? ': ' + tool.output_title : ''
      items.push({
        key: toolTraceKey(tool),
        kind: 'tool',
        role: 'tool',
        summary: (tool.tool_name || 'tool') + title,
        fullText: tool.output_text || tool.output_title || '',
        created_at: tool.created_at,
        depth,
        ownerSessionId: ownerId,
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
        ownerSessionId: ownerId,
      })
    }

    // 同时间戳时：user → turn（计量）→ reasoning → assistant → tool → 其它，避免「回复压在推理上面」
    const tieBreak = (it) => {
      if (it.kind === 'fork-from') return 0
      if (it.kind === 'message' && (it.role === 'user' || it.role === 'system')) return 1
      if (it.kind === 'turn') return 2
      if (it.kind === 'message' && it.role === 'reasoning') return 3
      if (it.kind === 'message' && it.role === 'assistant') return 4
      if (it.kind === 'message') return 5
      if (it.kind === 'tool') return 6
      if (it.kind === 'subagent') return 7
      return 8
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

  /** 子会话上下文：优先父级 subagent 行上的 childSession，其次 child detail.session */
  function childSessionContext(item, childDetail, childId) {
    const fromItem = item && item.childSession
    const fromDetail = childDetail && childDetail.session
    if (!fromItem && !fromDetail) return { id: childId }
    return {
      ...(fromDetail || {}),
      ...(fromItem || {}),
      id: childId,
    }
  }

  /** 展开 subagent 后扁平化 trace（含嵌套子项） */
  function flattenTraceItems(rootSessionId, items, detail, sessionCtx) {
    const flat = []
    const expanded = expandedSubagents.value
    const childDetails = (detail && detail.childDetails) || {}
    const walk = (list, ownerId, seen) => {
      for (const it of list || []) {
        const item = it.ownerSessionId ? it : { ...it, ownerSessionId: ownerId }
        flat.push(item)
        if (item.kind === 'subagent' && expanded[item.childSessionId]) {
          const childId = item.childSessionId
          if (!childId || seen.has(childId)) continue
          const childDetail = childDetails[childId]
          if (!childDetail) continue
          const nextSeen = new Set(seen)
          nextSeen.add(childId)
          const nested = buildTraceItems(
            childDetail,
            (item.depth || 0) + 1,
            childSessionContext(item, childDetail, childId),
            childId,
          )
          walk(nested.map((n) => ({ ...n, nested: true })), childId, nextSeen)
        }
      }
    }
    const seen = new Set()
    if (rootSessionId) seen.add(rootSessionId)
    walk(items, rootSessionId, seen)
    return flat
  }

  function mergeForkTraceItems(session, detail) {
    const ownerId = (session && session.id) || (detail && detail.session && detail.session.id) || null
    const prelude = buildForkTracePrelude(detail, ownerId)
    const body = flattenTraceItems(
      ownerId,
      buildTraceItems(detail, 0, session, ownerId),
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
    buildTraceItems,
    flattenTraceItems,
    buildForkTracePrelude,
    TRACE_CATEGORIES,
    isForkStructuralItem,
    traceItemCategory,
    countTraceCategories,
    filterTraceItems,
    resolveTraceSelection,
    toggleTraceSelectionKey,
    traceChildQuery,
    toolTraceKey,
    cursorTurnTraceKey,
  }
}
