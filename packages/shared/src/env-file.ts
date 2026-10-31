import { existsSync, readFileSync } from "node:fs";

/** 插件客户端配置文件默认路径 */
export function defaultPluginEnvPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.config/runmark/env`;
}

export function legacyPluginEnvPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.config/agent-tracker/env`;
}

/** 展开路径中的 ~、$HOME、${HOME}（env 文件不经 shell，需代码侧处理） */
export function expandUserPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const trimmed = path.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return `${home}/${trimmed.slice(2)}`;
  return trimmed
    .replace(/^\$\{HOME\}\//, `${home}/`)
    .replace(/^\$HOME\//, `${home}/`);
}

/** 去掉 env 值两侧引号 */
function unquoteEnvValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 解析 env 文件内容为键值对（支持 # 注释、export、引号） */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = unquoteEnvValue(match[2]);
  }
  return result;
}

/** 读取插件 env 文件；不存在或不可读时返回空对象 */
export function loadEnvFile(filePath?: string): Record<string, string> {
  const path = filePath ?? (existsSync(defaultPluginEnvPath()) ? defaultPluginEnvPath() : legacyPluginEnvPath());
  try {
    return parseEnvFile(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** 合并进程 env 与文件 env；进程 env 优先。aliases 为文件中的友好键名 */
export function resolveEnvValue(
  fileEnv: Record<string, string>,
  key: string,
  ...aliases: string[]
): string | undefined {
  const canonicalKey = key.replace(/^AGENT_TRACKER_/, "RUNMARK_");
  const keys = canonicalKey.startsWith("RUNMARK_")
    ? [canonicalKey, canonicalKey.replace(/^RUNMARK_/, "AGENT_TRACKER_")]
    : [key];
  for (const source of [process.env, fileEnv]) {
    for (const name of keys) {
      if (source[name] !== undefined) return source[name];
    }
  }
  for (const alias of aliases) {
    if (fileEnv[alias] !== undefined) return fileEnv[alias];
  }
  return undefined;
}
