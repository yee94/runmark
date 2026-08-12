export type ScheduleMode = "throttle" | "debounce";
export type ScheduleScope = "agent" | "session";

const DURATION_TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;
const MODE_TOKENS = new Set(["throttle", "debounce"]);

export function parseThrottleMs(raw: string | undefined, fallbackMs: number): number {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return fallbackMs;
  const match = trimmed.match(DURATION_TOKEN_RE);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const ms = Math.round(amount * (multipliers[unit] ?? 1));
  return ms > 0 ? ms : fallbackMs;
}

/** 将 schedule 规范为 canonical 字符串：agent 级 `debounce:1m`，会话级 `session:debounce:1m` */
export function formatSchedule(mode: ScheduleMode, scope: ScheduleScope, waitRaw: string): string {
  const duration = String(waitRaw || "").trim() || "10m";
  return scope === "session" ? `session:${mode}:${duration}` : `${mode}:${duration}`;
}

/**
 * 解析 schedule 协议。token 前后顺序不限，例如：
 * - debounce:1m
 * - session:debounce:1m / debounce:session:1m / session:1m:debounce
 * - throttle:5m / session:throttle:5m
 */
export function parseSchedule(raw: string | undefined, fallbackMs: number): {
  mode: ScheduleMode;
  scope: ScheduleScope;
  waitMs: number;
  waitRaw: string | null;
} {
  const tokens = String(raw ?? "").trim().split(/\s*:\s*/).filter(Boolean);
  let mode: ScheduleMode | null = null;
  let scope: ScheduleScope = "agent";
  let waitRaw: string | null = null;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (MODE_TOKENS.has(lower)) {
      mode = lower as ScheduleMode;
      continue;
    }
    if (lower === "session") {
      scope = "session";
      continue;
    }
    if (lower === "agent" || lower === "global") {
      scope = "agent";
      continue;
    }
    if (DURATION_TOKEN_RE.test(token)) {
      waitRaw = token;
    }
  }

  return {
    mode: mode ?? "throttle",
    scope,
    waitMs: parseThrottleMs(waitRaw ?? undefined, fallbackMs),
    waitRaw,
  };
}
