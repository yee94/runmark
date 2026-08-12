import {
  defaultCursorHookLogPath,
  defaultPluginEnvPath,
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
  const fileEnv = loadEnvFile(fileEnvPath ?? defaultPluginEnvPath());
  const env = (key: string, ...aliases: string[]) => resolveEnvValue(fileEnv, key, ...aliases);

  return {
    endpoint: env("AGENT_TRACKER_ENDPOINT", "endpoint") ?? "http://localhost:3456",
    apiKey: env("AGENT_TRACKER_API_KEY", "apiKey", "api_key") ?? "dev-key-change-me",
    includeMessageContent: (env("AGENT_TRACKER_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
    includeToolOutput: (env("AGENT_TRACKER_INCLUDE_TOOL_OUTPUT", "includeToolOutput") ?? "true") === "true",
    debug: (env("AGENT_TRACKER_DEBUG", "debug") ?? "false") === "true",
    logFile: env("AGENT_TRACKER_LOG_FILE", "logFile", "log_file") ?? defaultCursorHookLogPath(),
    includeMessages: (env("AGENT_TRACKER_INCLUDE_MESSAGES", "includeMessages") ?? "true") === "true",
  };
}
