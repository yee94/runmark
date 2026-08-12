import { component } from 'eficy'

export function createSummaryPanels(ctx) {
  const {
    summary, summaryEfficiency, dailyChart, dailyModelLegend, hoveredDailyRow, dailyChartMetric, topAgents, topAgentMax, topModels, topModelMax, topCostSessions,
    statsRange, modelSort, activeTab,
    formatPct, pctPart, formatTokens, formatCost, formatDateShort, resolveModelIconUrl, resolveAgentIconUrl, formatAgentLabel, colorForModel,
    TOKEN_SEGMENTS, RANGE_OPTIONS,
    setStatsRange, setModelSort, openSession, navigate,
    SectionTitle, EmptyState,
  } = ctx

  // ─── 总览：Token 组成 ───
  const TokenBreakdownPanel = component(() => {
    const tokens = summary.value?.tokens
    const total = tokens?.total || 0
    if (!total) return <EmptyState message="暂无 Token 数据" />
    return (
      <>
        <div className="token-stack-bar">
          {TOKEN_SEGMENTS.map((seg) => {
            const val = tokens?.[seg.key] || 0
            if (!val) return null
            return (
              <div
                key={seg.key}
                className="token-stack-seg"
                style={{ width: formatPct(pctPart(val, total)), background: seg.color }}
                title={seg.label + ' ' + formatTokens(val)}
              />
            )
          })}
        </div>
        <div className="token-legend">
          {TOKEN_SEGMENTS.map((seg) => {
            const val = tokens?.[seg.key] || 0
            if (!val) return null
            return (
              <div key={seg.key} className="token-legend-row">
                <span className="token-legend-label">
                  <span className="token-legend-dot" style={{ background: seg.color }} />
                  {seg.label}
                </span>
                <span className="token-legend-val">
                  {formatTokens(val)} · {formatPct(pctPart(val, total))}
                </span>
              </div>
            )
          })}
        </div>
      </>
    )
  })

  // ─── 总览：效率指标 ───
  const EfficiencyPanel = component(() => {
    const eff = summaryEfficiency.value
    if (!eff) return <EmptyState message="暂无效率数据" />
    return (
      <div className="metric-grid">
        <div className="metric-cell">
          <div className="metric-cell-label">每 Turn Token</div>
          <div className="metric-cell-val digits">{formatTokens(eff.avgTokensPerTurn)}</div>
          <div className="metric-cell-sub">平均单次 LLM 调用</div>
        </div>
        <div className="metric-cell">
          <div className="metric-cell-label">每会话费用</div>
          <div className="metric-cell-val digits">{formatCost(eff.avgCostPerSession)}</div>
          <div className="metric-cell-sub">Session 均值</div>
        </div>
        <div className="metric-cell">
          <div className="metric-cell-label">每 Turn 费用</div>
          <div className="metric-cell-val digits">{formatCost(eff.avgCostPerTurn)}</div>
          <div className="metric-cell-sub">LLM 调用均值</div>
        </div>
        <div className="metric-cell">
          <div className="metric-cell-label">缓存命中率</div>
          <div className="metric-cell-val digits">{formatPct(eff.cacheHitRatio)}</div>
          <div className="metric-cell-sub">Cache读 / (Input + Cache读)</div>
        </div>
      </div>
    )
  })

  // ─── 总览：每日趋势 ───
  const DailyTrendPanel = component(() => {
    const chart = dailyChart.value
    if (!chart.rows.length) return <EmptyState message="暂无趋势数据" />
    const legend = dailyModelLegend.value
    const hovered = hoveredDailyRow.value
    const metric = dailyChartMetric.value
    const byCost = metric === 'cost'
    const chartMax = byCost ? chart.maxCost : chart.maxTokens
    const modelVal = (m) => byCost ? (m.total_cost_cny || 0) : (m.total_tokens || 0)
    const rowTotal = (row) => byCost ? (row.total_cost_cny || 0) : (row.total_tokens || 0)
    const plotH = 144
    return (
      <div className="daily-trend-wrap">
        <div className="bar-chart">
          <div className="bar-chart-plot">
          {chart.rows.map((row, i) => {
            const dayTotal = rowTotal(row)
            const barH = Math.max(3, Math.round((dayTotal / chartMax) * plotH))
            const models = row.models || []
            const isHovered = hovered && hovered.date === row.date
            // tooltip 模型列表（Top 8）
            const tipModels = models
              .slice()
              .sort((a, b) => modelVal(b) - modelVal(a))
              .slice(0, 8)
            const tipMore = models.length > 8 ? models.length - 8 : 0
            return (
              <div
                key={row.date || i}
                className="bar-chart-col"
                style={{ position: 'relative' }}
                onMouseEnter={() => { hoveredDailyRow.value = row }}
                onMouseLeave={() => { hoveredDailyRow.value = null }}
              >
                <div
                  className="bar-chart-stack"
                  style={{ height: barH + 'px' }}
                >
                  {models.map((m, mi) => {
                    const val = modelVal(m)
                    if (!val) return null
                    const lbl = m.label || m.model || 'unknown'
                    const segPct = dayTotal ? (val / dayTotal) * 100 : 0
                    return (
                      <div
                        key={lbl + '-' + mi}
                        className="bar-chart-seg"
                        style={{ height: Math.max(segPct, 1) + '%', background: colorForModel(lbl), opacity: 0.85 }}
                      />
                    )
                  })}
                </div>
                <span className="bar-chart-label">{formatDateShort(row.date)}</span>
                {isHovered ? (
                  <div className="bar-chart-tip">
                    <div className="bar-chart-tip-date">{row.date}</div>
                    <div className="bar-chart-tip-total digits">
                      {byCost ? formatCost(dayTotal) : (formatTokens(dayTotal) + ' tokens')}
                    </div>
                    <div className="bar-chart-tip-sub">
                      {byCost
                        ? (formatTokens(row.total_tokens || 0) + ' tokens')
                        : formatCost(row.total_cost_cny)}
                    </div>
                    {tipModels.map((m) => {
                      const lbl = m.label || m.model || 'unknown'
                      const val = modelVal(m)
                      const pct = dayTotal ? formatPct(val / dayTotal) : '0%'
                      const metricText = byCost ? formatCost(val) : formatTokens(val)
                      return (
                        <div key={lbl} className="bar-chart-tip-row">
                          <span className="bar-chart-tip-dot" style={{ background: colorForModel(lbl) }} />
                          <span className="bar-chart-tip-label">{lbl}</span>
                          <span className="bar-chart-tip-val">{metricText} · {pct}</span>
                        </div>
                      )
                    })}
                    {tipMore > 0 ? <div className="bar-chart-tip-more">+{tipMore} more</div> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          </div>
        </div>
        <div className="bar-chart-legend">
          {legend.map((item) => (
            <span key={item.label} className="bar-chart-legend-item">
              <span className="bar-chart-legend-dot" style={{ background: item.color }} />
              <span className="bar-chart-legend-label">{item.label}</span>
            </span>
          ))}
        </div>
      </div>
    )
  })

  // ─── 总览：Agent 分布 ───
  const AgentBreakdownPanel = component(() => {
    const rows = topAgents.value
    const max = topAgentMax.value
    if (!rows.length) return <EmptyState message="暂无 Agent 数据" />
    return (
      <div className="hbar-list">
        {rows.map((row, i) => {
          const icon = resolveAgentIconUrl?.(row.agent) || null
          const label = formatAgentLabel?.(row.agent) || row.agent || '—'
          return (
          <div key={row.agent || i} className="hbar-row">
            <div className="hbar-head">
              <span className="hbar-name">
                {icon ? (
                  <span className="agent-label">
                    <img className="agent-label-icon" src={icon} alt="" />
                    {label}
                  </span>
                ) : (
                  <span className="badge badge-agent">{label}</span>
                )}
              </span>
              <span className="hbar-val">{formatCost(row.total_cost_cny)} · {formatTokens(row.total_tokens)}</span>
            </div>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{
                  width: formatPct(max ? (row.total_cost_cny || 0) / max : 0),
                  background: 'linear-gradient(90deg, rgba(74,222,128,0.5), var(--brand-green))',
                }}
              />
            </div>
          </div>
          )
        })}
      </div>
    )
  })

  // ─── 总览：Top 模型 ───
  const TopModelsPanel = component(() => {
    const rows = topModels.value
    const max = topModelMax.value
    if (!rows.length) return <EmptyState message="暂无模型数据" />
    return (
      <div className="hbar-list">
        {rows.map((row, i) => {
          const val = row.total_cost_cny || 0
          return (
            <div key={(row.model || '') + (row.provider || '') + i} className="hbar-row">
              <div className="hbar-head">
                <span className="hbar-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <img src={resolveModelIconUrl(row.model, row.provider)} alt="" style={{ width: 18, height: 18, borderRadius: 3, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.target.src = '/model-icons/unknown.svg' }} />
                  {row.model || '—'}
                </span>
                <span className="hbar-val">{formatCost(val)}</span>
              </div>
              <div className="hbar-track">
                <div
                  className="hbar-fill"
                  style={{
                    width: formatPct(max ? val / max : 0),
                    background: 'linear-gradient(90deg, rgba(59,158,255,0.45), var(--brand-blue))',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    )
  })

  // ─── 总览：高消耗会话 ───
  const TopSessionsPanel = component(() => {
    const rows = topCostSessions.value
    if (!rows.length) return <EmptyState message="暂无会话数据" />
    return (
      <>
        <div className="session-header session-header--compact">
          <div className="session-summary-col">Summary</div>
          <div className="session-agent-col">Agent</div>
          <div className="session-number-col">Tokens</div>
          <div className="session-number-col">Cost</div>
        </div>
        <div className="session-list">
          {rows.map((s, i) => {
            const icon = resolveAgentIconUrl?.(s.agent) || null
            const label = formatAgentLabel?.(s.agent) || s.agent || '—'
            return (
            <div
              key={s.id || i}
              className="session-row session-row--compact"
              onClick={() => openSession(s.id)}
            >
              <div className="session-summary-col">
                <span className="session-summary-text" title={s.summary || s.title || s.id}>
                  {s.summary || s.title || s.id || '—'}
                </span>
              </div>
              <div className="session-agent-col">
                {icon ? (
                  <span className="agent-label">
                    <img className="agent-label-icon" src={icon} alt="" />
                    {label}
                  </span>
                ) : (
                  <span className="badge badge-agent">{label}</span>
                )}
              </div>
              <div className="session-number-col digits">{formatTokens(s.total_tokens)}</div>
              <div className="session-number-col session-cost-col digits">{formatCost(s.total_cost_cny)}</div>
            </div>
            )
          })}
        </div>
      </>
    )
  })

  return { TokenBreakdownPanel, EfficiencyPanel, DailyTrendPanel, AgentBreakdownPanel, TopModelsPanel, TopSessionsPanel }
}

export function createSummaryPage(ctx) {
  const {
    kpiSessions, kpiTurns, kpiTokens, kpiCost,
    SessionsIcon, TurnsIcon, TokensIcon, CostIcon,
    ActivityIcon, RefreshIcon, LayoutIcon, CpuIcon, ListIcon,
    StatsToolbar, KpiCard, SectionTitle,
    TokenBreakdownPanel, EfficiencyPanel, DailyTrendPanel,
    AgentBreakdownPanel, TopModelsPanel, TopSessionsPanel,
    routeSessionId, activeTab, tabLabels, lastRefreshed,
    formatRelativeTime, fetchData, refreshing, isPublicDashboard,
    cursorStatus, cursorDialogOpen, fetchCursorStatus, logout,
    NavItem,
    loading, summary, navigate,
  } = ctx

  const App = component(() => {
    if (loading.value && !summary.value) {
      return <div className="flex items-center justify-center min-h-screen app-shell">
        <div className="text-center space-y-4">
          <div className="spinner-lg mx-auto" />
          <img className="loading-brand-logo" src="./brand/runmark-logo.png" alt="Runmark" />
        </div>
      </div>
    }

    return (
      <div className="app-shell">
        {/* Header */}
        <header className="topbar fade-up">
          <div className="flex items-center gap-3">
            <img className="topbar-brand-logo" src="./brand/runmark-logo.png" alt="Runmark" />
          </div>
          <div className="flex items-center gap-3">
            <span className="status-pill status-pill--ready">
              <span className="status-dot" />
              已就绪
            </span>
            {lastRefreshed.value
              ? <span className="digits" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{'更新于 ' + formatRelativeTime(lastRefreshed.value)}</span>
              : null}
            <button
              className="btn-ghost-sm"
              onClick={() => { cursorDialogOpen.value = true; fetchCursorStatus() }}
              title="配置 Cursor Session Token（可选）"
              style={cursorStatus.value && !cursorStatus.value.hasCookies ? { borderColor: 'rgba(251,191,36,0.45)', color: 'rgb(251,191,36)' } : undefined}
            >
              Cursor 账单
            </button>
            <button
              className="btn-circle"
              onClick={() => fetchData(true)}
              disabled={refreshing.value}
              title="手动刷新"
            >
              <RefreshIcon />
            </button>
            {!isPublicDashboard.value ? (
              <button className="btn-ghost-sm" onClick={() => logout()} title="退出登录">
                退出
              </button>
            ) : null}
          </div>
        </header>

        <div className="dashboard-layout">
          <aside className="sidebar fade-up fade-up-d1">
            <p className="sidebar-label">导航</p>
            <NavItem tab="summary" label="总览" icon={<LayoutIcon />} />
            <NavItem tab="models" label="模型" icon={<CpuIcon />} />
            <NavItem tab="sessions" label="会话" icon={<ListIcon />} />
          </aside>

          {/* Main Content */}
          <main className="main-content">
            {/* KPI Cards — 会话详情页隐藏 */}
            {!routeSessionId.value ? (
            <div className="fade-up fade-up-d2">
              <StatsToolbar />
            <div className="kpi-row">
              <KpiCard label="Sessions" value={kpiSessions} variant="blue" icon={<SessionsIcon />} />
              <KpiCard label="Turns" value={kpiTurns} variant="green" icon={<TurnsIcon />} />
              <KpiCard
                label="Total Tokens"
                value={kpiTokens}
                variant="orange"
                icon={<TokensIcon />}
              />
              <KpiCard label="Total Cost" value={kpiCost} variant="purple" icon={<CostIcon />} />
            </div>
            </div>
            ) : null}

            {/* ── Summary Tab ── */}
            {activeTab.value === 'summary' && !routeSessionId.value ? (
              <div className="summary-stack fade-up fade-up-d3">
                <div className="content-grid">
                  <div className="panel-card">
                    <SectionTitle title="Token 组成" subtitle="五类 Token 占比分布" />
                    <TokenBreakdownPanel />
                  </div>
                  <div className="panel-card">
                    <SectionTitle title="效率指标" subtitle="均值与缓存利用" />
                    <EfficiencyPanel />
                  </div>
                </div>

                <div className="panel-card panel-card--chart">
                  <SectionTitle title="每日趋势" subtitle="按日模型用量（叠加柱）" />
                  <DailyTrendPanel />
                </div>

                <div className="content-grid">
                  <div className="panel-card">
                    <SectionTitle title="Agent 分布" subtitle="按 Agent 聚合费用" />
                    <AgentBreakdownPanel />
                  </div>
                  <div className="panel-card">
                    <div className="flex items-center justify-between" style={{ marginBottom: '14px' }}>
                      <SectionTitle title="Top 模型" subtitle="费用 Top 5" />
                      <span className="panel-link" onClick={() => navigate('models')}>查看全部 →</span>
                    </div>
                    <TopModelsPanel />
                  </div>
                </div>

                <div className="session-table-panel session-table-panel--bleed panel-card">
                  <div className="session-table-head">
                    <SectionTitle title="高消耗会话" subtitle="最近会话费用 Top 5" />
                    <span className="panel-link" onClick={() => navigate('sessions')}>查看全部 →</span>
                  </div>
                  <TopSessionsPanel />
                </div>
              </div>
            ) : null}
          </main>
        </div>
      </div>
    )
  })
  return App
}
