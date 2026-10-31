import {
  defaultCursorHookLogPath,
  loadEnvFile,
  resolveEnvValue,
  type PluginConfig,
} from "@agent-tracker/shared";

export interface HookConfig extends PluginConfig {
  includeMessages: boolean;
  includeToolOutput: boolean;
}

/** 加载 Cursor Hook 配置；复用 ~/.config/agent-tracker/env */
export function loadHookConfig(fileEnvPath?: string): HookConfig {
  const fileEnv = loadEnvFile(fileEnvPath);
  const env = (key: string, ...aliases: string[]) => resolveEnvValue(fileEnv, key, ...aliases);

  return {
    endpoint: env("RUNMARK_ENDPOINT", "endpoint") ?? "http://localhost:3456",
    apiKey: env("RUNMARK_API_KEY", "apiKey", "api_key") ?? "dev-key-change-me",
    includeMessageContent: (env("RUNMARK_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
    includeToolOutput: (env("RUNMARK_INCLUDE_TOOL_OUTPUT", "includeToolOutput") ?? "true") === "true",
    debug: (env("RUNMARK_DEBUG", "debug") ?? "false") === "true",
    logFile: env("RUNMARK_LOG_FILE", "logFile", "log_file") ?? defaultCursorHookLogPath(),
    includeMessages: (env("RUNMARK_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
  };
}
