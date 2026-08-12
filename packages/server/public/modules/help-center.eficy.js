import { component, computed, effect, signal } from 'eficy'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

const ARTICLES = [
  {
    id: 'quickstart',
    title: '统一接入配置',
    path: '/help/quickstart.md',
    eyebrow: 'Shared Client Env',
    summary: '所有客户端共用 ~/.config/agent-tracker/env，在这里一次性配置上报地址和 API Key。',
  },
  {
    id: 'cursor',
    title: 'Cursor 安装配置',
    path: '/help/cursor.md',
    eyebrow: 'Cursor Hook',
    summary: '安装 Cursor Hook；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'opencode',
    title: 'OpenCode 安装配置',
    path: '/help/opencode.md',
    eyebrow: 'OpenCode Plugin',
    summary: '安装 OpenCode Plugin；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'codex',
    title: 'Codex 安装配置',
    path: '/help/codex.md',
    eyebrow: 'Codex Hook Plugin',
    summary: '安装 Codex Hook Plugin；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'claude',
    title: 'Claude Code 安装配置',
    path: '/help/claude.md',
    eyebrow: 'Claude Code Plugin',
    summary: '安装 Claude Code（含 TClaude）Plugin；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'codebuddy',
    title: 'CodeBuddy 安装配置',
    path: '/help/codebuddy.md',
    eyebrow: 'CodeBuddy Plugin',
    summary: '安装 CodeBuddy Plugin；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy 安装配置',
    path: '/help/workbuddy.md',
    eyebrow: 'WorkBuddy Plugin',
    summary: '安装 WorkBuddy Plugin；上报地址与 API Key 请先参考统一接入配置。',
  },
  {
    id: 'grok',
    title: 'Grok Build 安装配置',
    path: '/help/grok.md',
    eyebrow: 'Grok Build Hooks',
    summary: '安装 Grok Build 用户级 Hooks；上报地址与 API Key 请先参考统一接入配置。',
  },
]

function shellSingleQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'"
}

function buildEnvCommand(endpoint, apiKey) {
  return [
    'mkdir -p ~/.config/agent-tracker && {',
    '  echo ""',
    '  echo ' + shellSingleQuote('# Runmark client config'),
    '  echo ' + shellSingleQuote('AGENT_TRACKER_ENDPOINT="' + endpoint + '"'),
    '  echo ' + shellSingleQuote('AGENT_TRACKER_API_KEY="' + apiKey + '"'),
    '} >> ~/.config/agent-tracker/env',
  ].join('\n')
}

function buildPlaceholders(ctx) {
  const endpoint = ctx.endpoint || location.origin
  const apiKey = ctx.apiKey || '<API_KEY>'
  return {
    ENDPOINT: endpoint,
    API_KEY: apiKey,
    CLIENT_ENV_COMMAND: buildEnvCommand(endpoint, apiKey),
    CLIENT_ENV_PATH: '~/.config/agent-tracker/env',
    HEALTH_URL: endpoint + '/health',
    DASHBOARD_URL: endpoint + '/',
    INGEST_PROBE_OPENCODE: [
      'curl -X POST ' + shellSingleQuote(endpoint + '/v1/ingest') + ' \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "X-API-Key: ' + apiKey + '" \\',
      '  -d ' + shellSingleQuote('{"events":[{"type":"session.created","session_id":"probe-1","agent":"opencode"}]}'),
    ].join('\n'),
  }
}

function applyPlaceholders(markdown, placeholders) {
  let next = String(markdown || '')
  for (const [key, value] of Object.entries(placeholders)) {
    next = next.replaceAll('{{' + key + '}}', String(value))
  }
  return next
}

function withCodeCopyButtons(html) {
  return String(html || '').replace(
    /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    '<div class="help-code-wrap"><button class="help-copy-btn" type="button" data-copy-code="1">复制</button><pre><code$1>$2</code></pre></div>',
  )
}

export function createHelpCenterPage(ctx) {
  const {
    apiFetch,
    selectedHelpArticleId,
    activeTab,
    focusHelpArticleRoute,
    SectionTitle,
  } = ctx

  const markdownById = signal({})
  const helpContext = signal({
    endpoint: location.origin,
    apiKey: '',
    apiKeyVisible: false,
    publicDashboard: false,
  })
  const loadingArticleId = signal('')
  const loadError = signal('')

  async function loadHelpContext() {
    const data = await apiFetch('/v1/help/context').then((r) => r.json()).catch(() => null)
    if (data) helpContext.value = data
  }

  async function loadArticle(article) {
    if (!article || markdownById.value[article.id]) return
    loadingArticleId.value = article.id
    loadError.value = ''
    try {
      const res = await fetch(article.path, { credentials: 'include' })
      if (!res.ok) throw new Error('Markdown fetch failed: ' + res.status)
      const text = await res.text()
      markdownById.value = { ...markdownById.value, [article.id]: text }
    } catch {
      loadError.value = '文章加载失败，请检查 public/help 下的 Markdown 文件是否存在。'
    } finally {
      loadingArticleId.value = ''
    }
  }

  effect(() => {
    if (activeTab?.value !== 'help') return
    loadHelpContext()
  })

  const selectedArticle = computed(() => {
    return ARTICLES.find((article) => article.id === selectedHelpArticleId.value) || ARTICLES[0]
  })

  effect(() => {
    loadArticle(selectedArticle.value)
  })

  const renderedArticleHtml = computed(() => {
    const article = selectedArticle.value
    const markdown = markdownById.value[article.id] || ''
    const replaced = applyPlaceholders(markdown, buildPlaceholders(helpContext.value))
    return withCodeCopyButtons(marked.parse(replaced))
  })

  function selectArticle(article) {
    selectedHelpArticleId.value = article.id
    focusHelpArticleRoute(article.id)
  }

  async function copyCodeBlock(event) {
    const button = event.target?.closest?.('[data-copy-code]')
    if (!button) return
    const wrap = button.closest('.help-code-wrap')
    const code = wrap?.querySelector?.('pre')?.innerText || ''
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      button.textContent = '已复制'
      setTimeout(() => { button.textContent = '复制' }, 1200)
    } catch {
      button.textContent = '复制失败'
      setTimeout(() => { button.textContent = '复制' }, 1200)
    }
  }

  const ArticleNavRow = component(({ article }) => {
    const active = selectedArticle.value.id === article.id
    return (
      <button className={'help-nav-row' + (active ? ' help-nav-row--active' : '')} onClick={() => selectArticle(article)}>
        <span>
          <b>{article.title}</b>
          <small>{article.summary}</small>
        </span>
      </button>
    )
  })

  const HelpCenterPage = component(() => {
    const article = selectedArticle.value
    const loading = loadingArticleId.value === article.id && !markdownById.value[article.id]
    return (
      <div className="mock-page help-page fade-up">
        <div className="mock-page-head">
          <div>
            <h2 className="mock-title">帮助中心</h2>
            <p className="mock-subtitle">内置安装配置手册，正文以 Markdown 维护，并按当前服务地址与 API Key 动态填充命令。</p>
          </div>
        </div>

        <div className="help-layout">
          <aside className="help-nav panel-card">
            <SectionTitle title="文章" subtitle="安装与配置" />
            <div className="help-nav-list">
              {ARTICLES.map((item) => <ArticleNavRow key={item.id} article={item} />)}
            </div>
          </aside>

          <article className="help-article panel-card">
            <div className="help-article-head">
              <div>
                <div className="agent-editor-kicker">{article.eyebrow}</div>
                <h2>{article.title}</h2>
                <p>{article.summary}</p>
              </div>
            </div>

            {loading ? <div className="help-loading">Loading Markdown…</div> : null}
            {loadError.value ? <div className="help-error">{loadError.value}</div> : null}
            {!loading && !loadError.value ? (
              <div className="help-markdown" onClick={copyCodeBlock} dangerouslySetInnerHTML={{ __html: renderedArticleHtml.value }} />
            ) : null}
          </article>
        </div>
      </div>
    )
  })

  return HelpCenterPage
}
