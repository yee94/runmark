/**
 * Git 元信息采集（Claude 兼容 Hook 侧）
 *
 * 每次 SessionStart 调用时即时采集，因 hook 之间进程独立无法缓存。
 * 使用 node:child_process.execFile，bun / node 均可运行；timeout 真正生效。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: cwd || process.cwd(),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getGitAuthor(cwd?: string): Promise<string> {
  return runGit(["config", "user.email"], cwd);
}

export async function getRepoUrl(cwd?: string): Promise<string> {
  return runGit(["remote", "get-url", "origin"], cwd);
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  return runGit(["branch", "--show-current"], cwd);
}

export function getHostname(): string {
  try {
    const os = require("node:os");
    return os.hostname();
  } catch {
    return "unknown";
  }
}
