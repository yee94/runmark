const FORK_TITLE_RE = /\(fork\s*#\d+\)/i;

/** OpenCode fork 会话标题约定：仅 title 含 (fork #N) 时视为 fork */
export function isForkSessionTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return FORK_TITLE_RE.test(title);
}

/** 去掉 title 末尾的 (fork #N)，得到来源会话标题 */
export function forkSourceTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const stripped = String(title).replace(/\s*\(fork\s*#\d+\)\s*$/i, "").trim();
  return stripped || null;
}

/** fork 后重放的历史 turn：完成时间早于 fork 创建时刻 */
export function isForkReplayTurn(completedMs: number | undefined, forkCutoffMs: number | undefined): boolean {
  if (forkCutoffMs == null || completedMs == null) return false;
  return completedMs < forkCutoffMs;
}
