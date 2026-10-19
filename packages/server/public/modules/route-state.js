/**
 * Trace 路由状态：sessions / share hash 上的 types / node / child
 */

/** 与调用链筛选分类一致的固定顺序 */
export const TRACE_ROUTE_CATEGORIES = Object.freeze([
  'user',
  'reasoning',
  'assistant',
  'turn',
  'tool',
  'abort',
  'error',
  'subagent',
])

const TRACE_ROUTE_CATEGORY_SET = new Set(TRACE_ROUTE_CATEGORIES)
const TRACE_ROUTE_CATEGORY_RANK = new Map(TRACE_ROUTE_CATEGORIES.map((cat, index) => [cat, index]))

function emptyToNull(value) {
  const text = value == null ? '' : String(value).trim()
  return text ? text : null
}

/** 规范化 types：去掉未知值、去重、固定分类顺序；全选视为默认空集 */
export function canonicalizeTraceTypes(types) {
  const seen = new Set()
  const out = []
  for (const raw of types || []) {
    const type = String(raw || '').trim()
    if (!TRACE_ROUTE_CATEGORY_SET.has(type) || seen.has(type)) continue
    seen.add(type)
    out.push(type)
  }
  out.sort((a, b) => TRACE_ROUTE_CATEGORY_RANK.get(a) - TRACE_ROUTE_CATEGORY_RANK.get(b))
  if (out.length === TRACE_ROUTE_CATEGORIES.length) return []
  return out
}

/** 调用链分类单选；再次选择当前分类时恢复默认全量 */
export function toggleTraceTypeSelection(types, category) {
  const next = canonicalizeTraceTypes([category])
  if (!next.length) return []
  const current = canonicalizeTraceTypes(types)
  return current.length === 1 && current[0] === next[0] ? [] : next
}

/** 解析 types / node / child 查询串 */
export function parseTraceRouteQuery(query) {
  const params = query instanceof URLSearchParams
    ? query
    : new URLSearchParams(query == null ? '' : String(query).replace(/^\?/, ''))
  return {
    types: canonicalizeTraceTypes(String(params.get('types') || '').split(',')),
    node: emptyToNull(params.get('node')),
    child: emptyToNull(params.get('child')),
  }
}

/** 序列化 types / node / child；默认值省略 */
export function serializeTraceRouteQuery(state) {
  const types = canonicalizeTraceTypes(state && state.types)
  const node = emptyToNull(state && state.node)
  const child = emptyToNull(state && state.child)
  const parts = []
  if (types.length) parts.push('types=' + types.join(','))
  if (node) parts.push('node=' + encodeURIComponent(node))
  if (child) parts.push('child=' + encodeURIComponent(child))
  return parts.join('&')
}

/** 非法百分号转义时保留原文，避免 SPA 解析抛错 */
function decodeURIComponentSafe(value) {
  const text = value == null ? '' : String(value)
  if (!text) return text
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function splitHash(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  const qIndex = raw.indexOf('?')
  const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : ''
  return { path, query }
}

/** 解析 sessions / share hash 上的 types / node / child */
export function parseTraceRouteHash(hash) {
  const { path, query } = splitHash(hash)
  const parts = path.split('/').filter(Boolean)
  const parsedQuery = parseTraceRouteQuery(query)
  let kind = null
  let sessionId = null
  let shareToken = null
  if (parts[0] === 'sessions' && parts[1]) {
    kind = 'sessions'
    sessionId = decodeURIComponentSafe(parts[1])
  } else if (parts[0] === 'share' && parts[1]) {
    kind = 'share'
    shareToken = decodeURIComponentSafe(parts[1])
  }
  return {
    kind,
    sessionId,
    shareToken,
    types: parsedQuery.types,
    node: parsedQuery.node,
    child: parsedQuery.child,
  }
}

/** 序列化 sessions / share hash；默认 types / node / child 省略 */
export function serializeTraceRouteHash(state) {
  const kind = state && state.kind
  let path = ''
  if (kind === 'sessions' && state.sessionId) {
    path = '/sessions/' + encodeURIComponent(state.sessionId)
  } else if (kind === 'share' && state.shareToken) {
    path = '/share/' + encodeURIComponent(state.shareToken)
  }
  const query = serializeTraceRouteQuery(state)
  return '#' + path + (query ? '?' + query : '')
}
