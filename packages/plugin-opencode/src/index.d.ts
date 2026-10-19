/**
 * Runmark — OpenCode Plugin
 *
 * Captures full conversation details, token usage, and cost from every OpenCode session
 * and reports them to a centralized Runmark server.
 *
 * This plugin follows the same hook API as opencode-otel-plugin but sends data
 * as JSON to our own server instead of via OTLP/protobuf.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { type PluginConfig } from "@agent-tracker/shared";
/** 加载插件配置；fileEnvPath 仅用于测试，默认 ~/.config/agent-tracker/env */
export declare function loadPluginConfig(fileEnvPath?: string): PluginConfig;
export declare const AgentTrackerPlugin: Plugin;
/**
 * OpenCode 1 走 server（函数）。
 * OpenCode 2.0.12 只接受 { id, setup }，事件从 ctx.event.subscribe 读。
 */
declare const plugin: {
    id: string;
    server: Plugin;
    setup: (ctx: unknown) => Promise<void | (() => void)>;
};
export default plugin;
//# sourceMappingURL=index.d.ts.map