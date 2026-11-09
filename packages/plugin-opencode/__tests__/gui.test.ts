import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import * as Gui from "@opencode/plugin/gui";
import { gui } from "@opencode/plugin/gui/vite";
import { build } from "vite";
import { createFrameNavigation } from '../src/gui-navigation';

test('frame navigation bounds history, branches after Back and confines URLs to the dashboard document', () => {
  const base = new URL('https://runmark.example/?embedOrigin=https%3A%2F%2Fyuri.example#/summary');
  const history = createFrameNavigation(base);
  const path = (hash: string) => { const url = new URL(base); url.hash = hash; return url.href; };
  expect(history.canBack()).toBe(false);
  history.visit(path('/models')); history.visit(path('/sessions'));
  expect(history.back()).toBe(path('/models'));
  expect(history.canForward()).toBe(true);
  expect(history.forward()).toBe(path('/sessions'));
  history.back(); history.visit(path('/help'));
  expect(history.canForward()).toBe(false);
  expect(history.display()).toBe('https://runmark.example/#/help');
  expect(history.visit('https://evil.example/#/help')).toBe(false);
  expect(history.visit('https://runmark.example/?apiKey=secret#/help')).toBe(false);
  history.visit(path('/help?article=first'), true);
  expect(history.back()).toBe(path('/models'));
  for (let i=0;i<200;i++) history.visit(path(`/sessions/${i}`));
  let backs = 0; while (history.back()) backs++;
  expect(backs).toBe(127);
});

test("existing Dashboard embed bridge authenticates only its parent and never sends cookies or cross-origin credentials", async () => {
  const html = await readFile(resolve(import.meta.dir, "../../server/public/index.html"), "utf8");
  const source = html.slice(html.indexOf("    let embedApiKey ="), html.indexOf("    async function checkAuth()"));
  const callbacks: Array<(event: unknown) => Promise<void>> = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const parent = { postMessage(type: unknown, origin: string) { expect(origin).toBe("https://yuri.example"); } };
  const apiFetch = runInNewContext(`(function(){async function checkAuth(){};${source};return apiFetch})()`, {
    window: { parent, addEventListener: (type: string, cb: (event: unknown) => Promise<void>) => { if (type === 'message') callbacks.push(cb); } },
    history: { replaceState() {}, pushState() {} },
    location: { href: "https://runmark.example/?embedOrigin=https%3A%2F%2Fyuri.example", search: "?embedOrigin=https%3A%2F%2Fyuri.example", origin: "https://runmark.example", pathname: '/' },
    URL, URLSearchParams, Headers,
    fetch: async (url: URL, init: RequestInit) => { requests.push({ url: String(url), init }); return Response.json({}); },
  }) as (url: string) => Promise<Response>;
  await callbacks[0]({ source: {}, origin: "https://yuri.example", data: { type: "runmark.embed.auth", apiKey: "wrong" } });
  await apiFetch("/auth/session"); expect(new Headers(requests[0].init.headers).has("X-API-Key")).toBe(false);
  await callbacks[0]({ source: parent, origin: "https://yuri.example", data: { type: "runmark.embed.auth", apiKey: "fixture-only-key" } });
  await apiFetch("/v1/stats/summary");
  expect(new Headers(requests[1].init.headers).get("X-API-Key")).toBe("fixture-only-key");
  expect(requests[1].init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  await expect(apiFetch("https://evil.example/v1/stats")).rejects.toThrow("External authenticated request rejected");
  expect(requests).toHaveLength(2);
});

test("real bundle hides unconfigured entries, embeds the existing dashboard, confines auth to the frame and hides mobile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runmark-gui-"));
  try {
    await build({ configFile: false, root: resolve(import.meta.dir, ".."), logLevel: "silent", plugins: [gui({ entry: "src/gui.ts", outFile: join(directory, "gui.cjs") })] });
    const code = await readFile(join(directory, "gui.cjs"), "utf8");
    const module: { exports: { default?: Gui.Plugin.Definition } } = { exports: {} };
    const cleanups: Array<() => void> = [];
    const messages: unknown[][] = [];
    const listeners = new Set<(event: unknown) => void>();
    const frameWindow = { postMessage: (...args: unknown[]) => messages.push(args) };
    const elements: Array<Record<string, unknown>> = [];
    let context: unknown;
    runInNewContext(code, { module, exports: module.exports, URL, setTimeout: () => 1, clearTimeout() {},
      window: { location: { origin: "https://yuri.example" }, addEventListener: (_: string, cb: (event: unknown) => void) => listeners.add(cb), removeEventListener: (_: string, cb: (event: unknown) => void) => listeners.delete(cb) },
      document: {
        createElement(tag: string) { const node = { tag, style: {}, contentWindow: frameWindow, setAttribute() {}, append() {}, prepend() {}, remove() {} }; elements.push(node); return node; },
        createElementNS(_namespace: string, tag: string) { return { tag, setAttribute() {}, append() {} }; },
      },
      require(name: string) {
        if (name === "@opencode/plugin/gui") return { ...Gui, usePlugin: () => context };
        if (name === "solid-js") return { createComponent: (fn: () => unknown) => fn(), onCleanup: (fn: () => void) => cleanups.push(fn) };
        throw new Error(`Unexpected dependency ${name}`);
      },
    });
    const plugin = module.exports.default!;
    expect(plugin.main).toBeUndefined();
    for (const options of [
      {},
      { endpoint: "https://runmark.example" },
      { apiKey: "fixture-only-key" },
      { endpoint: "", apiKey: "fixture-only-key" },
      { endpoint: "   ", apiKey: "fixture-only-key" },
      { endpoint: "https://runmark.example", apiKey: "" },
      { endpoint: "https://runmark.example", apiKey: "   " },
      { endpoint: 123, apiKey: "fixture-only-key" },
      { endpoint: "https://runmark.example", apiKey: 123 },
    ]) {
      const entries = new Map<string, unknown>();
      context = { options, layout: { narrow: () => false }, use: () => () => ({ status: "inactive" }),
        add: (token: { id: string }, item: unknown) => entries.set(token.id, typeof item === "function" ? item() : item),
        t: (key: string) => plugin.i18n!.zh[key],
      };
      plugin.setup!(context as Parameters<Gui.Plugin.Setup>[0]);
      expect(entries.size).toBe(0);
    }
    for (const mobile of [false, true]) {
      const entries = new Map<string, unknown>();
      const opened: string[] = [];
      context = { options: { endpoint: "https://runmark.example", apiKey: "fixture-only-key" }, layout: { narrow: () => mobile },
        use: () => () => ({ status: "active", value: { open: (id: string) => { opened.push(id); return true; }, current: () => undefined } }),
        add: (token: { id: string }, item: unknown) => entries.set(token.id, typeof item === "function" ? item() : item),
        t: (key: string) => plugin.i18n!.zh[key],
      };
      plugin.setup!(context as Parameters<Gui.Plugin.Setup>[0]);
      const button = entries.get(Gui.TitlebarItem.id) as Gui.TitlebarItem | undefined;
      expect((entries.get(Gui.Command.id) as Gui.Command).enabled).toBe(!mobile);
      if (mobile) { expect(button).toBeUndefined(); continue; }
      expect(button!.icon).toBe("window-analytics"); button!.run!(); expect(opened).toEqual(["dashboard"]);
      (entries.get("yuri.page") as { render(): unknown }).render();
      const frame = elements.find((node) => node.tag === "iframe")!;
      expect(String(frame.src)).toContain("embedOrigin=https%3A%2F%2Fyuri.example");
      expect(String(frame.src)).not.toContain("fixture-only-key");
      for (const listener of listeners) {
        listener({ source: {}, origin: "https://runmark.example", data: { type: "runmark.embed.ready" } });
        listener({ source: frameWindow, origin: "https://evil.example", data: { type: "runmark.embed.ready" } });
      }
      expect(messages).toHaveLength(0);
      for (const listener of listeners) listener({ source: frameWindow, origin: "https://runmark.example", data: { type: "runmark.embed.ready" } });
      expect(messages).toEqual([[{ type: "runmark.embed.auth", apiKey: "fixture-only-key" }, "https://runmark.example"]]);
      const [back, forward, reload] = elements.filter((node) => node.tag === 'button');
      const address = elements.find((node) => node.tag === 'input')!;
      const collapsed: number[][] = [];
      address.setSelectionRange = (start: number, end: number) => collapsed.push([start, end]);
      (address.onblur as () => void)();
      expect(collapsed).toEqual([[0, 0]]);
      const emit = (data: unknown) => { for (const listener of listeners) listener({ source: frameWindow, origin: 'https://runmark.example', data }); };
      emit({ type: 'runmark.embed.location', href: frame.src, mode: 'push' });
      expect(back.disabled).toBe(true); expect(forward.disabled).toBe(true); expect(reload.disabled).toBe(false);
      const next = new URL(String(frame.src)); next.hash = '/models';
      emit({ type: 'runmark.embed.location', href: next.href, mode: 'push' });
      expect(address.value).toBe('https://runmark.example/#/models');
      (back.onclick as () => void)();
      expect(messages.at(-1)?.[0]).toMatchObject({ type: 'runmark.embed.navigate', action: 'navigate', id: 1 });
      emit({ type: 'runmark.embed.location', href: frame.src, mode: 'traverse', id: 1 });
      expect(forward.disabled).toBe(false);
      (forward.onclick as () => void)();
      emit({ type: 'runmark.embed.location', href: frame.src, mode: 'traverse', id: 1 });
      expect(address.value).toBe('https://runmark.example/#/models');
      emit({ type: 'runmark.embed.location', href: next.href, mode: 'traverse', id: 2 });
      (reload.onclick as () => void)();
      expect(messages.at(-1)?.[0]).toMatchObject({ action: 'reload', id: 3 });
      emit({ type: 'runmark.embed.ready' });
      expect(messages.at(-1)?.[0]).toMatchObject({ type: 'runmark.embed.auth', apiKey: 'fixture-only-key' });
      emit({ type: 'runmark.embed.location', href: next.href, mode: 'push' });
      expect(back.disabled).toBe(false);
      expect(forward.disabled).toBe(true);
      expect(reload.disabled).toBe(false);
      (back.onclick as () => void)();
      (forward.onclick as () => void)();
      emit({ type: 'runmark.embed.location', href: frame.src, mode: 'traverse', id: 4 });
      emit({ type: 'runmark.embed.location', href: frame.src, mode: 'push' });
      expect(address.value).toBe('https://runmark.example/#/models');
      emit({ type: 'runmark.embed.location', href: next.href, mode: 'traverse', id: 5 });
      expect(address.value).toBe('https://runmark.example/#/models');
      expect(elements.filter((node) => node.tag === 'iframe')).toHaveLength(1);
      cleanups.forEach((stop) => stop()); expect(listeners.size).toBe(0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
