import { defaultPluginLogPath, loadEnvFile, resolveEnvValue } from "@agent-tracker/shared";
/**
 * 读取 opencode.jsonc 中以对象形式声明的插件 options；字符串条目没有 options。
 * memoryEnabled 兼容布尔与字符串写法，type 不合法时忽略并回落到 env 配置。
 * endpoint / apiKey 与上报配置同名，有效 options 优先于 env 配置。
 */
export function resolvePluginOptions(options) {
    if (!options || typeof options !== "object" || Array.isArray(options))
        return {};
    const input = options;
    return {
        endpoint: typeof input.endpoint === "string" && input.endpoint.trim() ? input.endpoint.trim() : undefined,
        apiKey: typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined,
        memoryEnabled: typeof input.memoryEnabled === "boolean" ? input.memoryEnabled
            : input.memoryEnabled === "true" ? true : input.memoryEnabled === "false" ? false : undefined,
    };
}
/** 加载插件配置；fileEnvPath 仅用于测试，默认 ~/.config/agent-tracker/env */
export function loadPluginConfig(fileEnvPath, options) {
    const fileEnv = loadEnvFile(fileEnvPath);
    const env = (key, ...aliases) => resolveEnvValue(fileEnv, key, ...aliases);
    const pluginOptions = resolvePluginOptions(options);
    return {
        memoryEnabled: pluginOptions.memoryEnabled ?? env("RUNMARK_MEMORY_ENABLED", "memoryEnabled") === "true",
        endpoint: pluginOptions.endpoint ?? env("RUNMARK_ENDPOINT", "endpoint") ?? "http://localhost:3456",
        apiKey: pluginOptions.apiKey ?? env("RUNMARK_API_KEY", "apiKey", "api_key") ?? "dev-key-change-me",
        includeMessageContent: (env("RUNMARK_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
        includeToolOutput: (env("RUNMARK_INCLUDE_TOOL_OUTPUT", "includeToolOutput") ?? "true") === "true",
        debug: (env("RUNMARK_DEBUG", "debug") ?? "false") === "true",
        logFile: env("RUNMARK_LOG_FILE", "logFile", "log_file") ?? defaultPluginLogPath(),
    };
}
//# sourceMappingURL=config.js.map