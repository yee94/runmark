import { defaultServerLogPath, resolveEnvValue } from "@agent-tracker/shared";
import serverPkg from "../package.json" assert { type: "json" };

export function getServerVersion(): string {
  return (serverPkg as { version?: string }).version ?? "0.0.0";
}

export interface ServerConfig {
  port: number;
  apiKey: string;
  dbPath: string;
  publicDir: string;
  /** 为 true 时 Dashboard 读 API 免鉴权（仅建议本地开发） */
  publicDashboard: boolean;
  /** Optional comma-separated additional API keys. */
  extraApiKeys: string[];
  /** Debug 模式：日志写入文件。默认 false */
  debug: boolean;
  /** 日志文件路径 */
  logFile: string;
  /** 是否启用 Cursor Usage API 对账（需加密密钥 + 用户配置 Session Token） */
  cursorSyncEnabled: boolean;
  cursorApiKey: string;
  cursorCryptoKey?: Uint8Array;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  agentThrottleMs: number;
  agentAutoRunEnabled: boolean;
  /** 是否启用远程更新检查与调度。默认 true；manifest 默认指向 GitHub Release latest */
  updateEnabled: boolean;
  /** 远端 manifest JSON URL（schemaVersion 1）；默认空，需显式配置才启用检查 */
  updateManifestUrl: string;
  /** 执行更新的外部脚本路径 */
  updateScript: string;
  /** 本地更新状态持久化文件路径 */
  updateStatePath: string;
}

function parseKeyBytes(raw?: string): Uint8Array | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(trimmed.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }
  try {
    const b = Buffer.from(trimmed, "base64");
    if (b.length === 32) return new Uint8Array(b);
  } catch {}
  return undefined;
}

export function loadConfig(): ServerConfig {
  const env = (key: string) => resolveEnvValue({}, key);
  const apiKey = env("RUNMARK_API_KEY") ?? "dev-key-change-me";
  return {
    port: Number(env("RUNMARK_PORT") ?? 3456),
    apiKey,
    dbPath: env("RUNMARK_DB_PATH") ?? "data/agent-tracker.db",
    publicDir: env("RUNMARK_PUBLIC_DIR") ?? "./public",
    publicDashboard: (env("RUNMARK_PUBLIC_DASHBOARD") ?? "false") === "true",
    extraApiKeys: (env("RUNMARK_EXTRA_API_KEYS") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    debug: (env("RUNMARK_DEBUG") ?? "false") === "true",
    logFile: env("RUNMARK_LOG_FILE") ?? defaultServerLogPath(),
    cursorSyncEnabled: (env("RUNMARK_CURSOR_SYNC_ENABLED") ?? "true") === "true",
    cursorApiKey: env("RUNMARK_CURSOR_API_KEY") ?? apiKey,
    cursorCryptoKey: parseKeyBytes(env("RUNMARK_CURSOR_CRYPTO_KEY")),
    llmBaseUrl: env("RUNMARK_LLM_BASE_URL") ?? "https://api.deepseek.com",
    llmApiKey: env("RUNMARK_LLM_API_KEY") ?? "",
    llmModel: env("RUNMARK_LLM_MODEL") ?? "deepseek-chat",
    agentThrottleMs: Number(env("RUNMARK_AGENT_THROTTLE_MS") ?? 10 * 60 * 1000),
    agentAutoRunEnabled: (env("RUNMARK_AGENT_AUTO_RUN_ENABLED") ?? "true") === "true",
    // 默认开启自动更新；仅当显式设为 false 时关闭
    updateEnabled: (env("RUNMARK_UPDATE_ENABLED") ?? "true") === "true",
    updateManifestUrl: env("RUNMARK_UPDATE_MANIFEST_URL") ?? 
      "https://github.com/yee94/runmark/releases/latest/download/server-manifest.json",
    updateScript: env("RUNMARK_UPDATE_SCRIPT") ?? "/opt/runmark-updater/update.sh",
    updateStatePath: env("RUNMARK_UPDATE_STATE_PATH") ?? "/opt/runmark-updater/update-state.json",
  };
}
