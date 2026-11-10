import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const signal = (value: unknown) => ({ value });

test.each([
  { sessionId: "session", initiallyLoading: true, requests: 0 },
  { sessionId: "session", initiallyLoading: false, requests: 6 },
  { sessionId: null, initiallyLoading: true, requests: 6 },
])("session startup skips global requests but background refresh and Dashboard pages retain them (%j)", async ({ sessionId, initiallyLoading, requests }) => {
  const start = html.indexOf("async function fetchData(");
  const code = html.slice(start, html.indexOf("/** 拉取子会话详情", start));
  const paths: string[] = [];
  const loading = signal(initiallyLoading);
  const refreshing = signal(true);
  const fetchData = runInNewContext(code + "\nfetchData", {
    routeSessionId: signal(sessionId), loading, refreshing,
    statsQueryString: () => "?range=month", sessionsQueryString: () => "?limit=50",
    apiFetch: async (path: string) => { paths.push(path); return { ok: true, json: async () => [] }; },
    sessionAiResultsMode: signal(false),
    batch: (fn: () => void) => fn(),
    summary: signal(null), byModel: signal([]), byAgent: signal([]), dailyStats: signal([]), annualStats: signal(null),
    sessionsLoading: signal(true), lastRefreshed: signal(null), applySessionsResult: () => {},
  });
  await fetchData(false);
  expect(paths).toHaveLength(requests);
  if (requests) expect(paths).toContain('/v1/stats/annual-activity');
  expect(loading.value).toBe(false);
  expect(refreshing.value).toBe(false);
});

const pageLoaders: Record<string, string> = {
  summary: "loadSummaryPanels", models: "loadModelsPage", sessions: "loadSessionsListPage",
  "agent-config": "loadAgentConfigPage", "agent-runs": "loadAgentRunsPage", "system-config": "loadSystemConfigPage",
  matters: "loadMattersPage", memories: "loadMemoriesPage", help: "loadHelpCenterPage",
};

test.each(Object.entries(pageLoaders))("%s only loads its own page module", (tab, loader) => {
  const start = html.indexOf("// 启动模块加载");
  const code = html.slice(start, html.indexOf("// ─── Session Detail", start));
  const loaded: string[] = [];
  runInNewContext(code, {
    ...Object.fromEntries(Object.values(pageLoaders).map(name => [name, () => { loaded.push(name); }])),
    effect: (fn: () => void) => fn(),
    authChecking: signal(false), authenticated: signal(true), shareMode: signal(false),
    activeTab: signal(tab), routeSessionId: signal(null),
  });
  expect(loaded).toEqual([loader]);
});

test("session details and public shares do not eagerly load Dashboard page modules", () => {
  const start = html.indexOf("// 启动模块加载");
  const code = html.slice(start, html.indexOf("// ─── Session Detail", start));
  for (const state of [
    { authChecking: false, authenticated: true, shareMode: false, activeTab: "sessions", routeSessionId: "session" },
    { authChecking: false, authenticated: true, shareMode: true, activeTab: "summary", routeSessionId: null },
    { authChecking: true, authenticated: true, shareMode: false, activeTab: "summary", routeSessionId: null },
    { authChecking: false, authenticated: false, shareMode: false, activeTab: "summary", routeSessionId: null },
  ]) {
    const loaded: string[] = [];
    runInNewContext(code, {
      ...Object.fromEntries(Object.values(pageLoaders).map(name => [name, () => { loaded.push(name); }])),
      ...Object.fromEntries(Object.entries(state).map(([key, value]) => [key, signal(value)])),
      effect: (fn: () => void) => fn(),
    });
    expect(loaded).toEqual([]);
  }
});

test("leaving a direct session link loads statistics needed by the summary page", () => {
  const start = html.indexOf("function syncRouteFromHash()");
  const code = html.slice(start, html.indexOf("let publicShareRequestVersion", start));
  let refreshes = 0;
  const sync = runInNewContext(code + "\nsyncRouteFromHash", {
    parseRoute: () => ({ tab: "summary", sessionId: null }),
    batch: (fn: () => void) => fn(),
    ...Object.fromEntries(["activeTab", "routeAgentRunId", "selectedAgentRunId", "traceTypes", "selectedTraceKey", "routeTraceChild", "traceAutoFocusKey", "traceDeepLinkFocus"].map(name => [name, signal(null)])),
    routeSessionId: signal("session"),
    fetchData: () => { refreshes++; },
  });
  sync();
  expect(refreshes).toBe(1);
});
