import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/modules/memories.eficy.js", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace("export function createMemoriesPage", "function createMemoriesPage");
const compiled = new Bun.Transpiler({loader:"jsx", tsconfig:{compilerOptions:{jsx:"react", jsxFactory:"h"}}}).transformSync(source);

function setup(agent = "") {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const effects: Array<() => void> = [];
  const requests: URL[] = [];
  const activeTab = {value:"memories"};
  const navigations: string[] = [];
  const createPage = runInNewContext(compiled + "\ncreateMemoriesPage", {
    URLSearchParams,
    signal: (value: unknown) => ({value}),
    peek: (signal: {value: unknown}) => signal.value,
    component: (render: unknown) => render,
    React: {Fragment:"Fragment"},
    effect: (run: () => void) => effects.push(run),
    shadcnUi: new Proxy({Lucide:{}}, {get:(target, key) => key === "Lucide" ? target.Lucide : key}),
    h: (type: unknown, props: any, ...children: any[]) => ({type, props: props || {}, children: children.flat(Infinity)}),
    setTimeout: (run: () => void, delay: number) => { const id = ++timerId; timers.set(id, {at:now + delay, run}); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const render = createPage({
    activeTab, selectedAgentId:{value:""}, navigate:(tab:string) => navigations.push(tab), formatDateTime:(value:string) => value,
    apiFetch: async (path:string) => {
      const url = new URL(path, "http://test");
      requests.push(url);
      const item = {id:"memory-one",name:"memory-one",description:"测试记忆",scope:"global",type:"user",agent_key:agent,body:"记忆正文",sources:[]};
      const data = url.pathname === "/v1/memories/scopes" ? {items:[]} : url.pathname.endsWith("/config") ? {enabled:false} : url.pathname === "/v1/memories" ? {items:[item],next_cursor:"next-page"} : item;
      return {ok:true,status:200,json:async () => data};
    },
  });
  function find(predicate: (node:any) => boolean, node = render()): any {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    for (const child of node.children || []) { if (child == null) continue; const found = find(predicate, child); if (found) return found; }
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async (ms:number) => {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
    await settle();
  };
  const input = (value:string) => find(node => node.props["aria-label"] === "搜索记忆").props.onInput({target:{value}});
  const submit = () => find(node => node.type === "form").props.onSubmit({preventDefault:() => {}});
  const searches = () => requests.filter(url => url.pathname === "/v1/memories");
  return {find, input, submit, searches, advance, settle, effects, activeTab, requests, navigations};
}

test("memory search waits 300ms after the last input and searches automatically", async () => {
  const page = setup();
  page.input("pro");
  await page.advance(200);
  expect(page.searches()).toHaveLength(0);
  page.input("progress");
  await page.advance(299);
  expect(page.searches()).toHaveLength(0);
  await page.advance(1);
  expect(page.searches().map(url => url.searchParams.get("query"))).toEqual(["progress"]);
});

test("submitting searches immediately and cancels the pending debounce", async () => {
  const page = setup();
  page.input(" 中文 ");
  page.submit();
  await page.settle();
  expect(page.searches().map(url => url.searchParams.get("query"))).toEqual(["中文"]);
  await page.advance(300);
  expect(page.searches()).toHaveLength(1);
});

test("Chinese composition only starts the debounce after committing text", async () => {
  const page = setup();
  const input = page.find(node => node.props["aria-label"] === "搜索记忆");
  input.props.onCompositionStart();
  page.input("zhong");
  await page.advance(500);
  expect(page.searches()).toHaveLength(0);
  input.props.onCompositionEnd({target:{value:"中文"}});
  await page.advance(300);
  expect(page.searches().map(url => url.searchParams.get("query"))).toEqual(["中文"]);
});

test("clearing text restores unfiltered memories after the debounce", async () => {
  const page = setup();
  page.input("中文");
  await page.advance(300);
  page.input("");
  await page.advance(300);
  expect(page.searches().map(url => url.searchParams.get("query"))).toEqual(["中文", ""]);
});

test("leaving the memory page cancels a pending search", async () => {
  const page = setup();
  page.input("pending");
  page.activeTab.value = "sessions";
  for (const effect of page.effects) effect();
  await page.advance(300);
  expect(page.searches()).toHaveLength(0);
});

test("pagination uses the applied search until the new debounce fires", async () => {
  const page = setup();
  page.input("old");
  page.submit();
  await page.settle();
  page.input("new");
  const more = page.find(node => node.type === "Button" && node.children.includes("查看更多记忆"));
  more.props.onClick();
  await page.settle();
  expect(page.searches().at(-1)!.searchParams.get("query")).toBe("old");
  expect(page.searches().at(-1)!.searchParams.get("cursor")).toBe("next-page");
  await page.advance(300);
  expect(page.searches().at(-1)!.searchParams.get("query")).toBe("new");
  expect(page.searches().at(-1)!.searchParams.has("cursor")).toBe(false);
});

test("cards open a detail dialog without navigation or clearing the search results", async () => {
  const page = setup();
  page.input("中文");
  page.submit();
  await page.settle();
  page.find(node => node.props.className === "memory-card-summary").props.onClick();
  await page.settle();
  expect(page.find(node => node.type === "Dialog").props.open).toBe(true);
  expect(page.find(node => node.props.className === "memory-body").children).toEqual(["记忆正文"]);
  expect(page.find(node => node.props.className === "memory-dialog-sources").type).toBe("section");
  expect(page.find(node => node.props.className === "memory-feed")).toBeDefined();
  page.find(node => node.type === "Dialog").props.onOpenChange(false);
  expect(page.find(node => node.type === "Dialog").props.open).toBe(false);
  expect(page.navigations).toEqual([]);
  expect(page.find(node => node.props["aria-label"] === "搜索记忆").props.value).toBe("中文");
  expect(page.find(node => node.props.className === "memory-feed")).toBeDefined();
  expect(page.searches()).toHaveLength(1);
});

test("detail dialogs read the selected memory's Agent namespace", async () => {
  const page = setup("opencode/build");
  page.submit();
  await page.settle();
  page.find(node => node.props.className === "memory-card-summary").props.onClick();
  await page.settle();
  const detail = page.requests.find(url => url.pathname === "/v1/memories/memory-one")!;
  expect(detail.searchParams.get("agent_key")).toBe("opencode/build");
  expect(detail.searchParams.get("view")).toBe("all");
  expect(detail.searchParams.get("usage")).toBe("inspect");
  expect(page.searches()).toHaveLength(1);
  expect(page.find(node => node.props.className === "memory-body")).toBeDefined();
});
