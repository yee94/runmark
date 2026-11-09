import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { sessionAgents, sessionClientSources, resolveClientIconUrl } from "../public/modules/client-source.js";

const source = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
const compiler = new Bun.Transpiler({ loader: "jsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h" } } });
const text = (node: any): string => node == null ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node.children ? node.children.map(text).join("") : text(node.value);
const images = (node: any): any[] => node == null || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(images) : node.type === "img" ? [node] : (node.children || []).flatMap(images);
const formatAgentLabel = (id: string) => ({ opencode: "OpenCode", codex: "Codex" }[id] || id || "—");
const resolveAgentIconUrl = (id: string) => ["opencode", "codex"].includes(id) ? `/agent-icons/${id}.svg` : null;

test("client source Dashboard modules and entrypoint remain valid JSX", () => {
  for (const file of ["modules/sessions-list.eficy.js", "modules/session-detail.eficy.js", "modules/summary.eficy.js"]) {
    expect(() => compiler.transformSync(source(file))).not.toThrow();
    // loadModule 执行 Blob URL；模块间依赖经 ctx 注入，不能使用原生相对 import。
    expect(source(file)).not.toMatch(/from ['"]\.\.?\//);
  }
  const script = source("index.html").match(/<script type="text\/eficy">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  expect(() => compiler.transformSync(script!)).not.toThrow();
});

test("session rows display the stored Agent without an independent source label", () => {
  const compiled = compiler.transformSync(source("modules/sessions-list.eficy.js")
    .replace(/^import .*$/gm, "").replace(/^export /gm, ""));
  const createRow = runInNewContext(compiled + "\ncreateSessionRow", {
    component: (fn: unknown) => fn,
    computed: (fn: () => unknown) => ({ get value() { return fn(); } }),
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  });
  const row = createRow({
    formatTokens: String, formatCost: String, formatDateTime: String,
    formatRelativeTime: String, formatSessionDuration: String,
    sessionAgents, routeSessionId: { value: "" }, peek: (s: any) => s.value,
    formatAgentLabel, resolveAgentIconUrl, ChevronIcon: "chevron",
  });
  for (const [agent, clients, unknown, expected, expectedIcons] of [
    ["yuri", ["yuri"], false, "Yuri", ["./client-icons/yuri.svg"]],
    ["yuri", ["yuri"], true, "Yuri", ["./client-icons/yuri.svg"]],
    ["other", ["yuri", "other"], true, "other", []],
    ["opencode", ["yuri"], false, "OpenCode", ["/agent-icons/opencode.svg"]],
    ["opencode", [], true, "OpenCode", ["/agent-icons/opencode.svg"]],
    ["opencode", undefined, undefined, "OpenCode", ["/agent-icons/opencode.svg"]],
  ] as const) {
    const tree = row({ session: { value: { id: "session", agent, client_ids: clients, has_unknown_client: unknown } } });
    const column = tree.children.find((child: any) => child?.props?.className === "session-agent-col");
    expect(text(column)).toBe(expected);
    expect(images(column).map(icon => icon.props.src)).toEqual(expectedIcons);
    expect(text(tree)).not.toContain("来源");
  }
});

test("Agent display follows the real field rather than recomputing attribution from clients", () => {
  expect(sessionAgents({ agent: "yuri", client_ids: ["yuri", "codex"], has_unknown_client: true }, formatAgentLabel, resolveAgentIconUrl)).toEqual([
    { id: "yuri", label: "Yuri", icon: "./client-icons/yuri.svg" },
  ]);
  expect(sessionAgents({ agent: "codex" }, formatAgentLabel, resolveAgentIconUrl)).toEqual([
    { id: "codex", label: "Codex", icon: "/agent-icons/codex.svg" },
  ]);
  expect(sessionAgents(null, formatAgentLabel, resolveAgentIconUrl)).toEqual([{ id: undefined, label: "—", icon: null }]);
});

test("top sessions use the stored Agent", () => {
  const compiled = compiler.transformSync(source("modules/summary.eficy.js")
    .replace(/^import .*$/gm, "").replace(/^export /gm, ""));
  const createPanels = runInNewContext(compiled + "\ncreateSummaryPanels", {
    component: (fn: unknown) => fn,
    React: { Fragment: "fragment" },
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  });
  const panels = createPanels({
    topCostSessions: { value: [{ id: "session", agent: "yuri", client_ids: ["yuri"], has_unknown_client: true }] },
    sessionAgents, formatAgentLabel, resolveAgentIconUrl, formatTokens: String, formatCost: String,
  });
  const tree = panels.TopSessionsPanel();
  expect(text(tree)).toContain("Yuri");
  expect(text(tree)).not.toContain("OpenCode");
  expect(images(tree).map(icon => icon.props.src)).toEqual(["./client-icons/yuri.svg"]);
});

test("session detail has only Agent, without separate client source labels", () => {
  const detail = source("modules/session-detail.eficy.js");
  expect(detail).toContain("sessionAgents(session.value, formatAgentLabel, resolveAgentIconUrl)");
  expect(detail).not.toMatch(/来源：|trace-meta-label">来源|session-client-source/);
});

test("Agent distribution renders the actual Yuri agent with its brand and icon", () => {
  const html = source("index.html");
  const branding = html.slice(html.indexOf("const AGENT_ICON_NAMES"), html.indexOf("/** 将消息内容"));
  const helpers = runInNewContext(branding + "\n({ formatAgentLabel, resolveAgentIconUrl })", {
    normalizeModelKey: (value: string) => String(value || "").toLowerCase(),
  });
  expect(helpers.formatAgentLabel("yuri")).toBe("Yuri");
  expect(helpers.resolveAgentIconUrl("yuri")).toBe("./client-icons/yuri.svg");
  const compiled = compiler.transformSync(source("modules/summary.eficy.js")
    .replace(/^import .*$/gm, "").replace(/^export /gm, ""));
  const createPanels = runInNewContext(compiled + "\ncreateSummaryPanels", {
    component: (fn: unknown) => fn,
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  });
  const panels = createPanels({
    topAgents: { value: [{ agent: "yuri", total_tokens: 100, total_cost_cny: 7 }] }, topAgentMax: { value: 7 },
    ...helpers, formatTokens: String, formatCost: String, formatPct: String,
  });
  const tree = panels.AgentBreakdownPanel();
  expect(text(tree)).toContain("Yuri");
  expect(text(tree)).not.toContain("OpenCode");
  expect(images(tree).map(icon => icon.props.src)).toEqual(["./client-icons/yuri.svg"]);
});

test("Yuri uses a transparent SVG only for explicitly declared Yuri sources", () => {
  expect(resolveClientIconUrl("yuri")).toBe("./client-icons/yuri.svg");
  for (const id of [undefined, null, "other", "Yuri", "../yuri"]) expect(resolveClientIconUrl(id)).toBeNull();
  const session = { client_ids: ["other", "yuri"], has_unknown_client: true };
  expect(sessionClientSources(session)).toEqual([
    { id: "other", label: "other", icon: null },
    { id: "yuri", label: "Yuri", icon: "./client-icons/yuri.svg" },
    { id: null, label: "未知", icon: null },
  ]);
  expect(session.client_ids).toEqual(["other", "yuri"]);
  const svg = source("client-icons/yuri.svg");
  expect(svg).toContain('<path fill="#FFFFFF"');
  expect(svg).not.toMatch(/<(rect|image|script|foreignObject)\b/i);
});
