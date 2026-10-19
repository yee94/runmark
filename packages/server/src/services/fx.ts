import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { USD_TO_CNY } from "@agent-tracker/shared";

/**
 * USD→CNY 展示汇率。算法对齐 Magpie internal/fx：
 * 向 open.er-api.com 要 rates.CNY，缓存 12 小时；
 * 失败则用上次的数，再没有才退回 USD_TO_CNY。
 * 请求路径只读内存，不站在网络上。
 */

const RATE_URL_DEFAULT = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FETCH_MS = 8_000;

type Snapshot = { rate: number; at: string };

let rateUrl = RATE_URL_DEFAULT;
let mem: Snapshot | null = null;
let failedAt = 0;
let cachePath = "";
let started = false;
let refreshing: Promise<void> | null = null;

export function fxCachePathForDb(dbPath: string): string {
  if (!dbPath || dbPath === ":memory:") return "";
  return `${dirname(dbPath)}/fxrate.json`;
}

/** 当前展示汇率。未拉到过实时数时是 USD_TO_CNY。 */
export function getUsdToCny(): number {
  if (started) void refreshIfStale();
  return mem && mem.rate > 0 ? mem.rate : USD_TO_CNY;
}

/** 进程启动时调用：先读缓存，过期再后台拉。测试不要调，以免打到网络。 */
export function startFxRefresh(path: string): void {
  cachePath = path;
  started = true;
  const cached = readCache(path);
  if (cached) mem = cached;
  void refreshIfStale();
}

export function setFxRateUrlForTests(url: string): () => void {
  const prev = rateUrl;
  rateUrl = url;
  return () => {
    rateUrl = prev;
  };
}

export function resetFxForTests(): void {
  mem = null;
  failedAt = 0;
  cachePath = "";
  started = false;
  refreshing = null;
  rateUrl = RATE_URL_DEFAULT;
}

/** 等启动时那次后台拉取结束。测试用。 */
export function fxRefreshSettled(): Promise<void> {
  return refreshing ?? Promise.resolve();
}

async function refreshIfStale(): Promise<void> {
  if (mem && Date.now() - Date.parse(mem.at) < TTL_MS) return;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return;
  if (refreshing) return refreshing;
  refreshing = fetchAndStore().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function fetchAndStore(): Promise<void> {
  try {
    const rate = await fetchLive();
    const next = { rate, at: new Date().toISOString() };
    mem = next;
    failedAt = 0;
    writeCache(cachePath, next);
  } catch {
    failedAt = Date.now();
  }
}

async function fetchLive(): Promise<number> {
  const res = await fetch(rateUrl, {
    headers: { "User-Agent": "runmark" },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new Error(`${rateUrl}: ${res.status}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  const cny = body.rates?.CNY;
  if (typeof cny !== "number" || !(cny > 0)) {
    throw new Error(`${rateUrl}: no CNY rate`);
  }
  return cny;
}

function readCache(path: string): Snapshot | null {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    if (!parsed || !(parsed.rate > 0) || !parsed.at || Number.isNaN(Date.parse(parsed.at))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, snapshot: Snapshot): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(snapshot));
  } catch {
    // 缓存写失败不影响展示，下次再拉
  }
}
