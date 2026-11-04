import { component, computed } from 'eficy'

export function createModelRow(ctx) {
  const { formatTokens, formatCost, formatDuration, resolveModelIconUrl, ChevronIcon } = ctx

  const ModelRow = component(({ item }) => {
    const modelName = computed(() => item.value.model || '—')
    const sources = computed(() => Array.isArray(item.value.sources) ? item.value.sources : [item.value])
    const channelCount = computed(() => new Set(sources.value.map((source) => source.provider)).size)
    const turnCount = computed(() => item.value.turn_count?.toLocaleString() ?? '0')
    const inputTokens = computed(() => formatTokens(item.value.input_tokens))
    const outputTokens = computed(() => formatTokens(item.value.output_tokens))
    const totalTokens = computed(() => formatTokens(item.value.total_tokens))
    const totalCost = computed(() => formatCost(item.value.total_cost_cny))
    const avgDuration = computed(() => formatDuration(item.value.avg_duration_ms))
    return (
      <details className="model-stat-row">
        <summary className="model-stat-grid model-stat-summary">
          <div className="model-stat-identity">
            <span className="model-stat-chevron" aria-hidden="true"><ChevronIcon direction="right" /></span>
            <img src={resolveModelIconUrl(item.value.model, item.value.provider)} alt="" className="agent-label-icon" onError={(e) => { e.target.src = '/model-icons/unknown.svg' }} />
            <span className="session-summary-text" title={modelName}>{modelName}</span>
            <span className="count-chip model-stat-channels">{channelCount} 渠道</span>
          </div>
          <div className="session-number-col digits">{turnCount}</div>
          <div className="session-number-col digits" style={{ color: 'var(--brand-blue)' }}>{inputTokens}</div>
          <div className="session-number-col digits" style={{ color: 'var(--brand-green)' }}>{outputTokens}</div>
          <div className="session-number-col digits">{totalTokens}</div>
          <div className="session-number-col session-cost-col digits">{totalCost}</div>
          <div className="session-number-col session-muted-col digits">{avgDuration}</div>
        </summary>
        <div className="model-stat-sources">
          {sources.value.map((source) => (
            <div key={(source.provider || '') + '/' + source.model} className="model-stat-grid model-stat-source">
              <div className="model-stat-source-label">
                <span className="badge badge-provider model-stat-provider" title={source.provider}>{source.provider || 'unknown'}</span>
                <span className="model-stat-source-model" title={source.model}>{source.model}</span>
              </div>
              <span className="session-number-col digits">{source.turn_count?.toLocaleString() || '0'}</span>
              <span className="session-number-col digits">{formatTokens(source.input_tokens)}</span>
              <span className="session-number-col digits">{formatTokens(source.output_tokens)}</span>
              <span className="session-number-col digits">{formatTokens(source.total_tokens)}</span>
              <span className="session-number-col digits">{formatCost(source.total_cost_cny)}</span>
              <span className="session-number-col digits">{formatDuration(source.avg_duration_ms)}</span>
            </div>
          ))}
        </div>
      </details>
    )
  })

  return ModelRow
}

export function createModelsPage(ctx) {
  const { byModel, signal, ModelRow, SectionTitle, EmptyState } = ctx

  const ModelsPage = component(() => (
    <div className="session-table-panel panel-card fade-up">
      <div className="session-table-head">
        <SectionTitle title="模型统计" subtitle="跨渠道汇总 · 展开查看来源明细" />
        <span className="count-chip">{byModel.value.length + ' models'}</span>
      </div>
      {byModel.value.length === 0
        ? <EmptyState message="暂无模型数据" />
        : <div className="model-stats-scroll"><div className="model-stats-table">
            <div className="session-header model-stat-grid">
              <div>Model</div>
              <div style={{ textAlign: 'right' }}>Turns</div>
              <div style={{ textAlign: 'right' }}>In</div>
              <div style={{ textAlign: 'right' }}>Out</div>
              <div style={{ textAlign: 'right' }}>Total</div>
              <div style={{ textAlign: 'right' }}>Cost</div>
              <div style={{ textAlign: 'right' }}>Avg</div>
            </div>
            {byModel.value.map((m, i) => (
              <ModelRow key={m.model || i} item={signal(m)} />
            ))}
          </div></div>
      }
    </div>
  ))

  return ModelsPage
}
