/**
 * Git 元信息采集（Codex Hook 侧）
 *
 * 每次 SessionStart 调用时即时采集，因 hook 之间进程独立无法缓存。
 */

const GIT_TIMEOUT_MS = 2_000;

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: cwd || process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    // 等待进程退出，带超时
    const timeout = setTimeout(() => {
      proc.kill();
    }, GIT_TIMEOUT_MS);
    await proc.exited;
    clearTimeout(timeout);
    return output.trim();
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
