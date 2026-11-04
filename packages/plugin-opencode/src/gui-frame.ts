import { onCleanup } from "solid-js";
import { usePlugin } from "@opencode/plugin/gui";
import { dashboardUrl } from "./dashboard";
import { createFrameNavigation } from "./gui-navigation";

export function DashboardFrame(): HTMLElement {
  const ctx = usePlugin();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  const { endpoint, apiKey } = ctx.options;
  if (typeof endpoint !== "string" || typeof apiKey !== "string" || !apiKey.trim() || window.location.origin === "null") {
    throw new Error(ctx.t("config"));
  }
  let url: URL;
  try { url = new URL(dashboardUrl(endpoint)); } catch { throw new Error(ctx.t("config")); }
  url.searchParams.set("embedOrigin", window.location.origin);
  const navigation = createFrameNavigation(url);
  const toolbar = document.createElement("div");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", ctx.t("navigation"));
  toolbar.style.cssText = "display:flex;align-items:center;gap:2px;flex:none;height:30px;padding:0 5px;color:var(--muted-foreground);border-bottom:1px solid var(--interactive-border);background:var(--background)";
  const button = (label: string, path: string) => {
    const node = document.createElement("button");
    node.type = "button";
    node.title = ctx.t(label);
    node.setAttribute("aria-label", ctx.t(label));
    node.style.cssText = "display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("width", "14"); icon.setAttribute("height", "14"); icon.setAttribute("fill", "none"); icon.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path); shape.setAttribute("stroke", "currentColor"); shape.setAttribute("stroke-width", "1.7"); shape.setAttribute("stroke-linecap", "round"); shape.setAttribute("stroke-linejoin", "round");
    icon.append(shape); node.append(icon);
    node.onmouseenter = () => { if (!node.disabled) node.style.background = "var(--interactive-hover)"; };
    node.onmouseleave = () => { node.style.background = "transparent"; };
    return node;
  };
  const back = button("back", "M14 6l-6 6 6 6");
  const forward = button("forward", "M10 6l6 6-6 6");
  const reload = button("reload", "M20 10a8 8 0 1 0-2 8M20 4v6h-6");
  const address = document.createElement("input");
  address.readOnly = true;
  address.onblur = () => address.setSelectionRange(0, 0);
  address.setAttribute("aria-label", ctx.t("address"));
  address.style.cssText = "flex:1;min-width:0;height:22px;margin-left:4px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:inherit;font:11px system-ui;outline-offset:-2px;text-overflow:ellipsis";
  toolbar.append(back, forward, reload, address);
  const frame = document.createElement("iframe");
  frame.title = "Runmark";
  frame.style.cssText = "width:100%;height:100%;flex:1;min-height:0;border:0";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
  frame.referrerPolicy = "no-referrer";
  let ready = false;
  let sequence = 0;
  let pending: number | undefined;
  const update = () => {
    for (const [node, enabled] of [[back, ready && navigation.canBack()], [forward, ready && navigation.canForward()], [reload, ready]] as const) {
      node.disabled = !enabled; node.style.opacity = enabled ? "1" : "0.35";
    }
    address.value = navigation.display();
    address.title = address.value;
  };
  const send = (action: "navigate" | "reload", href?: string) => {
    const id = ++sequence;
    pending = action === 'navigate' ? id : undefined;
    frame.contentWindow?.postMessage({ type: "runmark.embed.navigate", action, href, id }, url.origin);
  };
  back.onclick = () => { if (!ready) return; const href = navigation.back(); if (href) { send("navigate", href); update(); } };
  forward.onclick = () => { if (!ready) return; const href = navigation.forward(); if (href) { send("navigate", href); update(); } };
  reload.onclick = () => { if (ready) { ready = false; send("reload"); update(); } };
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== url.origin) return;
    if (event.data?.type === "runmark.embed.ready") {
      frame.contentWindow?.postMessage({ type: "runmark.embed.auth", apiKey }, url.origin);
    } else if (event.data?.type === "runmark.embed.location") {
      if (pending !== undefined && event.data.id !== pending) return;
      if (event.data.id !== undefined && event.data.id !== sequence) return;
      if (!navigation.visit(event.data.href, event.data.mode === "replace" || event.data.mode === "traverse")) return;
      pending = undefined;
      ready = true;
      update();
    }
  };
  window.addEventListener("message", receive);
  frame.src = url.href;
  update();
  container.append(toolbar, frame);
  onCleanup(() => { window.removeEventListener("message", receive); frame.remove(); });
  return container;
}
