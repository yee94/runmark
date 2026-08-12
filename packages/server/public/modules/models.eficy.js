import { component, computed } from 'eficy'

export function createModelRow(ctx) {
  const { formatTokens, formatCost, formatDuration, resolveModelIconUrl } = ctx

  const ModelRow = component(({ item }) => {
    const modelName = computed(() => item.value.model || '—')
    const provider = computed(() => item.value.provider || '—')
    const turnCount = computed(() => item.value.turn_count?.toLocaleString() ?? '0')
    const inputTokens = computed(() => formatTokens(item.value.input_tokens))
    const outputTokens = computed(() => formatTokens(item.value.output_tokens))
    const totalTokens = computed(() => formatTokens(item.value.total_tokens))
    const totalCost = computed(() => formatCost(item.value.total_cost_cny))
    const avgDuration = computed(() => formatDuration(item.value.avg_duration_ms))
    return (
      <div className="list-row">
        <div style={{ flex: 2, minWidth: 0 }}>
          <div className="flex items-center gap-2">
            <img src={resolveModelIconUrl(item.value.model, item.value.provider)} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'contain', flexShrink: 0 }} onError={(e) => { e.target.src = '/model-icons/unknown.svg' }} />
            <span style={{ fontWeight: 600, fontSize: '13px' }}>{modelName}</span>
            <span className="badge badge-provider">{provider}</span>
          </div>
        </div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px' }}>{turnCount}</div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px', color: 'var(--brand-blue)' }}>{inputTokens}</div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px', color: 'var(--brand-green)' }}>{outputTokens}</div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px' }}>{totalTokens}</div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px', fontWeight: 600 }}>{totalCost}</div>
        <div className="digits" style={{ flex: 1, textAlign: 'right', fontSize: '13px', color: 'var(--text-secondary)' }}>{avgDuration}</div>
      </div>
    )
  })

  return ModelRow
}

export function createModelsPage(ctx) {
  const { byModel, signal, ModelRow, SectionTitle, EmptyState } = ctx

  const ModelsPage = component(() => (
    <div className="panel-card fade-up">
      <div className="flex items-center justify-between" style={{ marginBottom: '14px' }}>
        <SectionTitle title="模型统计" subtitle="Token 用量与费用明细" />
        <span className="count-chip">{byModel.value.length + ' models'}</span>
      </div>
      {byModel.value.length === 0
        ? <EmptyState message="暂无模型数据" />
        : <>
            <div className="list-header">
              <div style={{ flex: 2 }}>Model</div>
              <div style={{ flex: 1, textAlign: 'right' }}>Turns</div>
              <div style={{ flex: 1, textAlign: 'right' }}>In</div>
              <div style={{ flex: 1, textAlign: 'right' }}>Out</div>
              <div style={{ flex: 1, textAlign: 'right' }}>Total</div>
              <div style={{ flex: 1, textAlign: 'right' }}>Cost</div>
              <div style={{ flex: 1, textAlign: 'right' }}>Avg</div>
            </div>
            {byModel.value.map((m, i) => (
              <ModelRow key={i} item={signal(m)} />
            ))}
          </>
      }
    </div>
  ))

  return ModelsPage
}
