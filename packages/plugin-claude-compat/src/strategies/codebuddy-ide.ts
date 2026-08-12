/**
 * CodeBuddy IDE transcript 采集策略（Debounce on turn）
 *
 * ⚠️ 仅 CodeBuddy IDE：agent=codebuddy 且 transcript 为 history/index.json。
 * Claude / WorkBuddy / CodeBuddy CLI（JSONL）一律不走 Debounce，只解析一次。
 *
 * Debounce 只等终态 turn（usage / Abort），不看 session start、也不先报 assistant。
 * turn 就绪后同批上报 message + turn（assistant 在前、turn 在后）。
 * Debounce 只在独立 queue worker 里跑（hook 前台只入队后立刻 exit）；
 * 实测 turn 多在 assistant 文件后约 100ms 内可解析到。
 */
import type { IngestEvent } from "@agent-tracker/shared";
import type { ClaudeCompatAgent } from "../transform";

/**
 * 只等 turn 落盘竞态（合计约 3.3s）。
 * 不按整轮生成时长（startedAt→完成）拉长；正文与 lastStep* 几乎同盘。
 */
export const CODEBUDDY_IDE_TURN_DELAYS_MS = [
  50, 100, 150, 200, 300, 500, 800, 1200,
] as const;

/** @deprecated 使用 CODEBUDDY_IDE_TURN_DELAYS_MS */
export const CODEBUDDY_IDE_LATE_USAGE_DELAYS_MS = CODEBUDDY_IDE_TURN_DELAYS_MS;

/** 仅依赖 debug，避免强耦合 FileLogger 实现 */
export interface StrategyLogger {
  debug(message: string, data?: unknown): void;
}

export interface CollectTranscriptOptions {
  sessionId: string;
  transcriptPath: string;
  /** 单次解析（未就绪 assistant 按住，有 turn 才同批产出） */
  parseOnce: () => IngestEvent[];
  logger?: StrategyLogger;
  /** 测试可注入 */
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}

/** transcript_path 是否指向 CodeBuddy IDE history/index.json */
export function isCodeBuddyIdeTranscriptPath(path?: string | null): boolean {
  return Boolean(path) && String(path).endsWith("index.json");
}

/**
 * 是否启用 CodeBuddy IDE Debounce（双重门禁：agent + 路径）。
 * Claude / WorkBuddy / CodeBuddy CLI 返回 false。
 */
export function shouldDebounceCodeBuddyIde(
  agent: ClaudeCompatAgent,
  transcriptPath?: string | null,
): boolean {
  return agent === "codebuddy" && isCodeBuddyIdeTranscriptPath(transcriptPath);
}

/** 是否已出现终态 turn（完成或 Abort/失败） */
export function hasTerminalTurn(events: IngestEvent[]): boolean {
  return events.some((event) => event.type === "turn.completed" || event.type === "turn.error");
}

/**
 * 同批事件排序：同一 message 的 assistant 正文在 turn 之前，再跟 tool 等。
 * Debounce 保证有 turn 才上报；此处保证 ingest 顺序稳定。
 */
export function orderIdeEventsForIngest(events: IngestEvent[]): IngestEvent[] {
  const rank = (ev: IngestEvent): number => {
    if (ev.type === "message" && ev.role === "user") return 0;
    if (ev.type === "message" && ev.role === "assistant") return 1;
    if (ev.type === "tool.result") return 2;
    if (ev.type === "turn.completed" || ev.type === "turn.error") return 3;
    if (ev.type === "session.idle") return 9;
    return 5;
  };
  return [...events].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = "created_at" in a && typeof a.created_at === "string" ? a.created_at : "";
    const tb = "created_at" in b && typeof b.created_at === "string" ? b.created_at : "";
    return ta.localeCompare(tb);
  });
}

/**
 * Debounce 采集：只等到终态 turn，再返回同批事件（含 assistant）。
 * 耗尽仍无 turn → 返回 []，绝不单独先报 assistant。
 */
export async function collectCodeBuddyIdeTranscriptEvents(
  opts: CollectTranscriptOptions,
): Promise<IngestEvent[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delays = opts.delaysMs ?? CODEBUDDY_IDE_TURN_DELAYS_MS;
  const logger = opts.logger;

  let events = opts.parseOnce();
  if (hasTerminalTurn(events)) {
    return orderIdeEventsForIngest(events);
  }

  for (const delayMs of delays) {
    await sleep(delayMs);
    events = opts.parseOnce();
    if (hasTerminalTurn(events)) {
      logger?.debug("codebuddy ide turn debounce ready", {
        sessionId: opts.sessionId,
        delayMs,
        count: events.length,
        types: events.map((e) => e.type),
      });
      return orderIdeEventsForIngest(events);
    }
  }

  logger?.debug("codebuddy ide turn debounce exhausted without turn", {
    sessionId: opts.sessionId,
    transcriptPath: opts.transcriptPath,
  });
  // 无 turn 不上报半截 assistant；留给后续 SessionEnd / 下次 Stop 再试
  return [];
}

/**
 * Stop / SessionEnd 统一入口：仅 CodeBuddy IDE 走 turn Debounce，其余只解析一次。
 */
export async function collectTranscriptEventsForStop(opts: {
  sessionId: string;
  agent: ClaudeCompatAgent;
  transcriptPath?: string | null;
  parseOnce: (path: string) => IngestEvent[];
  logger?: StrategyLogger;
  sleep?: (ms: number) => Promise<void>;
}): Promise<IngestEvent[]> {
  const path = opts.transcriptPath;
  if (!path) return [];

  const parseOnce = () => opts.parseOnce(path);
  // Claude / WorkBuddy / CodeBuddy CLI：立即解析，无 sleep
  if (!shouldDebounceCodeBuddyIde(opts.agent, path)) {
    return parseOnce();
  }

  return collectCodeBuddyIdeTranscriptEvents({
    sessionId: opts.sessionId,
    transcriptPath: path,
    parseOnce,
    logger: opts.logger,
    sleep: opts.sleep,
  });
}
