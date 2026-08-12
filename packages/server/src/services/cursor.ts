/**
 * Cursor usage 同步服务。
 * Hook 上报会话入队；串行拉取 Usage API 并按队列归属补充 cost。
 */

import type { Database } from "bun:sqlite";
import type { ServerConfig } from "../config";
import type { CursorCookie } from "./cursorCrypto";
import { decryptCookieJar, encryptCookieJar } from "./cursorCrypto";
import { enrichSessionUsage, MAX_TURN_LOOKBACK_SEC } from "./cursorEnrich";
import {
  countPendingQueue,
  dequeueNextPending,
  enqueueCursorSessions,
  enqueueRecentCursorSessions,
  hasPendingQueue,
  markQueueDone,
  markQueueFailed,
  markQueueSyncing,
  requeueSessionIfNeeded,
} from "./cursorEnrichQueue";
import { resolveStatsRange } from "./stats";
import type { FileLogger } from "@agent-tracker/shared";

export type CursorStatsRange = "today" | "24h" | "7d" | "month" | "all";

export interface CursorUsageEvent {
  eventId?: string;
  id?: string;
  timestamp: number | string;
  model: string;
  /** Cursor Usage API 会话归属，与 Hook session_id / conversation_id 对齐 */
  conversationId?: string;
  chargedCents?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  isChargeable?: boolean;
  isHeadless?: boolean;
}

export interface CursorUsageEventsResponse {
  totalUsageEventsCount?: number;
  usageEventsDisplay?: CursorUsageEvent[];
}

export interface CursorSyncJob {
  id?: number;
  started_at: string;
  finished_at?: string | null;
  status: "running" | "success" | "failed";
  events_count?: number | null;
  error?: string | null;
  range_start?: string | null;
  range_end?: string | null;
}

export interface CursorSyncStatus {
  enabled: boolean;
  hasCryptoKey: boolean;
  hasCookies: boolean;
  available: boolean;
  syncing: boolean;
  authExpired: boolean;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  nextRetryAt?: string | null;
  totalEvents: number;
  pendingEnrich: number;
  pendingQueue: number;
}

const CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const CURSOR_USAGE_EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const BACKOFF_MINUTES = [1, 5, 30, 120];
const INGEST_DEBOUNCE_MS = 8_000;

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

function parseEventTimestamp(raw: number | string): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n)) return Math.floor(Date.now() / 1000);
  return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

function usageEventId(ev: CursorUsageEvent): string {
  if (ev.eventId) return String(ev.eventId);
  if (ev.id) return String(ev.id);
  const ts = parseEventTimestamp(ev.timestamp);
  const tu = ev.tokenUsage || {};
  return `${ts}-${ev.model}-${tu.inputTokens ?? 0}-${tu.outputTokens ?? 0}-${ev.chargedCents ?? 0}`;
}

/** 将 Dashboard 粘贴的 Session Token 转为 cookie jar */
export function sessionTokenToCookies(token: string): CursorCookie[] {
  const value = token.trim();
  if (!value) throw new Error("sessionToken required");
  return [
    {
      name: "WorkosCursorSessionToken",
      value,
      domain: ".cursor.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ];
}

export class CursorService {
  private db: Database;
  private cfg: ServerConfig;
  private logger: FileLogger;
  private fullSyncRunning = false;
  private queueProcessing = false;
  private authExpired = false;
  private failures = 0;
  private nextRetryAt?: Date;
  private ingestDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, cfg: ServerConfig, logger: FileLogger) {
    this.db = db;
    this.cfg = cfg;
    this.logger = logger;
  }

  private get cryptoKey(): Uint8Array | undefined {
    return this.cfg.cursorCryptoKey;
  }

  private isEnabled(): boolean {
    if (!this.cfg.cursorSyncEnabled) return false;
    if (!this.cryptoKey) return false;
    return true;
  }

  async importCookies(source: string, cookies: CursorCookie[], updatedAt?: number): Promise<void> {
    const key = this.cryptoKey;
    if (!key) throw new Error("服务端未配置 AGENT_TRACKER_CURSOR_CRYPTO_KEY，无法加密存储 Cookie");

    const jar = await encryptCookieJar(cookies, key);
    this.db.query(`
      INSERT INTO cursor_cookies (id, source, jar_encrypted, updated_at)
      VALUES (1, $source, $jar, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        jar_encrypted = excluded.jar_encrypted,
        updated_at = excluded.updated_at
    `).run({
      $source: source,
      $jar: jar,
      $updated_at: updatedAt ? toIso(updatedAt) : toIso(Date.now()),
    });
    this.authExpired = false;
    this.failures = 0;
    this.nextRetryAt = undefined;
  }

  async importSessionToken(token: string, source = "dashboard"): Promise<void> {
    await this.importCookies(source, sessionTokenToCookies(token));
  }

  clearCookies(): void {
    this.db.query("DELETE FROM cursor_cookies WHERE id = 1").run();
    this.authExpired = false;
  }

  hasCookies(): boolean {
    const row = this.db
      .query("SELECT 1 as ok FROM cursor_cookies WHERE id = 1 AND length(jar_encrypted) > 0")
      .get() as { ok: number } | undefined;
    return !!row?.ok;
  }

  async loadCookies(): Promise<CursorCookie[] | null> {
    const key = this.cryptoKey;
    if (!key) return null;

    const row = this.db.query("SELECT jar_encrypted FROM cursor_cookies WHERE id = 1").get() as
      | { jar_encrypted: string }
      | undefined;
    if (!row?.jar_encrypted) return null;

    try {
      return await decryptCookieJar(row.jar_encrypted, key);
    } catch (err) {
      this.logger.error(`Failed to decrypt cursor cookies: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private buildCookieHeader(cookies: CursorCookie[]): string {
    return cookies.map((c) => `${encodeURIComponent(c.name)}=${encodeURIComponent(c.value)}`).join("; ");
  }

  private async cursorFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return fetch(input, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://cursor.com",
        referer: "https://cursor.com/",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(init?.headers || {}),
      },
    });
  }

  private async fetchUsageSummary(cookies: CursorCookie[]): Promise<void> {
    const res = await this.cursorFetch(CURSOR_USAGE_SUMMARY_URL, {
      method: "GET",
      headers: { cookie: this.buildCookieHeader(cookies) },
    });
    if (!res.ok) {
      throw new CursorApiError(res.status, `usage-summary failed: ${res.status} ${await res.text()}`);
    }
  }

  private async fetchUsageEvents(
    cookies: CursorCookie[],
    page: number,
    startDate: string,
    endDate: string,
  ): Promise<CursorUsageEventsResponse> {
    const res = await this.cursorFetch(CURSOR_USAGE_EVENTS_URL, {
      method: "POST",
      headers: { cookie: this.buildCookieHeader(cookies) },
      body: JSON.stringify({
        page,
        pageSize: PAGE_SIZE,
        startDate,
        endDate,
      }),
    });
    if (!res.ok) {
      throw new CursorApiError(res.status, `usage-events failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as CursorUsageEventsResponse;
  }

  private timeRangeForSync(): { startDate: string; endDate: string; range_start: string; range_end: string } {
    const now = new Date();
    const monthStart = resolveStatsRange("month").from as string;
    const start = new Date(monthStart);
    const end = now;
    return {
      startDate: String(start.getTime()),
      endDate: String(end.getTime()),
      range_start: start.toISOString(),
      range_end: end.toISOString(),
    };
  }

  /**
   * 按 Hook turn 活动区间生成拉取窗口（每轮向前 lookback + 前后 padding，重叠则合并）。
   * 不用 session 起止整段跨度，避免长开会话一次拉几天/几周的 Usage。
   */
  sessionTimeRangesMs(sessionIds: string[]): Array<{ startDate: string; endDate: string }> {
    if (!sessionIds.length) return [];

    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db.query(`
      SELECT id, started_at, ended_at FROM sessions
      WHERE agent = 'cursor' AND id IN (${placeholders})
    `).all(...sessionIds) as Array<{ id: string; started_at: string; ended_at: string | null }>;

    if (!rows.length) return [];

    const padBeforeMs = 10 * 60 * 1000;
    const padAfterMs = 5 * 60 * 1000;
    const lookbackMs = MAX_TURN_LOOKBACK_SEC * 1000;
    const windows: Array<{ start: number; end: number }> = [];

    for (const row of rows) {
      const turns = this.db.query(`
        SELECT created_at FROM turns
        WHERE session_id = ? AND provider = 'cursor' AND id NOT LIKE 'cursor-usage-%'
        ORDER BY created_at ASC
      `).all(row.id) as Array<{ created_at: string }>;

      if (turns.length) {
        for (const turn of turns) {
          const t = new Date(turn.created_at).getTime();
          if (!Number.isFinite(t)) continue;
          windows.push({ start: t - lookbackMs - padBeforeMs, end: t + padAfterMs });
        }
        continue;
      }

      // 尚无 turn：只拉 session 起点附近一小段，等 turn 到来再扩
      const s = new Date(row.started_at).getTime();
      if (!Number.isFinite(s)) continue;
      const e = row.ended_at ? new Date(row.ended_at).getTime() : s + padAfterMs;
      windows.push({
        start: s - padBeforeMs,
        end: (Number.isFinite(e) ? e : s) + padAfterMs,
      });
    }

    if (!windows.length) return [];

    windows.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [windows[0]!];
    for (let i = 1; i < windows.length; i++) {
      const cur = windows[i]!;
      const last = merged[merged.length - 1]!;
      if (cur.start <= last.end) {
        last.end = Math.max(last.end, cur.end);
      } else {
        merged.push(cur);
      }
    }

    return merged.map((w) => ({
      startDate: String(Math.max(0, w.start)),
      endDate: String(w.end),
    }));
  }

  /** 兼容单窗口调用：返回合并后的总起止（仅测试/摘要用；拉账单请用 sessionTimeRangesMs） */
  sessionTimeRangeMs(sessionIds: string[]): { startDate: string; endDate: string } | null {
    const ranges = this.sessionTimeRangesMs(sessionIds);
    if (!ranges.length) return null;
    return {
      startDate: ranges[0]!.startDate,
      endDate: ranges[ranges.length - 1]!.endDate,
    };
  }

  resolveCursorSessionIds(sessionIds: string[]): string[] {
    if (!sessionIds.length) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db.query(`
      SELECT id FROM sessions WHERE agent = 'cursor' AND id IN (${placeholders})
    `).all(...sessionIds) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private canSync(): boolean {
    return this.isEnabled() && this.hasCookies() && !this.authExpired;
  }

  private recordEvent(ev: CursorUsageEvent): boolean {
    const eventId = usageEventId(ev);
    const exists = this.db
      .query("SELECT 1 FROM cursor_usage_events WHERE event_id = $id")
      .get({ $id: eventId });
    if (exists) return false;

    const tokenUsage = ev.tokenUsage || {};
    const tsSec = parseEventTimestamp(ev.timestamp);
    this.db.query(`
      INSERT INTO cursor_usage_events (
        event_id, timestamp, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        cost_usd_cents, is_chargeable, is_headless, raw_json, synced_at
      )
      VALUES (
        $event_id, $timestamp, $model,
        $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $reasoning_tokens,
        $cost_usd_cents, $is_chargeable, $is_headless, $raw_json, $synced_at
      )
    `).run({
      $event_id: eventId,
      $timestamp: tsSec,
      $model: ev.model || "unknown",
      $input_tokens: tokenUsage.inputTokens ?? 0,
      $output_tokens: tokenUsage.outputTokens ?? 0,
      $cache_read_tokens: tokenUsage.cacheReadTokens ?? 0,
      $cache_write_tokens: tokenUsage.cacheWriteTokens ?? 0,
      $reasoning_tokens: 0,
      $cost_usd_cents: Math.round(ev.chargedCents ?? 0),
      $is_chargeable: ev.isChargeable ? 1 : 0,
      $is_headless: ev.isHeadless ? 1 : 0,
      $raw_json: JSON.stringify(ev),
      $synced_at: toIso(Date.now()),
    });
    return true;
  }

  private createJob(rangeStart: string, rangeEnd: string): number {
    this.db.query(`
      INSERT INTO cursor_sync_jobs (started_at, status, events_count, range_start, range_end)
      VALUES ($started_at, $status, $events_count, $range_start, $range_end)
    `).run({
      $started_at: toIso(Date.now()),
      $status: "running",
      $events_count: 0,
      $range_start: rangeStart,
      $range_end: rangeEnd,
    });
    const row = this.db.query("SELECT seq FROM sqlite_sequence WHERE name = 'cursor_sync_jobs'").get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  private updateJob(
    id: number,
    status: CursorSyncJob["status"],
    eventsCount: number,
    error?: string,
  ): void {
    this.db.query(`
      UPDATE cursor_sync_jobs
      SET finished_at = $finished_at, status = $status, events_count = $events_count, error = $error
      WHERE id = $id
    `).run({
      $finished_at: toIso(Date.now()),
      $status: status,
      $events_count: eventsCount,
      $error: error ?? null,
      $id: id,
    });
  }

  private backoffFor(status: number): number {
    if (status === 429 || status >= 500) {
      return BACKOFF_MINUTES[Math.min(this.failures, BACKOFF_MINUTES.length - 1)];
    }
    return 0;
  }

  /** 拉取 Cursor 用量并对账到 Hook 会话（全量，定时任务用） */
  async sync(): Promise<CursorSyncJob> {
    if (!this.isEnabled()) {
      throw new Error("Cursor 同步未启用或服务端未配置加密密钥");
    }
    if (this.fullSyncRunning) {
      throw new Error("Cursor sync is already running");
    }
    if (this.authExpired) {
      throw new Error("Cursor 登录已过期，请在 Dashboard 重新配置 Session Token");
    }
    if (this.nextRetryAt && Date.now() < this.nextRetryAt.getTime()) {
      throw new Error(`Cursor sync backing off until ${this.nextRetryAt.toISOString()}`);
    }

    const cookies = await this.loadCookies();
    if (!cookies) {
      throw new Error("尚未配置 Cursor Session Token");
    }

    this.fullSyncRunning = true;
    const { startDate, endDate, range_start, range_end } = this.timeRangeForSync();
    const jobId = this.createJob(range_start, range_end);
    let eventsCount = 0;

    try {
      await this.fetchUsageSummary(cookies);
      eventsCount = await this.pullUsageEvents(cookies, startDate, endDate);
      const monthStart = resolveStatsRange("month").from as string;
      const enqueued = enqueueRecentCursorSessions(this.db, monthStart);
      const enriched = await this.processSyncQueue();
      this.updateJob(jobId, "success", eventsCount);
      this.failures = 0;
      this.nextRetryAt = undefined;
      this.authExpired = false;
      this.logger.info(`Cursor sync ok: new=${eventsCount}, enqueued=${enqueued}, enriched=${enriched}`);
      return this.getJob(jobId)!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof CursorApiError ? err.status : 0;
      this.updateJob(jobId, "failed", eventsCount, message);
      this.handleSyncError(status);
      throw err;
    } finally {
      this.fullSyncRunning = false;
    }
  }

  /** 串行处理对账队列：先拉该会话时间窗账单，再按 Hook 归属补充 cost */
  async processSyncQueue(): Promise<number> {
    if (!this.canSync()) return 0;
    if (this.nextRetryAt && Date.now() < this.nextRetryAt.getTime()) return 0;
    if (this.queueProcessing) return 0;

    const cookies = await this.loadCookies();
    if (!cookies) return 0;

    this.queueProcessing = true;
    let totalEnriched = 0;

    try {
      await this.fetchUsageSummary(cookies);

      while (true) {
        const next = dequeueNextPending(this.db);
        if (!next) break;

        const sessionId = next.session_id;
        markQueueSyncing(this.db, sessionId);

        try {
          const ranges = this.sessionTimeRangesMs([sessionId]);
          for (const range of ranges) {
            await this.pullUsageEvents(cookies, range.startDate, range.endDate);
          }
          totalEnriched += enrichSessionUsage(this.db, sessionId, this.logger);
          markQueueDone(this.db, sessionId);
          requeueSessionIfNeeded(this.db, sessionId);
          this.failures = 0;
          this.authExpired = false;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = err instanceof CursorApiError ? err.status : 0;
          markQueueFailed(this.db, sessionId, message);
          this.handleSyncError(status);
          this.logger.error(`Cursor queue sync failed for ${sessionId}: ${message}`);
          break;
        }
      }

      if (totalEnriched > 0) {
        this.logger.info(`Cursor queue processed: enriched=${totalEnriched}, pending=${countPendingQueue(this.db)}`);
      }
      return totalEnriched;
    } finally {
      this.queueProcessing = false;
      if (hasPendingQueue(this.db)) {
        this.scheduleSyncQueue(0);
      }
    }
  }

  private async pullUsageEvents(
    cookies: CursorCookie[],
    startDate: string,
    endDate: string,
  ): Promise<number> {
    let eventsCount = 0;
    let page = 1;
    let hasMore = true;
    let fetchedTotal = 0;

    while (hasMore && page <= MAX_PAGES) {
      const data = await this.fetchUsageEvents(cookies, page, startDate, endDate);
      const events = data.usageEventsDisplay || [];
      if (!events.length) break;

      for (const ev of events) {
        if (this.recordEvent(ev)) eventsCount++;
      }

      fetchedTotal += events.length;
      const total = data.totalUsageEventsCount ?? 0;
      hasMore = fetchedTotal < total && events.length === PAGE_SIZE;
      page++;
    }

    return eventsCount;
  }

  private handleSyncError(status: number): void {
    if (status === 401 || status === 403) {
      this.authExpired = true;
      return;
    }
    const backoff = this.backoffFor(status || 500);
    if (backoff) {
      this.failures = Math.min(this.failures + 1, BACKOFF_MINUTES.length);
      this.nextRetryAt = new Date(Date.now() + backoff * 60 * 1000);
    }
  }

  /** ingest 后：会话入队 + debounce 触发串行对账 */
  scheduleSyncAfterIngest(sessionIds: string[] = []): void {
    if (!this.canSync()) return;

    const cursorIds = this.resolveCursorSessionIds(sessionIds);
    if (!cursorIds.length) return;

    enqueueCursorSessions(this.db, cursorIds);
    this.scheduleSyncQueue();
  }

  private scheduleSyncQueue(delayMs = INGEST_DEBOUNCE_MS): void {
    if (!this.canSync()) return;
    if (this.ingestDebounceTimer) clearTimeout(this.ingestDebounceTimer);
    this.ingestDebounceTimer = setTimeout(() => {
      this.ingestDebounceTimer = null;
      this.processSyncQueue().catch(() => {});
    }, delayMs);
  }

  private getJob(id: number): CursorSyncJob | undefined {
    return this.db.query("SELECT * FROM cursor_sync_jobs WHERE id = $id").get({ $id: id }) as
      | CursorSyncJob
      | undefined;
  }

  getStatus(): CursorSyncStatus {
    const total = this.db.query("SELECT COUNT(*) as c FROM cursor_usage_events").get() as { c: number };
    const pending = this.db
      .query("SELECT COUNT(*) as c FROM cursor_usage_events WHERE enriched_at IS NULL")
      .get() as { c: number };
    const lastJob = this.db
      .query("SELECT * FROM cursor_sync_jobs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1")
      .get() as CursorSyncJob | undefined;
    const lastFailed = this.db
      .query("SELECT * FROM cursor_sync_jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 1")
      .get() as CursorSyncJob | undefined;

    const hasCryptoKey = !!this.cryptoKey;
    const hasCookies = this.hasCookies();
    let setupError: string | null = null;
    if (this.cfg.cursorSyncEnabled && !hasCryptoKey) {
      setupError = "服务端未配置 AGENT_TRACKER_CURSOR_CRYPTO_KEY";
    }

    return {
      enabled: this.cfg.cursorSyncEnabled,
      hasCryptoKey,
      hasCookies,
      available: this.isEnabled() && hasCookies && !this.authExpired,
      syncing: this.fullSyncRunning || this.queueProcessing,
      authExpired: this.authExpired,
      lastSuccessAt: lastJob?.finished_at ?? null,
      lastError: lastFailed?.error ?? setupError,
      nextRetryAt: this.nextRetryAt?.toISOString() ?? null,
      totalEvents: total.c,
      pendingEnrich: pending.c,
      pendingQueue: countPendingQueue(this.db),
    };
  }
}

class CursorApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
