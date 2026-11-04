import { Contract, Registry, type IconName } from "@opencode/plugin/gui";
import type { JSX } from "solid-js";

export const Page = Registry.define<{
  readonly id: string;
  readonly title: string;
  readonly icon?: IconName;
  render(): JSX.Element;
}>("yuri.page");

export const Pages = Contract.define<{
  open(id: string): boolean;
  current(): string | undefined;
}, "yuri.pages">("yuri.pages");
