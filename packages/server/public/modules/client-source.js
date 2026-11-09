export function formatClientId(id) {
  return id === 'yuri' ? 'Yuri' : (id || '未知')
}

export function resolveClientIconUrl(id) {
  return id === 'yuri' ? './client-icons/yuri.svg' : null
}

export function sessionClientSources(session) {
  const ids = [...(session?.client_ids || [])]
  if (!ids.length || session.has_unknown_client) ids.push(null)
  return ids.map(id => ({ id, label: formatClientId(id), icon: resolveClientIconUrl(id) }))
}

export function formatSessionClients(session) {
  return sessionClientSources(session).map(client => client.label).join(' / ')
}

export function sessionAgents(session, formatAgentLabel, resolveAgentIconUrl) {
  const id = session?.agent
  return [{ id, label: id === 'yuri' ? 'Yuri' : (formatAgentLabel?.(id) || id || '—'), icon: resolveClientIconUrl(id) || resolveAgentIconUrl?.(id) || null }]
}
