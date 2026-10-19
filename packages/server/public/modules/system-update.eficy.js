import { component, signal, computed, peek, batch } from 'eficy'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

// ─── 更新状态机 ───
// 前端阶段（含后端 phase 的超集）：
//   idle → checking → up_to_date / update_available / disabled / check_failed
//   update_available → downloading → verifying → installing → backing_up
//                    → restarting → health_check → success / failed
//                    → rolling_back → rolled_back
//
// 后端 phase canonical 值（GET /v1/system-update/status 的 phase 字段）：
//   idle / downloading / verifying / installing / backing_up
//   restarting / health_check / completed / failed / rolling_back / rolled_back
//
// completed → 前端映射为 success

/** 后端 active phase 集合（这些 phase 表示更新正在进行，需要轮询） */
const BACKEND_ACTIVE_PHASES = new Set([
  'downloading', 'verifying', 'installing', 'backing_up',
  'restarting', 'health_check', 'rolling_back',
])

/** 将后端 phase 字段映射到前端阶段 */
function mapBackendPhase(phase) {
  const map = {
    idle:         'idle',
    downloading:  'downloading',
    verifying:    'verifying',
    installing:   'installing',
    backing_up:   'backing_up',
    restarting:   'restarting',
    health_check: 'health_check',
    completed:    'success',      // completed → success
    failed:       'failed',
    rolling_back: 'rolling_back',
    rolled_back:  'rolled_back',
  }
  return map[phase] || 'idle'
}

// 实际 updater 执行顺序：downloading → verifying → installing → backing_up → restarting → health_check
// 进度值单调递增，与执行顺序对齐
/** 阶段文案与进度映射 */
const UPDATE_PHASES = {
  idle:            { label: '',                  progress: 0,   color: 'neutral' },
  checking:        { label: '检查更新…',         progress: 5,   color: 'blue'    },
  up_to_date:      { label: '已是最新',          progress: 100, color: 'green'   },
  update_available:{ label: '有新版本',          progress: 0,   color: 'orange'  },
  disabled:        { label: '自动更新未启用',    progress: 0,   color: 'muted'   },
  check_failed:    { label: '检查失败',          progress: 0,   color: 'red'     },
  downloading:     { label: '下载中…',           progress: 20,  color: 'blue'    },
  verifying:       { label: '校验中…',           progress: 40,  color: 'blue'    },
  installing:      { label: '安装中…',           progress: 60,  color: 'blue'    },
  backing_up:      { label: '备份数据…',         progress: 75,  color: 'blue'    },
  restarting:      { label: '重启中…',           progress: 85,  color: 'blue'    },
  health_check:    { label: '健康检查…',         progress: 93,  color: 'blue'    },
  rolling_back:    { label: '正在回滚…',         progress: 50,  color: 'orange'  },
  success:         { label: '更新成功',          progress: 100, color: 'green'   },
  failed:          { label: '更新失败',          progress: 0,   color: 'red'     },
  rolled_back:     { label: '已回滚，服务已恢复', progress: 0,  color: 'red'     },
}

/** 前端"进行中"阶段集合（Dialog 不可关闭；rolling_back 也不可关闭） */
const FRONTEND_ACTIVE_PHASES = new Set([
  'downloading', 'verifying', 'installing', 'backing_up',
  'restarting', 'health_check', 'rolling_back',
])

/** 格式化字节数为可读大小 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** 格式化 ISO 日期为简短展示 */
function formatPublishedAt(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return diffDays + ' 天前'
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear()
}

/** 从 check / status 响应中解析目标版本（优先级：status.version > check.currentPhaseVersion > latest.version） */
function resolveTargetVersion(statusData, checkData) {
  return statusData?.version
    || checkData?.currentPhaseVersion
    || checkData?.latest?.version
    || null
}

export function createSystemUpdateModule(ctx) {
  const { apiFetch } = ctx

  // ─── 状态 ───
  const updatePhase = signal('idle')          // 前端阶段
  const updateDialogOpen = signal(false)      // Dialog 开关
  const checkData = signal(null)              // GET /v1/system-update/check 响应
  const statusData = signal(null)             // GET /v1/system-update/status 响应
  const updateError = signal('')              // 错误文案
  const updateLog = signal([])               // 阶段日志行
  const pollTimer = signal(null)             // 轮询定时器 id
  const targetVersion = signal(null)         // 本次更新目标版本
  const lastLoggedPhase = signal(null)       // 上次已记录日志的 phase（避免重复追加）

  // ─── 衍生 ───
  const currentVersion = computed(() => checkData.value?.currentVersion || null)
  // latest 是平面字段：{ version, publishedAt, notes, artifactUrl, sha256, size }
  const latestInfo = computed(() => checkData.value?.latest || null)
  const isUpdateAvailable = computed(() => !!checkData.value?.available)
  const isEnabled = computed(() => checkData.value?.enabled !== false)
  // isInProgress：包含 rolling_back，Dialog 不可关闭
  const isInProgress = computed(() => FRONTEND_ACTIVE_PHASES.has(updatePhase.value))
  const phaseInfo = computed(() => UPDATE_PHASES[updatePhase.value] || UPDATE_PHASES.idle)

  // ─── 日志追加（只在 phase 变化时调用，避免每 2s 重复） ───
  function appendLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    updateLog.value = [...peek(updateLog), { time, msg }]
  }

  /** 仅在 phase 首次出现时追加日志 */
  function appendLogOnPhaseChange(phase, msg) {
    if (peek(lastLoggedPhase) === phase) return
    lastLoggedPhase.value = phase
    appendLog(msg)
  }

  // ─── 停止轮询 ───
  function stopPoll() {
    const t = peek(pollTimer)
    if (t) {
      clearInterval(t)
      pollTimer.value = null
    }
  }

  // ─── 轮询 status + health，等待更新完成 ───
  // target：目标版本号，用于 /health version 命中判断
  async function pollUntilReady(target) {
    stopPoll()
    let attempts = 0
    const MAX_ATTEMPTS = 90  // 最多等 3 分钟（2s 间隔）

    const tick = async () => {
      attempts++
      if (attempts > MAX_ATTEMPTS) {
        stopPoll()
        batch(() => {
          updatePhase.value = 'failed'
          updateError.value = '等待服务重启超时，请手动刷新页面确认版本'
        })
        appendLog('等待超时，请手动刷新')
        return
      }

      try {
        // 优先拉 status（phase 字段）
        const statusRes = await apiFetch('/v1/system-update/status').catch(() => null)
        const status = statusRes?.ok ? await statusRes.json().catch(() => null) : null
        const backendPhase = status?.phase || null

        // ── 终止：completed ──
        if (backendPhase === 'completed') {
          stopPoll()
          batch(() => {
            updatePhase.value = 'success'
            statusData.value = status
          })
          appendLog('✓ 更新完成，版本 ' + (status?.version || target || ''))
          setTimeout(() => checkUpdateSilent(), 1500)
          return
        }

        // ── 终止：failed ──
        if (backendPhase === 'failed') {
          stopPoll()
          batch(() => {
            updatePhase.value = 'failed'
            updateError.value = status?.error || '更新失败'
            statusData.value = status
          })
          appendLog('✗ ' + (status?.error || '更新失败'))
          return
        }

        // ── 终止：rolled_back ──
        if (backendPhase === 'rolled_back') {
          stopPoll()
          batch(() => {
            updatePhase.value = 'rolled_back'
            updateError.value = status?.error || '更新失败，服务已自动回滚并恢复正常运行'
            statusData.value = status
          })
          appendLog('↩ 已回滚，服务已恢复')
          return
        }

        // ── 进行中：同步前端阶段，只在 phase 变化时记日志 ──
        if (backendPhase && BACKEND_ACTIVE_PHASES.has(backendPhase)) {
          attempts = 0
          const frontPhase = mapBackendPhase(backendPhase)
          if (peek(updatePhase) !== frontPhase) {
            updatePhase.value = frontPhase
          }
          appendLogOnPhaseChange(backendPhase, UPDATE_PHASES[frontPhase]?.label || backendPhase)
          return
        }

        // ── status 不可用（服务重启中）：尝试 /health 兜底 ──
        const healthRes = await fetch('/health', { cache: 'no-store' }).catch(() => null)
        if (!healthRes?.ok) {
          // 服务重启中，保持 restarting 阶段，只记一次
          if (peek(updatePhase) !== 'restarting') {
            updatePhase.value = 'restarting'
          }
          appendLogOnPhaseChange('restarting', '重启中，等待服务恢复…')
          return
        }

        const health = await healthRes.json().catch(() => ({}))
        const newVer = health.version || null

        // /health 版本命中目标 → 成功
        if (target && newVer && newVer === target) {
          stopPoll()
          batch(() => {
            updatePhase.value = 'success'
          })
          appendLog('✓ 更新成功，当前版本 ' + newVer)
          setTimeout(() => checkUpdateSilent(), 1500)
          return
        }

        // health 正常但 status 是 idle（更新已完成但 status 已清空）
        if (backendPhase === 'idle' || !backendPhase) {
          if (newVer && target && newVer !== target) {
            // 版本不符，可能是回滚后的旧版本，等待更多信息
            appendLogOnPhaseChange('idle_mismatch', '服务已恢复，版本核对中…')
            return
          }
          // 无法判断，继续等待
        }
      } catch {
        // 服务重启中，请求失败属正常，保持当前阶段
        appendLogOnPhaseChange('net_error', '网络中断，等待服务恢复…')
      }
    }

    const timer = setInterval(tick, 2000)
    pollTimer.value = timer
    // 立即执行一次
    tick()
  }

  // ─── 静默检查（成功后刷新 checkData，并把 success 落到 up_to_date） ───
  async function checkUpdateSilent() {
    try {
      const res = await apiFetch('/v1/system-update/check')
      if (!res.ok) return
      const data = await res.json()
      checkData.value = data

      // 进行中不打断；失败/回滚由用户手动「重新检查」
      // success 允许退出：否则侧栏「更新成功」按钮会常驻
      const cur = peek(updatePhase)
      if (FRONTEND_ACTIVE_PHASES.has(cur) || cur === 'failed' || cur === 'rolled_back') return

      // configError / currentPhaseError 优先：不能误切 up_to_date
      // success 后仍应落到正常态，避免按钮常驻
      if ((data.configError || data.currentPhaseError) && cur !== 'success') return

      if (!data.enabled) {
        updatePhase.value = 'disabled'
      } else if (data.available) {
        updatePhase.value = 'update_available'
      } else {
        updatePhase.value = 'up_to_date'
      }
    } catch {
      // 静默失败
    }
  }

  // ─── 初次检查（页面加载后异步触发，不阻塞主数据） ───
  // 优先级：disabled → 拉 status 解析 backendPhase → active/failed/rolled_back
  //         → configError → available/up_to_date（completed 历史态也走这里）
  async function initialCheck() {
    updatePhase.value = 'checking'
    try {
      const res = await apiFetch('/v1/system-update/check')
      if (!res.ok) {
        batch(() => {
          updatePhase.value = 'check_failed'
          updateError.value = '检查更新失败（HTTP ' + res.status + '）'
        })
        return
      }
      const data = await res.json()
      checkData.value = data

      // ① disabled：正常显示当前版本，不报错
      if (!data.enabled) {
        updatePhase.value = 'disabled'
        return
      }

      // ② 拉 status，获取精确 backendPhase（优先于 check 的 currentPhase）
      const statusRes = await apiFetch('/v1/system-update/status').catch(() => null)
      const status = statusRes?.ok ? await statusRes.json().catch(() => null) : null
      statusData.value = status

      const backendPhase = status?.phase || data.currentPhase || null

      // ③ active phase → 恢复轮询
      if (backendPhase && BACKEND_ACTIVE_PHASES.has(backendPhase)) {
        const frontPhase = mapBackendPhase(backendPhase)
        const target = resolveTargetVersion(status, data)
        batch(() => {
          updatePhase.value = frontPhase
          if (target) targetVersion.value = target
        })
        appendLog('检测到进行中的更新（' + (UPDATE_PHASES[frontPhase]?.label || backendPhase) + '），继续监控…')
        pollUntilReady(target)
        return
      }

      // ④ completed：历史完成态（state 文件会长期保留），不当作需展示的终态
      //    继续走 available / up_to_date，避免刷新后侧栏「更新成功」常驻
      // ⑤ failed → 展示真实终态（status.error 优先，再取 check 字段）
      if (backendPhase === 'failed') {
        batch(() => {
          updatePhase.value = 'failed'
          updateError.value = status?.error || data.currentPhaseError || '上次更新失败'
        })
        return
      }

      // ⑥ rolled_back → 展示真实终态
      if (backendPhase === 'rolled_back') {
        batch(() => {
          updatePhase.value = 'rolled_back'
          updateError.value = status?.error || data.currentPhaseError || '上次更新失败，服务已自动回滚并恢复正常运行'
        })
        return
      }

      // ⑦ configError / currentPhaseError → check_failed（在 available/up_to_date 之前处理）
      //    completed 历史态下的 currentPhaseError 忽略（那是旧错误残留）
      const configErr = data.configError
        || (backendPhase !== 'completed' ? data.currentPhaseError : null)
      if (configErr) {
        batch(() => {
          updatePhase.value = 'check_failed'
          updateError.value = configErr
        })
        return
      }

      // ⑧ 正常：有无更新（含 backendPhase === completed 的历史完成态）
      if (data.available) {
        updatePhase.value = 'update_available'
      } else {
        updatePhase.value = 'up_to_date'
      }
    } catch {
      batch(() => {
        updatePhase.value = 'check_failed'
        updateError.value = '网络错误，无法检查更新'
      })
    }
  }

  // ─── 用户点击「立即更新」 ───
  async function startUpdate() {
    const latest = peek(latestInfo)
    if (!latest?.version) return

    batch(() => {
      updatePhase.value = 'downloading'
      updateError.value = ''
      updateLog.value = []
      lastLoggedPhase.value = null
      targetVersion.value = latest.version
    })
    appendLog('开始更新到 v' + latest.version + '…')

    try {
      const res = await apiFetch('/v1/system-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: latest.version }),
      })

      if (res.status === 202) {
        appendLog('服务端已接受更新请求，等待执行…')
        pollUntilReady(latest.version)
        return
      }

      // 非 202 视为启动失败，直接展示错误，不进入轮询
      const body = await res.json().catch(() => ({}))
      batch(() => {
        updatePhase.value = 'failed'
        updateError.value = body.error || body.message || '启动更新失败（HTTP ' + res.status + '）'
      })
      appendLog('✗ ' + (body.error || '启动失败（HTTP ' + res.status + '）'))
    } catch {
      // POST 网络异常：显示明确错误，做一次 status 探测
      batch(() => {
        updatePhase.value = 'failed'
        updateError.value = '更新请求失败，请重新检查服务状态'
      })
      appendLog('✗ 更新请求失败，正在探测服务状态…')

      // 做一次 status 探测：若发现 active phase 才进入轮询，避免无条件等待
      try {
        const statusRes = await apiFetch('/v1/system-update/status').catch(() => null)
        const status = statusRes?.ok ? await statusRes.json().catch(() => null) : null
        const backendPhase = status?.phase || null

        if (backendPhase && BACKEND_ACTIVE_PHASES.has(backendPhase)) {
          // 服务端已在执行更新，接管轮询
          const frontPhase = mapBackendPhase(backendPhase)
          batch(() => {
            updatePhase.value = frontPhase
            updateError.value = ''
          })
          appendLog('探测到服务端正在执行更新，继续监控…')
          pollUntilReady(latest.version)
        } else {
          // 未发现 active phase，保持 failed 状态，不进入轮询
          appendLog('服务状态正常，未检测到进行中的更新')
        }
      } catch {
        // 探测也失败，保持 failed 状态
        appendLog('服务状态探测失败，请手动刷新页面')
      }
    }
  }

  // ─── 关闭 Dialog（进行中 / rolling_back 时不允许关闭） ───
  function closeDialog() {
    if (peek(isInProgress)) return
    updateDialogOpen.value = false
  }

  // ─── 打开 Dialog ───
  function openDialog() {
    updateDialogOpen.value = true
  }

  // ─── 重置到初始状态（成功/失败后可重新检查） ───
  function resetUpdate() {
    stopPoll()
    batch(() => {
      updatePhase.value = 'checking'
      updateError.value = ''
      updateLog.value = []
      targetVersion.value = null
      lastLoggedPhase.value = null
    })
    initialCheck()
  }

  // ─── 侧栏更新入口 ───
  const SidebarUpdateButton = component(() => {
    const phase = updatePhase.value
    const info = phaseInfo.value

    if (!isUpdateAvailable.value && !FRONTEND_ACTIVE_PHASES.has(phase) && phase !== 'success' && phase !== 'failed' && phase !== 'rolled_back') return null

    const latest = latestInfo.value
    const stateClass = FRONTEND_ACTIVE_PHASES.has(phase) ? ' update-sidebar-button--progress'
      : phase === 'success' ? ' update-sidebar-button--success'
      : phase === 'failed' || phase === 'rolled_back' ? ' update-sidebar-button--error'
      : ''
    const title = phase === 'update_available' ? '发现新版本 v' + (latest?.version || '')
      : phase === 'success' ? '更新成功'
      : phase === 'failed' || phase === 'rolled_back' ? (updateError.value || info.label)
      : info.label

    return (
      <button className={'update-sidebar-button' + stateClass} onClick={() => openDialog()} title={title} aria-label={title}>
        {FRONTEND_ACTIVE_PHASES.has(phase) ? <span className="update-sidebar-spinner" /> : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2h14v-2" />
          </svg>
        )}
        {phase === 'update_available' ? <span className="update-sidebar-dot" /> : null}
      </button>
    )
  })

  // ─── 更新 Dialog 主体 ───
  const UpdateDialog = component(() => {
    const {
      Dialog, DialogContent, DialogHeader, DialogTitle,
      DialogDescription, DialogFooter, DialogClose, Button,
    } = ctx.shadcnUi
    const phase = updatePhase.value
    const latest = latestInfo.value
    const curVer = currentVersion.value
    const info = phaseInfo.value
    const inProgress = isInProgress.value
    const logs = updateLog.value
    const err = updateError.value
    const notesHtml = latest?.notes ? marked.parse(latest.notes) : ''

    // latest 是平面字段：size 直接读 latest.size
    const artifactSize = latest?.size ? formatBytes(latest.size) : null
    const publishedAt = latest?.publishedAt ? formatPublishedAt(latest.publishedAt) : null

    // 进度条宽度
    const progressWidth = info.progress + '%'

    return (
      <Dialog open={updateDialogOpen.value} onOpenChange={(v) => { if (!inProgress) updateDialogOpen.value = v }}>
        <DialogContent style={{ maxWidth: '540px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <DialogHeader>
            <DialogTitle style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>系统更新</span>
              {phase !== 'idle' && phase !== 'checking' ? (
                <span className={'update-dialog-phase-badge update-dialog-phase-badge--' + info.color}>
                  {info.label}
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>

          {/* 版本对比行 */}
          <div className="update-version-row">
            <div className="update-version-cell">
              <div className="update-version-cell-label">当前版本</div>
              <div className="update-version-cell-val">{curVer ? 'v' + curVer : '—'}</div>
              <div className="update-version-cell-meta" aria-hidden="true">&nbsp;</div>
            </div>
            {latest ? (
              <>
                <div className="update-version-arrow" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </div>
                <div className="update-version-cell update-version-cell--new">
                  <div className="update-version-cell-label">最新版本</div>
                  <div className="update-version-cell-val">v{latest.version}</div>
                  <div className="update-version-cell-meta">
                    {publishedAt ? <span>{publishedAt}</span> : null}
                    {artifactSize ? <span>· {artifactSize}</span> : null}
                  </div>
                </div>
              </>
            ) : null}
          </div>

          {/* 进度条（进行中 / 成功时显示） */}
          {inProgress || phase === 'success' ? (
            <div className="update-progress-wrap">
              <div className="update-progress-track">
                <div
                  className={'update-progress-fill' + (inProgress ? ' update-progress-fill--animated' : '')}
                  style={{ width: progressWidth }}
                />
              </div>
              <div className="update-progress-label">{info.label}</div>
            </div>
          ) : null}

          {/* 错误提示 */}
          {err && (phase === 'failed' || phase === 'rolled_back' || phase === 'check_failed') ? (
            <div className={'update-error-box' + (phase === 'rolled_back' ? ' update-error-box--warn' : '')}>
              <span className="update-error-icon">{phase === 'rolled_back' ? '↩' : '✗'}</span>
              <span>{err}</span>
            </div>
          ) : null}

          {/* rolled_back 额外说明：服务已恢复 */}
          {phase === 'rolled_back' ? (
            <div className="update-rollback-notice">
              <span className="update-rollback-notice-icon">✓</span>
              <span>服务已恢复正常运行，当前版本 {curVer ? 'v' + curVer : '未知'}</span>
            </div>
          ) : null}

          {/* CHANGELOG notes（非进行中时显示） */}
          {latest?.notes && !inProgress ? (
            <div className="update-notes-wrap">
              <div className="update-notes-label">更新内容</div>
              <div className="update-notes-scroll">
                <div className="markdown-body update-notes-markdown" dangerouslySetInnerHTML={{ __html: notesHtml }} />
              </div>
            </div>
          ) : null}

          {/* 操作日志（进行中 / 完成后显示） */}
          {logs.length > 0 ? (
            <div className="update-log-wrap">
              <div className="update-log-label">操作日志</div>
              <div className="update-log-scroll" id="update-log-scroll">
                {logs.map((entry, i) => (
                  <div key={i} className="update-log-line">
                    <span className="update-log-time">{entry.time}</span>
                    <span className="update-log-msg">{entry.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <DialogFooter style={{ gap: '8px', flexWrap: 'wrap', marginTop: 'auto' }}>
            {phase === 'success' ? (
              <>
                <Button onClick={() => { updateDialogOpen.value = false; location.reload() }}>
                  刷新页面
                </Button>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
              </>
            ) : phase === 'failed' || phase === 'rolled_back' ? (
              <>
                <Button variant="outline" onClick={() => resetUpdate()}>
                  重新检查
                </Button>
                <DialogClose asChild>
                  <Button variant="ghost">关闭</Button>
                </DialogClose>
              </>
            ) : inProgress ? (
              // 进行中（含 rolling_back）：禁用关闭
              <Button variant="ghost" disabled>
                {phase === 'rolling_back' ? '回滚中，请稍候…' : '更新中，请稍候…'}
              </Button>
            ) : phase === 'update_available' ? (
              <>
                <Button onClick={() => startUpdate()}>
                  立即更新
                </Button>
                <DialogClose asChild>
                  <Button variant="ghost">稍后再说</Button>
                </DialogClose>
              </>
            ) : (
              <DialogClose asChild>
                <Button variant="ghost">关闭</Button>
              </DialogClose>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  })

  return {
    // 状态（供外部读取）
    updatePhase,
    updateDialogOpen,
    checkData,
    isUpdateAvailable,
    currentVersion,
    latestInfo,
    isInProgress,
    // 方法
    initialCheck,
    openDialog,
    closeDialog,
    resetUpdate,
    // 组件
    SidebarUpdateButton,
    UpdateDialog,
    // 工具函数（供测试）
    mapBackendPhase,
    formatBytes,
    formatPublishedAt,
    resolveTargetVersion,
    UPDATE_PHASES,
    BACKEND_ACTIVE_PHASES,
    FRONTEND_ACTIVE_PHASES,
  }
}
