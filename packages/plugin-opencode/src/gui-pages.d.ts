import { Contract, Registry, type IconName } from "@opencode/plugin/gui";
import type { JSX } from "solid-js";
export declare const Page: Registry<{
    readonly id: string;
    readonly title: string;
    readonly icon?: IconName;
    render(): JSX.Element;
}>;
export declare const Pages: Contract<{
    open(id: string): boolean;
    current(): string | undefined;
}, "yuri.pages">;
//# sourceMappingURL=gui-pages.d.ts.map