import { Registry, usePlugin } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import { dashboardUrl, sessionDashboardUrl } from "./dashboard";
export const WorkStatus = Registry.define("yuri.work-status");
export const workStatusStyle = `
  .runmark-status { --runmark-inset:calc(0.5rem * var(--padding-scale,1));min-width:0;margin-inline:var(--runmark-inset);padding-block:calc(0.375rem * var(--padding-scale,1));color:var(--muted-foreground);font-family:var(--font-sans,system-ui);font-size:calc(13 * var(--dpt,1px));font-weight:400;line-height:calc(1.25rem * var(--padding-scale,1));letter-spacing:normal;font-variant-numeric:tabular-nums; }
  .runmark-status .runmark-status-row { display:flex;align-items:center;gap:calc(0.25rem * var(--padding-scale,1));min-width:0; }
  .runmark-status button { box-sizing:border-box;display:flex;align-items:center;gap:calc(0.25rem * var(--padding-scale,1));min-width:0;min-height:calc(1.5rem * var(--padding-scale,1));padding:calc(0.125rem * var(--padding-scale,1)) 0;border:0;border-radius:var(--radius-sm,4px);background:transparent;color:inherit;font:inherit;cursor:pointer; }
  .runmark-status button:hover:not(:disabled) { background:var(--interactive-hover);color:var(--foreground); }
  .runmark-status button:focus-visible { outline:2px solid var(--interactive-focus-ring,var(--ring)) !important;outline-offset:1px; }
  .runmark-status button:disabled { opacity:0.5;cursor:default; }
  .runmark-status .runmark-status-open { flex:1;text-align:left;margin-inline-start:calc(-1 * var(--runmark-inset));padding-inline:var(--runmark-inset); }
  .runmark-status .runmark-status-link { overflow-wrap:anywhere; }
  .runmark-status .runmark-status-copy { flex:none;justify-content:center;width:calc(1.5rem * var(--padding-scale,1) + var(--runmark-inset));margin-inline-end:calc(-1 * var(--runmark-inset)); }
  .runmark-status svg { flex:none;width:calc(14 * var(--dpt,1px));height:calc(14 * var(--dpt,1px)); }
  .runmark-status .runmark-status-detail { margin:0;font:inherit;overflow-wrap:anywhere; }
  .runmark-status [hidden] { display:none !important; }
`;
export function RunmarkWorkStatus(props) {
    const ctx = usePlugin();
    const endpoint = ctx.options.endpoint;
    const apiKey = ctx.options.apiKey;
    const root = document.createElement("div");
    root.className = "runmark-status";
    const row = document.createElement("div");
    row.className = "runmark-status-row";
    const button = (shapes) => {
        const node = document.createElement("button");
        node.type = "button";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" }))
            svg.setAttribute(key, value);
        for (const [tag, attributes] of shapes) {
            const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [key, value] of Object.entries(attributes))
                shape.setAttribute(key, value);
            svg.append(shape);
        }
        node.append(svg);
        return node;
    };
    /*! Lucide share-2. ISC License, Copyright (c) 2026 Lucide Icons and Contributors.
     * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
     * provided that the above copyright notice and this permission notice appear in all copies.
     * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
     * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
     * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
     * AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
     * OF THIS SOFTWARE.
     */
    const open = document.createElement("button");
    open.type = "button";
    open.className = "runmark-status-open";
    const label = document.createElement("span");
    label.className = "runmark-status-link";
    open.append(label);
    const copy = button([["circle", { cx: "18", cy: "5", r: "3" }], ["circle", { cx: "6", cy: "12", r: "3" }], ["circle", { cx: "18", cy: "19", r: "3" }], ["line", { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49" }], ["line", { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49" }]]);
    copy.className = "runmark-status-copy";
    const detail = document.createElement("div");
    detail.className = "runmark-status-detail";
    detail.setAttribute("role", "status");
    const status = (key) => { detail.textContent = ctx.t(key); detail.title = ""; };
    row.append(open, copy);
    root.append(row, detail);
    const fail = () => ctx.toast.show({ variant: "error", title: ctx.t("statusActionFailed") });
    open.onclick = () => {
        if (!props.active || !props.session)
            return;
        const href = sessionDashboardUrl(endpoint, props.session.id);
        void Promise.resolve().then(() => ctx.system.openExternal(href)).catch(fail);
    };
    copy.onclick = () => {
        if (!props.active || !props.session)
            return;
        void ctx.system.copy(sessionDashboardUrl(endpoint, props.session.id)).then(() => {
            if (!props.signal.aborted)
                ctx.toast.show({ variant: "success", title: ctx.t("statusCopied") });
        }).catch(fail);
    };
    createEffect(() => {
        const id = props.session?.id;
        root.hidden = !id || !props.active;
        open.disabled = copy.disabled = !id || !props.active;
        open.title = ctx.t("statusOpen");
        copy.title = ctx.t("statusCopy");
        open.setAttribute("aria-label", open.title);
        copy.setAttribute("aria-label", copy.title);
        if (!id || !props.active || props.signal.aborted)
            return;
        let stopped = false;
        let timer;
        let request;
        const stop = () => { stopped = true; clearTimeout(timer); request?.abort(); };
        props.signal.addEventListener("abort", stop, { once: true });
        onCleanup(() => { stop(); props.signal.removeEventListener("abort", stop); });
        label.textContent = ctx.t("statusViewRecord");
        status("statusLoading");
        const refresh = async () => {
            if (stopped)
                return;
            request = new AbortController();
            const timeout = setTimeout(() => request?.abort(), 10_000);
            try {
                const url = new URL(dashboardUrl(endpoint));
                url.hash = "";
                url.pathname += `v1/sessions/${encodeURIComponent(id)}`;
                const response = await fetch(url, { headers: { "X-API-Key": apiKey }, credentials: "omit", redirect: "error", cache: "no-store", signal: request.signal });
                if (stopped)
                    return;
                if (response.status === 404) {
                    status("statusPending");
                    return;
                }
                if (!response.ok)
                    throw new Error("Runmark session unavailable");
                const data = await response.json();
                if (stopped)
                    return;
                const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
                const tokens = number(data.total_tokens);
                const cost = number(data.total_cost_cny);
                const requests = number(data.request_count);
                const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
                detail.textContent = [tokens === undefined ? null : `${compact.format(tokens)} Token`, cost === undefined ? null : `¥${cost.toFixed(2)}`].filter(Boolean).join(" · ") || ctx.t("statusPending");
                detail.title = [tokens === undefined ? null : `${tokens.toLocaleString()} Token`, cost === undefined ? null : `¥${cost.toFixed(2)}`, requests === undefined ? null : `${ctx.t("statusRequestLabel")} ${requests.toLocaleString()}`].filter(Boolean).join(" · ");
            }
            catch {
                if (!stopped)
                    status("statusUnavailable");
            }
            finally {
                clearTimeout(timeout);
                if (!stopped)
                    timer = setTimeout(() => void refresh(), 30_000);
            }
        };
        void refresh();
    });
    return root;
}
//# sourceMappingURL=gui-work-status.js.map