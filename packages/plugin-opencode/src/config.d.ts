import { type PluginConfig } from "@agent-tracker/shared";
/**
 * 读取 opencode.jsonc 中以对象形式声明的插件 options；字符串条目没有 options。
 * memoryEnabled 兼容布尔与字符串写法，type 不合法时忽略并回落到 env 配置。
 * endpoint / apiKey 与上报配置同名，有效 options 优先于 env 配置。
 */
export declare function resolvePluginOptions(options?: unknown): Partial<Pick<PluginConfig, "endpoint" | "apiKey">> & {
    memoryEnabled?: boolean;
};
/** 加载插件配置；fileEnvPath 仅用于测试，默认 ~/.config/agent-tracker/env */
export declare function loadPluginConfig(fileEnvPath?: string, options?: unknown): PluginConfig & {
    memoryEnabled: boolean;
};
//# sourceMappingURL=config.d.ts.map