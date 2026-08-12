/** Cursor Hook stdin 公共字段（各事件可能附带额外字段） */
export interface CursorHookPayload {
  hook_event_name?: string;
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  model?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  cursor_version?: string;
  [key: string]: unknown;
}
