/** OpenCode SmartFetch 等临时会话标题：不上报、不进 Dashboard 列表 */
const HIDDEN_SESSION_TITLES = new Set(["smartfetch-secondary"]);

/** 是否为应隐藏的临时会话（按 title 精确匹配） */
export function isHiddenSessionTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return HIDDEN_SESSION_TITLES.has(String(title).trim());
}
