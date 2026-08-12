/**
 * Hook 本地文件队列 + 单飞上报 worker
 *
 * Hook 进程只负责把事件 append 到队列并拉起 worker，然后立刻 exit。
 * 真正的 Debounce / ingest 在独立 detached 进程里跑，避免宿主等 exit 时被拖死，
 * 也避免进程组回收把「假后台」子进程一起杀掉。
 *
 * 同一时间全局只允许一个 worker（worker.lock）；新事件只追加文件，由现有 worker 消费。
 *
 * 生命周期 / 资源约束：
 * - worker 空闲退出；退出前再扫一次 pending，避免 idle 与入队竞态丢任务
 * - claim 分批，避免一次把海量 pending 读进内存
 * - 单 job JSON 体积上限，防止超大 prompt 撑爆 worker
 * - spawn detached + unref：hook 不等待子进程，不会留下僵尸（zombie）
 * - 抢锁失败的多余 worker 立刻 exit，不会常驻
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ClaudeHookInput } from "./transform";

/** 单次 claim 最多读入内存的 pending 文件数（防 OOM） */
export const MAX_CLAIM_BATCH = 32;

/** 单条队列 job 序列化后的最大字节数；超出则截断大字段 */
export const MAX_JOB_JSON_BYTES = 256 * 1024;

/** 可能很大的 hook 字段（截断用） */
const LARGE_INPUT_KEYS = [
  "prompt",
  "last_assistant_message",
  "tool_input",
  "tool_response",
  "content",
  "error",
  "error_message",
] as const;

export interface QueuedHookJob {
  id: string;
  enqueued_at: string;
  event_type: string;
  runtime_arg?: string;
  input: ClaudeHookInput;
}

export interface EnqueueOptions {
  eventType: string;
  runtimeArg?: string;
  input: ClaudeHookInput;
  /** 测试可注入 */
  queueDir?: string;
  /** 测试可注入体积上限 */
  maxJobBytes?: number;
}

function defaultQueueDir(): string {
  return join(homedir(), ".config", "agent-tracker", "claude-compat-queue");
}

/** 队列根目录：pending/、worker.lock */
export function resolveQueueDir(override?: string): string {
  return override ?? defaultQueueDir();
}

function ensureDirs(queueDir: string): { pendingDir: string; lockPath: string } {
  const pendingDir = join(queueDir, "pending");
  mkdirSync(pendingDir, { recursive: true });
  return { pendingDir, lockPath: join(queueDir, "worker.lock") };
}

/** 单调序号，保证同毫秒内文件名按入队顺序排序 */
let jobSeq = 0;

function jobFileName(): string {
  jobSeq = (jobSeq + 1) % 1_000_000;
  const ms = Date.now();
  const seq = String(jobSeq).padStart(6, "0");
  const rand = randomBytes(3).toString("hex");
  return `${ms}-${seq}-${rand}.json`;
}

/** 截断字符串，避免单字段撑爆队列文件 */
function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

/**
 * 控制单 job 体积：先截断已知大字段，仍超限则整体 JSON 硬截断标记。
 * 上报侧主要靠 transcript 补全，hook stdin 正文可丢。
 */
export function sanitizeJobInput(
  input: ClaudeHookInput,
  maxBytes: number = MAX_JOB_JSON_BYTES,
): ClaudeHookInput {
  const clone = { ...(input as Record<string, unknown>) };
  const perField = Math.max(1024, Math.floor(maxBytes / 4));

  for (const key of LARGE_INPUT_KEYS) {
    const v = clone[key];
    if (typeof v === "string" && v.length > perField) {
      clone[key] = truncateString(v, perField);
    } else if (v && typeof v === "object") {
      try {
        const s = JSON.stringify(v);
        if (s.length > perField) {
          clone[key] = truncateString(s, perField);
        }
      } catch {
        delete clone[key];
      }
    }
  }

  let json = JSON.stringify(clone);
  if (Buffer.byteLength(json, "utf-8") <= maxBytes) {
    return clone as ClaudeHookInput;
  }

  // 仍超限：只保留上报必需的小字段
  const minimal: Record<string, unknown> = {
    session_id: clone.session_id,
    hook_event_name: clone.hook_event_name,
    transcript_path: clone.transcript_path,
    cwd: clone.cwd,
    source: clone.source,
    tool_name: clone.tool_name,
    _queue_truncated: true,
  };
  json = JSON.stringify(minimal);
  if (Buffer.byteLength(json, "utf-8") > maxBytes) {
    minimal.transcript_path = undefined;
    minimal.cwd = undefined;
  }
  return minimal as ClaudeHookInput;
}

/** 追加一条 hook 事件到 pending/（原子 write 单文件） */
export function enqueueHookJob(opts: EnqueueOptions): QueuedHookJob {
  const queueDir = resolveQueueDir(opts.queueDir);
  const { pendingDir } = ensureDirs(queueDir);
  const maxBytes = opts.maxJobBytes ?? MAX_JOB_JSON_BYTES;
  const job: QueuedHookJob = {
    id: randomBytes(8).toString("hex"),
    enqueued_at: new Date().toISOString(),
    event_type: opts.eventType,
    runtime_arg: opts.runtimeArg,
    input: sanitizeJobInput(opts.input, maxBytes),
  };
  const path = join(pendingDir, jobFileName());
  // 先写 tmp 再 rename，避免 worker 读到半截 JSON
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job)}\n`, "utf-8");
  renameSync(tmp, path);
  return job;
}

/** 进程是否仍存活（用于清理陈旧 lock） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试获取 worker 单飞锁。
 * 成功返回 lock fd；已有存活 worker 则返回 null。
 */
export function tryAcquireWorkerLock(queueDir?: string): number | null {
  const { lockPath } = ensureDirs(resolveQueueDir(queueDir));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch {
      // lock 已存在：若 pid 已死则清掉重试
      try {
        const raw = readFileSync(lockPath, "utf-8").trim();
        const pid = Number(raw.split(/\s/)[0]);
        if (!isPidAlive(pid)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

export function releaseWorkerLock(fd: number, queueDir?: string): void {
  const { lockPath } = ensureDirs(resolveQueueDir(queueDir));
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** 列出 pending 任务（按文件名时间序）；可限制条数 */
export function listPendingJobs(
  queueDir?: string,
  limit: number = Number.POSITIVE_INFINITY,
): Array<{ path: string; job: QueuedHookJob }> {
  const { pendingDir } = ensureDirs(resolveQueueDir(queueDir));
  const names = readdirSync(pendingDir)
    .filter((n) => n.endsWith(".json") && !n.endsWith(".tmp"))
    .sort();
  const out: Array<{ path: string; job: QueuedHookJob }> = [];
  for (const name of names) {
    if (out.length >= limit) break;
    const path = join(pendingDir, name);
    try {
      const job = JSON.parse(readFileSync(path, "utf-8")) as QueuedHookJob;
      if (job?.event_type && job?.input) out.push({ path, job });
    } catch {
      // 坏文件丢掉，避免卡死队列
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** pending 文件数量（不含 .tmp） */
export function countPendingJobs(queueDir?: string): number {
  const { pendingDir } = ensureDirs(resolveQueueDir(queueDir));
  return readdirSync(pendingDir).filter((n) => n.endsWith(".json") && !n.endsWith(".tmp")).length;
}

/**
 * 认领并删除最多 maxBatch 条 pending（已读入内存）。
 * 分批认领，避免一次加载整队列导致内存尖峰。
 */
export function claimPendingJobs(
  queueDir?: string,
  maxBatch: number = MAX_CLAIM_BATCH,
): QueuedHookJob[] {
  const listed = listPendingJobs(queueDir, maxBatch);
  const jobs: QueuedHookJob[] = [];
  for (const { path, job } of listed) {
    try {
      unlinkSync(path);
      jobs.push(job);
    } catch {
      // 被别人抢走则跳过
    }
  }
  return jobs;
}

/**
 * 合并同 session 的 stop / session-end：只保留每种 event_type 的最后一条。
 * 其它事件按入队顺序原样保留（session-start / user-prompt 等需全量）。
 */
export function coalesceQueuedJobs(jobs: QueuedHookJob[]): QueuedHookJob[] {
  const result: QueuedHookJob[] = [];
  const lastStopByKey = new Map<string, number>(); // key -> index in result

  for (const job of jobs) {
    const isStopLike = job.event_type === "stop" || job.event_type === "session-end";
    if (!isStopLike) {
      result.push(job);
      continue;
    }
    const sid = job.input?.session_id ?? "";
    const key = `${sid}::${job.event_type}`;
    const prevIdx = lastStopByKey.get(key);
    if (prevIdx === undefined) {
      lastStopByKey.set(key, result.length);
      result.push(job);
    } else {
      result[prevIdx] = job;
    }
  }
  return result;
}

export interface EnsureWorkerOptions {
  /** bun 可执行文件 */
  bunBin?: string;
  /** index.mjs 绝对路径 */
  scriptPath: string;
  queueDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试可注入 spawn */
  spawnFn?: typeof spawn;
}

/**
 * 若当前没有存活 worker，则 spawn 真正 detached 的独立进程。
 * 已有 worker 时只依赖文件队列追加，不再起第二个。
 *
 * 并发下可能短暂多 spawn：多余进程抢锁失败后立刻 exit，不会常驻 / 不会变僵尸
 *（stdio:ignore + detached + unref，父进程不 wait）。
 */
export function ensureQueueWorker(opts: EnsureWorkerOptions): "spawned" | "already_running" {
  const queueDir = resolveQueueDir(opts.queueDir);
  ensureDirs(queueDir);

  // 快速探测：lock 存在且 pid 存活 → 不重复拉起
  const lockPath = join(queueDir, "worker.lock");
  if (existsSync(lockPath)) {
    try {
      const pid = Number(readFileSync(lockPath, "utf-8").trim().split(/\s/)[0]);
      if (isPidAlive(pid)) return "already_running";
      unlinkSync(lockPath);
    } catch {
      /* 继续尝试 spawn；worker 侧会再抢锁 */
    }
  }

  const bunBin = opts.bunBin ?? process.execPath;
  const args = [opts.scriptPath, "--worker"];
  if (opts.queueDir) {
    args.push("--queue-dir", opts.queueDir);
  }

  const spawnImpl = opts.spawnFn ?? spawn;
  const child = spawnImpl(bunBin, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...(opts.env ?? process.env),
      AGENT_TRACKER_CLAUDE_COMPAT_QUEUE_DIR: queueDir,
    },
  });
  // 不挂父进程；hook exit 后子进程由 init 收养，不会变成僵尸
  child.unref();
  return "spawned";
}

export interface RunWorkerOptions {
  queueDir?: string;
  /** 处理单条任务 */
  handleJob: (job: QueuedHookJob) => Promise<void>;
  /** 空闲多久退出（ms）；默认 2s，给 Debounce 期间新入队留窗口 */
  idleExitMs?: number;
  /** 轮询间隔 */
  pollMs?: number;
  /** 单次 claim 上限 */
  maxClaimBatch?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { debug(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
}

/**
 * Worker 主循环：抢锁 → 分批消费 pending → 空闲退出并放锁。
 * Debounce 期间若有新文件入队，下一轮会继续吃掉。
 * 退出前再扫一次 pending，降低「idle 判定与入队」竞态丢任务的概率。
 */
export async function runQueueWorker(opts: RunWorkerOptions): Promise<"ok" | "lock_busy"> {
  const queueDir = resolveQueueDir(opts.queueDir);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 200;
  const idleExitMs = opts.idleExitMs ?? 2000;
  const maxClaimBatch = opts.maxClaimBatch ?? MAX_CLAIM_BATCH;

  const lockFd = tryAcquireWorkerLock(queueDir);
  if (lockFd === null) {
    opts.logger?.debug("queue worker lock busy, exit");
    return "lock_busy";
  }

  opts.logger?.debug("queue worker started", { pid: process.pid, queueDir });
  let idleMs = 0;

  const processClaimed = async (claimed: QueuedHookJob[]): Promise<void> => {
    const jobs = coalesceQueuedJobs(claimed);
    opts.logger?.debug("queue worker batch", {
      claimed: claimed.length,
      afterCoalesce: jobs.length,
      types: jobs.map((j) => j.event_type),
    });
    for (const job of jobs) {
      try {
        await opts.handleJob(job);
      } catch (err) {
        opts.logger?.error("queue worker job failed", {
          error: String(err),
          eventType: job.event_type,
          sessionId: job.input?.session_id,
        });
        // 失败不回队，避免毒丸死循环；依赖后续 Stop/SessionEnd 再入队
      }
    }
  };

  try {
    while (true) {
      const claimed = claimPendingJobs(queueDir, maxClaimBatch);
      if (claimed.length === 0) {
        idleMs += pollMs;
        if (idleMs >= idleExitMs) {
          // 退出前最后一扫：挡住 idle 窗口末尾刚入队的任务
          const lastChance = claimPendingJobs(queueDir, maxClaimBatch);
          if (lastChance.length > 0) {
            idleMs = 0;
            await processClaimed(lastChance);
            continue;
          }
          break;
        }
        await sleep(pollMs);
        continue;
      }

      idleMs = 0;
      await processClaimed(claimed);
    }
  } finally {
    releaseWorkerLock(lockFd, queueDir);
    opts.logger?.debug("queue worker exit", { pid: process.pid });
  }

  return "ok";
}
