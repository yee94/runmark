import { Registry } from "@opencode/plugin/gui";
export interface WorkStatusProps {
    readonly session?: {
        readonly id: string;
    };
    readonly active: boolean;
    readonly signal: AbortSignal;
}
export declare const WorkStatus: Registry<{
    readonly id: string;
    render(props: WorkStatusProps): HTMLElement;
}>;
export declare const workStatusStyle = "\n  .runmark-status { --runmark-inset:calc(0.5rem * var(--padding-scale,1));min-width:0;margin-inline:var(--runmark-inset);padding-block:calc(0.375rem * var(--padding-scale,1));color:var(--muted-foreground);font-family:var(--font-sans,system-ui);font-size:calc(13 * var(--dpt,1px));font-weight:400;line-height:calc(1.25rem * var(--padding-scale,1));letter-spacing:normal;font-variant-numeric:tabular-nums; }\n  .runmark-status .runmark-status-row { display:flex;align-items:center;gap:calc(0.25rem * var(--padding-scale,1));min-width:0; }\n  .runmark-status button { box-sizing:border-box;display:flex;align-items:center;gap:calc(0.25rem * var(--padding-scale,1));min-width:0;min-height:calc(1.5rem * var(--padding-scale,1));padding:calc(0.125rem * var(--padding-scale,1)) 0;border:0;border-radius:var(--radius-sm,4px);background:transparent;color:inherit;font:inherit;cursor:pointer; }\n  .runmark-status button:hover:not(:disabled) { background:var(--interactive-hover);color:var(--foreground); }\n  .runmark-status button:focus-visible { outline:2px solid var(--interactive-focus-ring,var(--ring)) !important;outline-offset:1px; }\n  .runmark-status button:disabled { opacity:0.5;cursor:default; }\n  .runmark-status .runmark-status-open { flex:1;text-align:left;margin-inline-start:calc(-1 * var(--runmark-inset));padding-inline:var(--runmark-inset); }\n  .runmark-status .runmark-status-link { overflow-wrap:anywhere; }\n  .runmark-status .runmark-status-copy { flex:none;justify-content:center;width:calc(1.5rem * var(--padding-scale,1) + var(--runmark-inset));margin-inline-end:calc(-1 * var(--runmark-inset)); }\n  .runmark-status svg { flex:none;width:calc(14 * var(--dpt,1px));height:calc(14 * var(--dpt,1px)); }\n  .runmark-status .runmark-status-detail { margin:0;font:inherit;overflow-wrap:anywhere; }\n  .runmark-status [hidden] { display:none !important; }\n";
export declare function RunmarkWorkStatus(props: WorkStatusProps): HTMLElement;
//# sourceMappingURL=gui-work-status.d.ts.map