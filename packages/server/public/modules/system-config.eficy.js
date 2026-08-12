import { component, computed, effect, signal } from 'eficy'

const CURSOR_CONFIG_ID = 'cursor-billing'

export function createSystemConfigPage(ctx) {
  const {
    apiFetch,
    selectedProviderId,
    activeTab,
    cursorStatus,
    cursorDialogOpen,
    providerDialogOpen,
    fetchCursorStatus,
    SectionTitle,
    Button,
    Input,
    Label,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } = ctx

  const providers = signal([])
  const models = signal([])
  const providerDraft = signal({
    name: 'DeepSeek',
    type: 'openai',
    base_url: 'https://api.deepseek.com',
    api_key: '',
    model: 'deepseek-chat',
    purpose: '默认总结与归档',
  })
  const providerSaving = signal(false)
  const providerTesting = signal(false)
  const providerMessage = signal('')
  const providerEditDraft = signal({
    id: '',
    name: '',
    type: 'openai',
    base_url: '',
    api_key: '',
  })
  const providerEditSaving = signal(false)
  const providerEditTesting = signal(false)
  const providerEditMessage = signal('')
  const modelDialogOpen = signal(false)
  const modelDraft = signal({
    provider_id: '',
    model: 'gpt-4.1',
    purpose: '默认总结与归档',
  })
  const modelSaving = signal(false)
  const modelDeletingId = signal('')
  const modelMessage = signal('')

  async function loadSystemConfig() {
    const data = await apiFetch('/v1/system-config').then((r) => r.json()).catch(() => ({ providers: [], models: [] }))
    providers.value = (data.providers || []).map((p) => ({
      ...p,
      baseUrl: p.base_url,
      keyState: p.key_state === 'configured' ? '已配置' : '未配置',
      statusLabel: p.status === 'available' ? '可用' : p.status,
    }))
    models.value = (data.models || []).map((m) => ({
      ...m,
      providerId: m.provider_id,
      enabled: !!m.enabled,
    }))
    if (!providers.value.find((p) => p.id === selectedProviderId.value) && providers.value[0]) {
      selectedProviderId.value = providers.value[0].id
    }
    syncProviderEditDraft()
  }

  function syncProviderEditDraft(provider = providerById(selectedProviderId.value)) {
    if (!provider?.id) return
    providerEditDraft.value = {
      id: provider.id,
      name: provider.name || '',
      type: provider.type || 'openai',
      base_url: provider.baseUrl || provider.base_url || '',
      api_key: '',
    }
    providerEditMessage.value = ''
  }

  function patchProviderEditDraft(patch) {
    providerEditDraft.value = { ...providerEditDraft.value, ...patch }
  }

  effect(() => {
    if (activeTab?.value !== 'system-config') return
    loadSystemConfig()
  })

  function providerById(id) {
    return providers.value.find((p) => p.id === id) || providers.value[0] || {}
  }

  function patchProviderDraft(patch) {
    providerDraft.value = { ...providerDraft.value, ...patch }
  }

  function patchModelDraft(patch) {
    modelDraft.value = { ...modelDraft.value, ...patch }
  }

  function openProviderDialog(prefill = {}) {
    providerDraft.value = {
      name: prefill.name || 'DeepSeek',
      type: prefill.type || 'openai',
      base_url: prefill.baseUrl || prefill.base_url || 'https://api.deepseek.com',
      api_key: '',
      model: prefill.model || 'deepseek-chat',
      purpose: prefill.purpose || '默认总结与归档',
    }
    providerMessage.value = ''
    providerDialogOpen.value = true
  }

  function openModelDialog(provider = selectedProvider.value) {
    modelDraft.value = {
      provider_id: provider.id || providers.value[0]?.id || '',
      model: 'gpt-4.1',
      purpose: '默认总结与归档',
    }
    modelMessage.value = ''
    modelDialogOpen.value = true
  }

  async function testProviderDraft() {
    const draft = providerDraft.value
    providerTesting.value = true
    providerMessage.value = ''
    try {
      const res = await apiFetch('/v1/system-config/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json().catch(() => ({}))
      providerMessage.value = data.ok ? '连接成功' : (data.message || '连接失败')
    } finally {
      providerTesting.value = false
    }
  }

  async function testProviderEdit() {
    const draft = providerEditDraft.value
    const provider = selectedProvider.value
    const modelForTest = models.value.find((m) => m.providerId === provider.id)?.model
    if (!modelForTest) {
      providerEditMessage.value = '请先添加至少一个模型后再测试连接'
      return
    }
    providerEditTesting.value = true
    providerEditMessage.value = ''
    try {
      const useStoredKey = !draft.api_key
      const url = useStoredKey
        ? '/v1/system-config/providers/' + encodeURIComponent(draft.id) + '/test'
        : '/v1/system-config/providers/test'
      const payload = {
        base_url: draft.base_url,
        model: modelForTest,
      }
      if (!useStoredKey) payload.api_key = draft.api_key
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      providerEditMessage.value = data.ok ? '连接成功' : (data.message || '连接失败')
    } finally {
      providerEditTesting.value = false
    }
  }

  async function saveProviderEdit() {
    const draft = providerEditDraft.value
    if (!draft.id || !draft.name || !draft.base_url) {
      providerEditMessage.value = '请填写 Provider Name 和 Base URL'
      return
    }
    providerEditSaving.value = true
    providerEditMessage.value = ''
    try {
      const body = {
        name: draft.name,
        type: draft.type,
        base_url: draft.base_url,
      }
      if (draft.api_key) body.api_key = draft.api_key
      const res = await apiFetch('/v1/system-config/providers/' + encodeURIComponent(draft.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        providerEditMessage.value = data.error || '保存失败'
        return
      }
      providerEditMessage.value = '已保存'
      await loadSystemConfig()
    } finally {
      providerEditSaving.value = false
    }
  }

  async function saveProviderDraft() {
    const draft = providerDraft.value
    providerSaving.value = true
    providerMessage.value = ''
    try {
      const res = await apiFetch('/v1/system-config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        providerMessage.value = data.error || '保存失败'
        return
      }
      providerDialogOpen.value = false
      if (data.providerId) selectedProviderId.value = data.providerId
      await loadSystemConfig()
    } finally {
      providerSaving.value = false
    }
  }

  async function saveModelDraft() {
    const draft = modelDraft.value
    modelSaving.value = true
    modelMessage.value = ''
    try {
      const res = await apiFetch('/v1/system-config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        modelMessage.value = data.error || '保存模型失败'
        return
      }
      modelDialogOpen.value = false
      selectedProviderId.value = draft.provider_id
      await loadSystemConfig()
    } finally {
      modelSaving.value = false
    }
  }

  async function deleteModel(model) {
    if (!model || !confirm(`删除模型 ${model.model}？`)) return
    modelDeletingId.value = model.id
    modelMessage.value = ''
    try {
      const res = await apiFetch('/v1/system-config/models/' + encodeURIComponent(model.id), { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        modelMessage.value = data.error || '删除模型失败'
        return
      }
      modelMessage.value = '模型已删除'
      await loadSystemConfig()
    } finally {
      modelDeletingId.value = ''
    }
  }

  const selectedProvider = computed(() => {
    return providerById(selectedProviderId.value)
  })

  const selectedConfigKind = computed(() => {
    return selectedProviderId.value === CURSOR_CONFIG_ID ? 'cursor' : 'provider'
  })

  const ConfigIcon = component(({ type }) => (
    <span className={'config-glyph config-glyph--' + (type || 'provider')}>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {type === 'model' ? (
          <>
            <rect width="16" height="16" x="4" y="4" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M15 2v2" />
            <path d="M9 2v2" />
          </>
        ) : type === 'key' ? (
          <>
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="M21 2l-9.6 9.6" />
            <path d="M15.5 7.5l3 3L22 7" />
          </>
        ) : (
          <>
            <path d="M12 2v20" />
            <path d="M2 12h20" />
            <circle cx="12" cy="12" r="9" />
          </>
        )}
      </svg>
    </span>
  ))

  const ProviderRow = component(({ provider }) => {
    const active = selectedConfigKind.value === 'provider' && selectedProviderId.value === provider.id
    return (
      <div
        className={'provider-config-row' + (active ? ' provider-config-row--active' : '')}
        onClick={() => { selectedProviderId.value = provider.id; syncProviderEditDraft(provider) }}
      >
        <div className="provider-config-main">
          <ConfigIcon type="provider" />
          <div className="provider-config-copy">
            <div className="provider-config-name">{provider.name}</div>
            <div className="provider-config-url">{provider.baseUrl}</div>
          </div>
        </div>
        <span className={'provider-config-state' + (provider.status === 'available' ? ' provider-config-state--ok' : '')}>{provider.statusLabel || provider.status}</span>
      </div>
    )
  })

  const CursorConfigRow = component(() => {
    const cursor = cursorStatus.value || {}
    const cursorReady = !!cursor.hasCookies && !!cursor.available
    const active = selectedConfigKind.value === 'cursor'
    const state = cursor.syncing ? '同步中' : (cursorReady ? '可用' : '待配置')
    return (
      <div
        className={'provider-config-row' + (active ? ' provider-config-row--active' : '')}
        onClick={() => { selectedProviderId.value = CURSOR_CONFIG_ID }}
      >
        <div className="provider-config-main">
          <ConfigIcon type="key" />
          <div className="provider-config-copy">
            <div className="provider-config-name">Cursor 账单同步</div>
            <div className="provider-config-url">cursor.com usage reconciliation</div>
          </div>
        </div>
        <span className={'provider-config-state' + (cursorReady ? ' provider-config-state--ok' : '')}>{state}</span>
      </div>
    )
  })

  const CursorConfigPanel = component(() => {
    const cursor = cursorStatus.value || {}
    const cursorReady = !!cursor.hasCookies && !!cursor.available
    const cursorState = cursor.syncing ? '同步中' : (cursorReady ? '可用' : '待配置')
    return (
      <section className="provider-editor panel-card">
        <div className="provider-editor-head">
          <div>
            <div className="agent-editor-kicker">Cursor</div>
            <h3>Cursor 账单同步</h3>
            <p>配置 Cursor Session Token 后，后台会拉取账单并对账到会话。</p>
          </div>
          <span className={'provider-config-state' + (cursorReady ? ' provider-config-state--ok' : '')}>{cursorState}</span>
        </div>

        <div className="cursor-config-panel cursor-config-panel--standalone">
          <div className="cursor-config-main">
            <ConfigIcon type="key" />
            <div>
              <div className="cursor-config-title">Session Token</div>
              <div className="cursor-config-sub">Token 只用于服务端代理拉取 Cursor usage events；前端不回显明文。</div>
            </div>
          </div>
          <div className="cursor-config-meta">
            <span className={'provider-config-state' + (cursor.hasCookies ? ' provider-config-state--ok' : '')}>{cursor.hasCookies ? '已配置' : '未配置'}</span>
            <button
              className="mock-action-btn"
              onClick={() => { cursorDialogOpen.value = true; fetchCursorStatus() }}
            >
              配置账单
            </button>
          </div>
        </div>

        <div className="model-list-panel">
          <div className="agent-block-head">
            <SectionTitle title="Sync Status" subtitle="Cursor 对账任务状态" />
            <button className="mock-action-btn mock-action-btn--sm" onClick={() => fetchCursorStatus()}>刷新状态</button>
          </div>
          <div className="cursor-status-grid">
            <span><b>{cursor.pendingQueue ?? 0}</b><small>Pending Queue</small></span>
            <span><b>{cursor.pendingEnrich ?? 0}</b><small>Pending Enrich</small></span>
            <span><b>{cursor.totalEvents ?? 0}</b><small>Usage Events</small></span>
            <span><b>{cursor.authExpired ? 'Yes' : 'No'}</b><small>Auth Expired</small></span>
          </div>
        </div>
      </section>
    )
  })

  const ProviderCreateDialog = component(() => (
    <Dialog open={providerDialogOpen.value} onOpenChange={(v) => { providerDialogOpen.value = v }}>
      <DialogContent style={{ maxWidth: '560px' }}>
        <DialogHeader>
          <DialogTitle>新增 Provider</DialogTitle>
          <DialogDescription>
            当前只开放 OpenAI Compatible 基础配置；保存后会进入系统 Model List，智能体配置页只选择模型。
          </DialogDescription>
        </DialogHeader>

        <div className="provider-create-dialog">
          <div className="provider-create-note">
            <ConfigIcon type="provider" />
            <span>Provider 作为底层资源统一维护，不在单个智能体页面暴露密钥和 Base URL。</span>
          </div>

          <div className="provider-modal-form provider-modal-form--two">
            <div className="mock-field">
              <Label>Provider Name</Label>
              <Input value={providerDraft.value.name} placeholder="DeepSeek" onInput={(e) => patchProviderDraft({ name: e.target.value })} />
            </div>
            <div className="mock-field">
              <Label>Type</Label>
              <select className="mock-select" value={providerDraft.value.type} onChange={(e) => patchProviderDraft({ type: e.target.value })}>
                <option value="openai">OpenAI Compatible</option>
              </select>
            </div>
            <div className="mock-field provider-modal-form-wide">
              <Label>Base URL</Label>
              <Input value={providerDraft.value.base_url} placeholder="https://api.deepseek.com" onInput={(e) => patchProviderDraft({ base_url: e.target.value })} />
            </div>
            <div className="mock-field provider-modal-form-wide">
              <Label>API Key</Label>
              <Input type="password" value={providerDraft.value.api_key} placeholder="ac:..." onInput={(e) => patchProviderDraft({ api_key: e.target.value })} />
            </div>
          </div>

          <div className="provider-modal-divider" />

          <div className="provider-modal-form provider-modal-form--two">
            <div className="mock-field">
              <Label>Default Model</Label>
              <Input value={providerDraft.value.model} placeholder="deepseek-chat" onInput={(e) => patchProviderDraft({ model: e.target.value })} />
            </div>
            <div className="mock-field">
              <Label>Alias</Label>
              <Input value={providerDraft.value.purpose} placeholder="默认总结与归档" onInput={(e) => patchProviderDraft({ purpose: e.target.value })} />
            </div>
          </div>
          {providerMessage.value ? <div className="provider-create-note"><ConfigIcon type="key" /><span>{providerMessage.value}</span></div> : null}
        </div>

        <DialogFooter style={{ gap: '8px', flexWrap: 'wrap' }}>
          <Button variant="outline" onClick={() => testProviderDraft()} disabled={providerTesting.value || providerSaving.value}>{providerTesting.value ? 'Testing…' : 'Test Connection'}</Button>
          <Button onClick={() => saveProviderDraft()} disabled={providerSaving.value || providerTesting.value}>{providerSaving.value ? '保存中…' : '保存 Provider'}</Button>
          <DialogClose asChild>
            <Button variant="ghost">关闭</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ))

  const ModelCreateDialog = component(() => (
    <Dialog open={modelDialogOpen.value} onOpenChange={(v) => { modelDialogOpen.value = v }}>
      <DialogContent style={{ maxWidth: '520px' }}>
        <DialogHeader>
          <DialogTitle>新增模型</DialogTitle>
          <DialogDescription>
            将模型添加到选定 Provider 下。智能体配置页只会从这里的 Model List 选择模型。
          </DialogDescription>
        </DialogHeader>

        <div className="provider-create-dialog">
          <div className="provider-create-note">
            <ConfigIcon type="model" />
            <span>模型会绑定到已有 Provider；Provider 的 Base URL 与 API Key 继续由系统配置统一维护。</span>
          </div>

          <div className="provider-modal-form">
            <div className="mock-field">
              <Label>Provider</Label>
              <select className="mock-select" value={modelDraft.value.provider_id} onChange={(e) => patchModelDraft({ provider_id: e.target.value })}>
                {providers.value.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="mock-field">
              <Label>Model Name</Label>
              <Input value={modelDraft.value.model} placeholder="gpt-4.1" onInput={(e) => patchModelDraft({ model: e.target.value })} />
            </div>
            <div className="mock-field">
              <Label>用途</Label>
              <Input value={modelDraft.value.purpose} placeholder="默认总结与归档" onInput={(e) => patchModelDraft({ purpose: e.target.value })} />
            </div>
          </div>
          {modelMessage.value ? <div className="provider-create-note"><ConfigIcon type="key" /><span>{modelMessage.value}</span></div> : null}
        </div>

        <DialogFooter style={{ gap: '8px', flexWrap: 'wrap' }}>
          <Button onClick={() => saveModelDraft()} disabled={modelSaving.value || !modelDraft.value.provider_id}>{modelSaving.value ? '保存中…' : '保存模型'}</Button>
          <DialogClose asChild>
            <Button variant="ghost">关闭</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ))

  const SystemConfigPage = component(() => {
    const provider = selectedProvider.value
    const providerModels = models.value.filter((m) => m.providerId === provider.id)
    return (
      <div className="mock-page fade-up">
        <div className="mock-page-head">
          <h2 className="mock-title">系统配置</h2>
          <div className="mock-head-actions">
            <button
              className="mock-action-btn"
              onClick={() => openProviderDialog()}
            >
              新增 Provider
            </button>
            <button className="mock-action-btn" onClick={() => loadSystemConfig()}>刷新</button>
          </div>
        </div>

        <div className="system-config-layout">
          <aside className="provider-list-panel panel-card">
            <div className="compact-list-head">
              <span>系统配置</span>
              <small>{providers.value.length + 1}</small>
            </div>
            <div className="system-config-group-label">Providers</div>
            {providers.value.map((p) => <ProviderRow key={p.id} provider={p} />)}
            <div className="system-config-group-label">Integrations</div>
            <CursorConfigRow />
          </aside>

          {selectedConfigKind.value === 'cursor' ? <CursorConfigPanel /> : (
          <section className="provider-editor panel-card">
            <div className="provider-editor-head">
              <div>
                <div className="agent-editor-kicker">Provider</div>
                <h3>{provider.name || 'Provider'}</h3>
                <p>当前只设计 OpenAI 基础配置，后续可以在这里扩展更多 Provider 类型。</p>
              </div>
              <span className={'provider-config-state' + (provider.status === 'available' ? ' provider-config-state--ok' : '')}>{provider.statusLabel || provider.status}</span>
            </div>

            <div className="system-form-grid">
              <div className="mock-field">
                <Label>Provider Name</Label>
                <Input value={providerEditDraft.value.name} placeholder="DeepSeek" onInput={(e) => patchProviderEditDraft({ name: e.target.value })} />
              </div>
              <div className="mock-field">
                <Label>Type</Label>
                <select className="mock-select" value={providerEditDraft.value.type} onChange={(e) => patchProviderEditDraft({ type: e.target.value })}>
                  <option value="openai">OpenAI Compatible</option>
                </select>
              </div>
              <div className="mock-field system-form-wide">
                <Label>Base URL</Label>
                <Input value={providerEditDraft.value.base_url} placeholder="https://api.deepseek.com" onInput={(e) => patchProviderEditDraft({ base_url: e.target.value })} />
              </div>
              <div className="mock-field system-form-wide">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={providerEditDraft.value.api_key}
                  placeholder={provider.keyState === '已配置' ? '已配置，留空则不修改' : '未配置，请输入 API Key'}
                  onInput={(e) => patchProviderEditDraft({ api_key: e.target.value })}
                />
              </div>
            </div>

            <div className="system-action-row">
              <span><ConfigIcon type="key" />密钥只在系统配置维护，智能体配置不会直接展示 Provider。</span>
              <div className="mock-head-actions">
                <button className="mock-action-btn" onClick={() => syncProviderEditDraft()} disabled={providerEditSaving.value || providerEditTesting.value}>重置</button>
                <button className="mock-action-btn" onClick={() => testProviderEdit()} disabled={providerEditTesting.value || providerEditSaving.value}>{providerEditTesting.value ? '测试中…' : 'Test Connection'}</button>
                <button className="mock-action-btn mock-action-btn--primary" onClick={() => saveProviderEdit()} disabled={providerEditSaving.value || providerEditTesting.value}>{providerEditSaving.value ? '保存中…' : '保存 Provider'}</button>
              </div>
            </div>
            {providerEditMessage.value ? <div className="provider-create-note"><ConfigIcon type="key" /><span>{providerEditMessage.value}</span></div> : null}

            <div className="model-list-panel">
              <div className="agent-block-head">
                <SectionTitle title="Model List" subtitle="智能体页面可选择的模型" />
                <button className="mock-action-btn mock-action-btn--sm" onClick={() => openModelDialog(provider)}>新增模型</button>
              </div>
              <div className="model-config-header">
                <span>模型</span>
                <span>用途</span>
                <span>Provider</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {providerModels.map((m) => (
                <div key={m.id} className="model-config-row">
                  <span><ConfigIcon type="model" />{m.model}</span>
                  <span>{m.purpose}</span>
                  <span>{provider.name}</span>
                  <span className={m.enabled ? 'provider-config-state provider-config-state--ok' : 'provider-config-state'}>{m.enabled ? '启用' : '停用'}</span>
                  <span className="model-config-actions">
                    <button className="mock-action-btn mock-action-btn--sm mock-action-btn--danger" disabled={modelDeletingId.value === m.id} onClick={() => deleteModel(m)}>
                      {modelDeletingId.value === m.id ? '删除中' : '删除'}
                    </button>
                  </span>
                </div>
              ))}
              {providerModels.length ? null : <div className="empty-state">当前 Provider 还没有模型。</div>}
              {modelMessage.value ? <div className="model-list-message">{modelMessage.value}</div> : null}
            </div>
          </section>
          )}
        </div>
        <ProviderCreateDialog />
        <ModelCreateDialog />
      </div>
    )
  })

  return SystemConfigPage
}
