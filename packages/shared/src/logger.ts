import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandUserPath } from "./env-file";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface FileLoggerOptions {
  filePath: string;
  enabled?: boolean;
  component?: string;
}

/** Debug 阶段统一走文件日志，便于排查 ingest / hook 问题 */
export class FileLogger {
  private filePath: string;
  private enabled: boolean;
  private component: string;

  constructor(opts: FileLoggerOptions) {
    this.filePath = expandUserPath(opts.filePath);
    this.enabled = opts.enabled ?? false;
    this.component = opts.component ?? "agent-tracker";
    if (this.enabled) {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    if (!this.enabled) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
    };
    if (data !== undefined) entry.data = data;
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch {
      // 日志失败不能影响主流程
    }
  }

  debug(message: string, data?: unknown): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.write("error", message, data);
  }
}

export function defaultPluginLogPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.config/agent-tracker/plugin.log`;
}

export function defaultCursorHookLogPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.config/agent-tracker/cursor-hook.log`;
}

export function defaultServerLogPath(): string {
  return "data/agent-tracker.log";
}

export function isDebugEnabled(): boolean {
  return (process.env.AGENT_TRACKER_DEBUG ?? "false") === "true";
}

export function isFileLogMode(): boolean {
  return (process.env.AGENT_TRACKER_LOG_MODE ?? "file") === "file";
}
