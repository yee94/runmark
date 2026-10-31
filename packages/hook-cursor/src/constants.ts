/** Cursor Hook 安装子目录（.cursor/hooks/agent-tracker/） */
export const HOOK_INSTALL_DIR = "agent-tracker";

/** Hook 包装脚本（hooks.json 指向此文件，由 bash 调用 node） */
export const HOOK_WRAPPER_FILE = "run.sh";

/** Node 入口（仅由 run.sh 调用） */
export const HOOK_ENTRY_FILE = "hook.mjs";

/** @deprecated 旧版单文件安装名，init 时会清理 */
export const HOOK_SCRIPT_NAME = "agent-tracker-hook.mjs";

/** Runmark 注册的 Cursor Hook 事件 */
export const TRACKED_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "stop",
] as const;

export type TrackedHookEvent = (typeof TRACKED_HOOK_EVENTS)[number];

export const AGENT_ID = "cursor";
export const PROVIDER_ID = "cursor";

// 高频工具过滤：统一走 @agent-tracker/shared（含 Glob 等）
export { SKIP_TOOL_NAMES, shouldSkipTool } from "@agent-tracker/shared";
