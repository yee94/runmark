import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPluginEnvPath, legacyPluginEnvPath } from "@agent-tracker/shared";
import { HOOK_ENTRY_FILE, HOOK_INSTALL_DIR, HOOK_SCRIPT_NAME, HOOK_WRAPPER_FILE, TRACKED_HOOK_EVENTS } from "./constants";

export interface InitOptions {
  /** 安装到项目 .cursor 而非 ~/.cursor */
  project?: boolean;
  /** 覆盖已有 Runmark Hook 条目 */
  force?: boolean;
  /** hooks.json 与脚本目标目录（测试用） */
  cursorDir?: string;
  /** 内置 hook dist 目录（测试用） */
  hookDistDir?: string;
  /** run.sh 源路径（测试用） */
  wrapperSourcePath?: string;
}

interface HooksFile {
  version: number;
  hooks: Record<string, Array<{ command: string; [key: string]: unknown }>>;
}

const ENV_TEMPLATE = `# Runmark 全局上报配置（OpenCode 插件与 Cursor Hook 共用）
RUNMARK_ENDPOINT="http://localhost:3456"
RUNMARK_API_KEY="dev-key-change-me"
RUNMARK_INCLUDE_MESSAGES=true
RUNMARK_INCLUDE_TOOL_OUTPUT=true
`;

function resolvePackageDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveWrapperSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", HOOK_WRAPPER_FILE);
}

function isAgentTrackerHook(entry: { command?: string }): boolean {
  if (!entry.command) return false;
  const cmd = entry.command;
  return cmd.includes("agent-tracker-hook.mjs")
    || cmd.includes(`hooks/${HOOK_INSTALL_DIR}/`);
}

/** 合并 hooks.json：移除旧的 Runmark 条目后重新注册 */
export function mergeHooksConfig(existing: HooksFile | null, hookCommand: string): HooksFile {
  const base: HooksFile = existing?.version === 1 && existing.hooks
    ? { version: 1, hooks: { ...existing.hooks } }
    : { version: 1, hooks: {} };

  for (const event of TRACKED_HOOK_EVENTS) {
    const prev = base.hooks[event] ?? [];
    const kept = prev.filter((entry) => !isAgentTrackerHook(entry));
    base.hooks[event] = [...kept, { command: hookCommand }];
  }

  return base;
}

function ensureEnvFile(): { created: boolean; path: string } {
  const envPath = defaultPluginEnvPath();
  if (existsSync(envPath)) {
    return { created: false, path: envPath };
  }
  const legacyPath = legacyPluginEnvPath();
  if (existsSync(legacyPath)) {
    return { created: false, path: legacyPath };
  }
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, ENV_TEMPLATE, "utf-8");
  return { created: true, path: envPath };
}

/** 复制 dist 内 hook chunk + run.sh 到 .cursor/hooks/agent-tracker/ */
function installHookBundle(cursorDir: string, distDir: string, wrapperSource: string): string {
  const targetDir = join(cursorDir, "hooks", HOOK_INSTALL_DIR);
  mkdirSync(targetDir, { recursive: true });

  // 清理旧版单文件安装
  const legacyHook = join(cursorDir, "hooks", "agent-tracker-hook.mjs");
  if (existsSync(legacyHook)) {
    try {
      unlinkSync(legacyHook);
    } catch {
      // ignore
    }
  }

  // 清理旧版 hook.js（.mjs→.js 重命名会导致 bundle 内 import 路径失效）
  for (const legacy of [HOOK_SCRIPT_NAME, "hook.js"]) {
    const legacyPath = join(targetDir, legacy);
    if (existsSync(legacyPath)) {
      try {
        unlinkSync(legacyPath);
      } catch {
        // ignore
      }
    }
  }
  for (const name of readdirSync(targetDir)) {
    if (name.startsWith("constants-") && (name.endsWith(".js") || name.endsWith(".mjs"))) {
      try {
        unlinkSync(join(targetDir, name));
      } catch {
        // ignore
      }
    }
  }

  for (const name of readdirSync(distDir)) {
    if (name === "cli.js" || name === "cli.mjs") continue;
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
    copyFileSync(join(distDir, name), join(targetDir, name));
  }

  const entryPath = join(targetDir, HOOK_ENTRY_FILE);
  if (!existsSync(entryPath)) {
    throw new Error(`Hook 入口未找到: ${entryPath}。请先在该包目录执行 bun run build`);
  }

  if (!existsSync(wrapperSource)) {
    throw new Error(`Hook 包装脚本未找到: ${wrapperSource}`);
  }
  const wrapperDest = join(targetDir, HOOK_WRAPPER_FILE);
  copyFileSync(wrapperSource, wrapperDest);
  try {
    chmodSync(wrapperDest, 0o755);
  } catch {
    // Windows 等环境可能不支持 chmod
  }

  return `./hooks/${HOOK_INSTALL_DIR}/${HOOK_WRAPPER_FILE}`;
}

/** 一键初始化 Cursor Hook（用户级 ~/.cursor 或项目级 .cursor） */
export function runInit(options: InitOptions = {}): {
  cursorDir: string;
  hooksPath: string;
  hookCommand: string;
  envPath: string;
  envCreated: boolean;
} {
  const cwd = process.cwd();
  const cursorDir = options.cursorDir ?? (options.project ? join(cwd, ".cursor") : join(homedir(), ".cursor"));
  const distDir = options.hookDistDir ?? resolvePackageDistDir();
  const wrapperSource = options.wrapperSourcePath ?? resolveWrapperSource();

  if (!existsSync(distDir)) {
    throw new Error(`Hook dist 未找到: ${distDir}。请先在该包目录执行 bun run build`);
  }

  mkdirSync(cursorDir, { recursive: true });
  const hookCommand = installHookBundle(cursorDir, distDir, wrapperSource);

  const hooksPath = join(cursorDir, "hooks.json");
  let existing: HooksFile | null = null;
  if (existsSync(hooksPath)) {
    try {
      existing = JSON.parse(readFileSync(hooksPath, "utf-8")) as HooksFile;
    } catch {
      existing = null;
    }
  }

  const merged = mergeHooksConfig(existing, hookCommand);
  writeFileSync(hooksPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  const env = ensureEnvFile();

  return {
    cursorDir,
    hooksPath,
    hookCommand,
    envPath: env.path,
    envCreated: env.created,
  };
}
