/**
 * 高频噪声工具：对会话理解帮助小，不上报 tool.result。
 *
 * Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy 共用。
 * 比较时忽略大小写；含各端别名（Bash≈Shell、read_file≈Read、Glob≈list_dir 等）。
 */

/** 规范化后的工具名集合（小写） */
export const SKIP_TOOL_NAMES = new Set([
  // Cursor / 通用
  "read",
  "write",
  "shell",
  "grep",
  "glob",
  // Claude Code / CodeBuddy / WorkBuddy CLI
  "bash",
  // CodeBuddy IDE / Genie 别名
  "read_file",
  "write_file",
  "execute_command",
  "run_command",
  "run_terminal_cmd",
  "search_content",
  "list_dir",
  "list_files",
  "glob_file_search",
  // Grok Build 工具名
  "run_terminal_command",
  "search_path",
  "grep_search",
]);

/** 是否跳过该工具的 tool.result 上报 */
export function shouldSkipTool(toolName: string): boolean {
  return SKIP_TOOL_NAMES.has(String(toolName || "").trim().toLowerCase());
}
