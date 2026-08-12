/**
 * Runmark — Grok Build Plugin 配置加载
 *
 * 与 OpenCode / Codex 插件共用同一套 env 读取逻辑（~/.config/agent-tracker/env）。
 */
import {
  FileLogger,
  defaultPluginLogPath,
  loadEnvFile,
  resolveEnvValue,
  type PluginConfig,
} from "@agent-tracker/shared";

/** 加载插件配置；fileEnvPath 仅用于测试，默认 ~/.config/agent-tracker/env */
export function loadGrokConfig(fileEnvPath?: string): PluginConfig {
  const fileEnv = loadEnvFile(fileEnvPath);
  const env = (key: string, ...aliases: string[]) =>
    resolveEnvValue(fileEnv, key, ...aliases);

  return {
    endpoint:
      env("AGENT_TRACKER_ENDPOINT", "endpoint") ?? "http://localhost:3456",
    apiKey:
      env("AGENT_TRACKER_API_KEY", "apiKey", "api_key") ??
      "dev-key-change-me",
    includeMessageContent:
      (env("AGENT_TRACKER_INCLUDE_MESSAGES", "includeMessages") ?? "true") ===
      "true",
    includeToolOutput:
      (env("AGENT_TRACKER_INCLUDE_TOOL_OUTPUT", "includeToolOutput") ??
        "true") === "true",
    debug: (env("AGENT_TRACKER_DEBUG", "debug") ?? "false") === "true",
    logFile:
      env("AGENT_TRACKER_LOG_FILE", "logFile", "log_file") ??
      defaultPluginLogPath(),
  };
}

export function createGrokLogger(config: PluginConfig): FileLogger {
  return new FileLogger({
    filePath: config.logFile ?? defaultPluginLogPath(),
    enabled: config.debug === true,
    component: "grok-hook",
  });
}

export { type PluginConfig };
