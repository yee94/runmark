import { resolve } from "node:path";
import { FileLogger } from "@agent-tracker/shared";
import type { ServerConfig } from "./config";

let logger: FileLogger | null = null;

export function initLogger(config: ServerConfig): FileLogger {
  logger = new FileLogger({
    filePath: resolve(config.logFile),
    enabled: config.debug,
    component: "server",
  });
  return logger;
}

export function getLogger(): FileLogger {
  if (!logger) {
    throw new Error("Logger not initialized");
  }
  return logger;
}
