import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import {
  enqueueHookJob,
  claimPendingJobs,
  coalesceQueuedJobs,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  runQueueWorker,
  listPendingJobs,
  countPendingJobs,
  ensureQueueWorker,
  sanitizeJobInput,
  MAX_CLAIM_BATCH,
  type QueuedHookJob,
} from "../src/queue";
import type { ClaudeHookInput } from "../src/transform";

function makeInput(sessionId: string, extra: Record<string, unknown> = {}): ClaudeHookInput {
  return {
    session_id: sessionId,
    hook_event_name: "Stop",
    transcript_path: `/tmp/${sessionId}/history/index.json`,
    ...extra,
  } as ClaudeHookInput;
}

describe("claude-compat queue", () => {
  let queueDir: string;

  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "runmark-queue-"));
  });

  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  it("enqueues jobs as pending files and claims them in order", () => {
    enqueueHookJob({
      eventType: "user-prompt",
      runtimeArg: "codebuddy",
      input: makeInput("s1"),
      queueDir,
    });
    enqueueHookJob({
      eventType: "stop",
      runtimeArg: "codebuddy",
      input: makeInput("s1"),
      queueDir,
    });

    const listed = listPendingJobs(queueDir);
    expect(listed.length).toBe(2);
    expect(listed[0]!.job.event_type).toBe("user-prompt");
    expect(listed[1]!.job.event_type).toBe("stop");

    const claimed = claimPendingJobs(queueDir);
    expect(claimed.map((j) => j.event_type)).toEqual(["user-prompt", "stop"]);
    expect(listPendingJobs(queueDir)).toEqual([]);
  });

  it("coalesces duplicate stop/session-end per session to the latest", () => {
    const jobs: QueuedHookJob[] = [
      {
        id: "1",
        enqueued_at: "t1",
        event_type: "user-prompt",
        input: makeInput("s1"),
      },
      {
        id: "2",
        enqueued_at: "t2",
        event_type: "stop",
        input: { ...makeInput("s1"), cwd: "/old" } as ClaudeHookInput,
      },
      {
        id: "3",
        enqueued_at: "t3",
        event_type: "stop",
        input: { ...makeInput("s1"), cwd: "/new" } as ClaudeHookInput,
      },
      {
        id: "4",
        enqueued_at: "t4",
        event_type: "session-end",
        input: makeInput("s1"),
      },
    ];
    const merged = coalesceQueuedJobs(jobs);
    expect(merged.map((j) => j.event_type)).toEqual(["user-prompt", "stop", "session-end"]);
    expect((merged[1]!.input as { cwd?: string }).cwd).toBe("/new");
  });

  it("worker lock is single-flight; second acquire fails while held", () => {
    const fd = tryAcquireWorkerLock(queueDir);
    expect(fd).not.toBeNull();
    expect(tryAcquireWorkerLock(queueDir)).toBeNull();
    releaseWorkerLock(fd!, queueDir);
    const fd2 = tryAcquireWorkerLock(queueDir);
    expect(fd2).not.toBeNull();
    releaseWorkerLock(fd2!, queueDir);
  });

  it("stale lock (dead pid) can be reclaimed", () => {
    const lockPath = join(queueDir, "worker.lock");
    // 用不存在的 pid 写陈旧锁
    writeFileSync(lockPath, "999999999\n", "utf-8");
    const fd = tryAcquireWorkerLock(queueDir);
    expect(fd).not.toBeNull();
    releaseWorkerLock(fd!, queueDir);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("runQueueWorker drains pending then exits on idle", async () => {
    enqueueHookJob({
      eventType: "session-start",
      input: makeInput("s-drain"),
      queueDir,
    });
    enqueueHookJob({
      eventType: "stop",
      input: makeInput("s-drain"),
      queueDir,
    });

    const handled: string[] = [];
    const status = await runQueueWorker({
      queueDir,
      idleExitMs: 80,
      pollMs: 20,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async (job) => {
        handled.push(job.event_type);
      },
    });

    expect(status).toBe("ok");
    expect(handled).toEqual(["session-start", "stop"]);
    expect(listPendingJobs(queueDir)).toEqual([]);
    expect(existsSync(join(queueDir, "worker.lock"))).toBe(false);
  });

  it("second runQueueWorker returns lock_busy while first holds lock", async () => {
    const fd = tryAcquireWorkerLock(queueDir);
    expect(fd).not.toBeNull();
    const status = await runQueueWorker({
      queueDir,
      idleExitMs: 50,
      pollMs: 10,
      handleJob: async () => {},
    });
    expect(status).toBe("lock_busy");
    releaseWorkerLock(fd!, queueDir);
  });

  it("jobs enqueued during handle are picked up before idle exit", async () => {
    enqueueHookJob({
      eventType: "user-prompt",
      input: makeInput("s-live"),
      queueDir,
    });

    let first = true;
    const handled: string[] = [];
    await runQueueWorker({
      queueDir,
      idleExitMs: 100,
      pollMs: 20,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async (job) => {
        handled.push(job.event_type);
        if (first) {
          first = false;
          enqueueHookJob({
            eventType: "stop",
            input: makeInput("s-live"),
            queueDir,
          });
        }
      },
    });

    expect(handled).toEqual(["user-prompt", "stop"]);
  });

  it("enqueue writes valid JSON job payload", () => {
    const job = enqueueHookJob({
      eventType: "stop",
      runtimeArg: "codebuddy",
      input: makeInput("s-json"),
      queueDir,
    });
    const listed = listPendingJobs(queueDir);
    expect(listed[0]!.job.id).toBe(job.id);
    expect(listed[0]!.job.runtime_arg).toBe("codebuddy");
    // 文件内容可再 parse
    const raw = readFileSync(listed[0]!.path, "utf-8");
    expect(JSON.parse(raw).event_type).toBe("stop");
  });
});

describe("claude-compat queue concurrency & resource safety", () => {
  let queueDir: string;

  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "runmark-queue-c-"));
  });

  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  it("concurrent enqueue keeps all jobs and stable order by filename", async () => {
    const n = 40;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        Promise.resolve().then(() =>
          enqueueHookJob({
            eventType: i % 5 === 0 ? "stop" : "user-prompt",
            input: makeInput(`s-${i}`),
            queueDir,
          }),
        ),
      ),
    );
    expect(countPendingJobs(queueDir)).toBe(n);
    const listed = listPendingJobs(queueDir);
    expect(listed.length).toBe(n);
    // 文件名单调可排序
    const names = readdirSync(join(queueDir, "pending")).filter((f) => f.endsWith(".json")).sort();
    expect(names).toEqual(
      listed.map((x) => x.path.split("/").pop()!),
    );
  });

  it("concurrent tryAcquireWorkerLock: exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () => Promise.resolve().then(() => tryAcquireWorkerLock(queueDir))),
    );
    const winners = results.filter((fd) => fd !== null);
    expect(winners.length).toBe(1);
    releaseWorkerLock(winners[0]!, queueDir);
  });

  it("parallel workers: only one drains; loser exits lock_busy; no leftover lock", async () => {
    for (let i = 0; i < 12; i++) {
      enqueueHookJob({
        eventType: "user-prompt",
        input: makeInput(`par-${i}`),
        queueDir,
      });
    }

    const handledA: string[] = [];
    const handledB: string[] = [];

    const [statusA, statusB] = await Promise.all([
      runQueueWorker({
        queueDir,
        idleExitMs: 60,
        pollMs: 15,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        handleJob: async (job) => {
          handledA.push(job.input.session_id);
          // 模拟慢 ingest，拉长持锁窗口
          await new Promise((r) => setTimeout(r, 5));
        },
      }),
      runQueueWorker({
        queueDir,
        idleExitMs: 60,
        pollMs: 15,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        handleJob: async (job) => {
          handledB.push(job.input.session_id);
        },
      }),
    ]);

    const statuses = [statusA, statusB].sort();
    expect(statuses).toEqual(["lock_busy", "ok"]);
    // 全部由赢家处理；两方合计不重复
    const all = [...handledA, ...handledB];
    expect(all.length).toBe(12);
    expect(new Set(all).size).toBe(12);
    expect(countPendingJobs(queueDir)).toBe(0);
    expect(existsSync(join(queueDir, "worker.lock"))).toBe(false);
  });

  it("claimPendingJobs respects max batch to bound memory", () => {
    for (let i = 0; i < MAX_CLAIM_BATCH + 10; i++) {
      enqueueHookJob({
        eventType: "user-prompt",
        input: makeInput(`batch-${i}`),
        queueDir,
      });
    }
    const first = claimPendingJobs(queueDir, MAX_CLAIM_BATCH);
    expect(first.length).toBe(MAX_CLAIM_BATCH);
    expect(countPendingJobs(queueDir)).toBe(10);
    const second = claimPendingJobs(queueDir, MAX_CLAIM_BATCH);
    expect(second.length).toBe(10);
    expect(countPendingJobs(queueDir)).toBe(0);
  });

  it("worker drains oversized backlog in multiple claim batches", async () => {
    const total = MAX_CLAIM_BATCH * 2 + 5;
    for (let i = 0; i < total; i++) {
      enqueueHookJob({
        eventType: "user-prompt",
        input: makeInput(`big-${i}`),
        queueDir,
      });
    }
    let handled = 0;
    await runQueueWorker({
      queueDir,
      idleExitMs: 50,
      pollMs: 10,
      maxClaimBatch: MAX_CLAIM_BATCH,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async () => {
        handled++;
      },
    });
    expect(handled).toBe(total);
    expect(countPendingJobs(queueDir)).toBe(0);
  });

  it("sanitizeJobInput truncates huge prompt under max bytes", () => {
    const huge = "x".repeat(500_000);
    const out = sanitizeJobInput(makeInput("big", { prompt: huge }), 8_192);
    const json = JSON.stringify(out);
    expect(Buffer.byteLength(json, "utf-8")).toBeLessThanOrEqual(8_192);
    expect(String((out as { prompt?: string }).prompt ?? "").length).toBeLessThan(huge.length);
  });

  it("enqueue truncates oversized tool_response so pending file stays small", () => {
    const huge = "y".repeat(400_000);
    enqueueHookJob({
      eventType: "post-tool-use",
      input: makeInput("tool-big", { tool_response: huge, tool_name: "Bash" }),
      queueDir,
      maxJobBytes: 16_384,
    });
    const listed = listPendingJobs(queueDir);
    expect(listed.length).toBe(1);
    const size = Buffer.byteLength(readFileSync(listed[0]!.path), "utf-8");
    expect(size).toBeLessThan(20_000);
  });

  it("coalesce collapses burst of stop events under concurrent enqueue", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          enqueueHookJob({
            eventType: "stop",
            input: makeInput("same-session", { cwd: `/v${i}` }),
            queueDir,
          }),
        ),
      ),
    );
    const claimed = claimPendingJobs(queueDir, 100);
    const merged = coalesceQueuedJobs(claimed);
    expect(merged.length).toBe(1);
    expect(merged[0]!.event_type).toBe("stop");
  });

  it("ensureQueueWorker returns already_running when lock pid is alive", () => {
    const fd = tryAcquireWorkerLock(queueDir);
    expect(fd).not.toBeNull();
    const spawnFn = mock(() => {
      throw new Error("should not spawn");
    });
    const status = ensureQueueWorker({
      scriptPath: "/tmp/fake-index.mjs",
      queueDir,
      spawnFn: spawnFn as never,
    });
    expect(status).toBe("already_running");
    expect(spawnFn).not.toHaveBeenCalled();
    releaseWorkerLock(fd!, queueDir);
  });

  it("ensureQueueWorker spawns detached+unref and does not wait on child", () => {
    const unref = mock(() => {});
    const spawnFn = mock(() => {
      return { unref, pid: 12345 } as unknown as ChildProcess;
    });
    const status = ensureQueueWorker({
      scriptPath: "/tmp/fake-index.mjs",
      queueDir,
      spawnFn: spawnFn as never,
    });
    expect(status).toBe("spawned");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const call = spawnFn.mock.calls[0]!;
    const opts = call[2] as { detached?: boolean; stdio?: string };
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(unref).toHaveBeenCalled();
  });

  it("does not lose jobs enqueued during idle polling (race with exit)", async () => {
    // 空队列进入 idle；sleep 期间入队，必须在 exit 前被消费（正常 claim 或 last-chance）
    let polls = 0;
    const handled: string[] = [];
    const sleep = async (ms: number) => {
      polls++;
      if (polls === 1) {
        enqueueHookJob({
          eventType: "stop",
          input: makeInput("late"),
          queueDir,
        });
      }
      await new Promise((r) => setTimeout(r, ms));
    };

    await runQueueWorker({
      queueDir,
      idleExitMs: 80,
      pollMs: 20,
      sleep,
      handleJob: async (job) => {
        handled.push(job.event_type);
      },
    });

    expect(handled).toEqual(["stop"]);
    expect(countPendingJobs(queueDir)).toBe(0);
  });

  it("failed handleJob does not poison the queue or leave lock", async () => {
    enqueueHookJob({ eventType: "user-prompt", input: makeInput("ok1"), queueDir });
    enqueueHookJob({ eventType: "user-prompt", input: makeInput("boom"), queueDir });
    enqueueHookJob({ eventType: "user-prompt", input: makeInput("ok2"), queueDir });

    const handled: string[] = [];
    await runQueueWorker({
      queueDir,
      idleExitMs: 40,
      pollMs: 10,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async (job) => {
        if (job.input.session_id === "boom") throw new Error("ingest down");
        handled.push(job.input.session_id);
      },
    });

    expect(handled).toEqual(["ok1", "ok2"]);
    expect(countPendingJobs(queueDir)).toBe(0);
    expect(existsSync(join(queueDir, "worker.lock"))).toBe(false);
  });

  it("after winner exits, a new worker can acquire lock again", async () => {
    enqueueHookJob({ eventType: "user-prompt", input: makeInput("w1"), queueDir });
    await runQueueWorker({
      queueDir,
      idleExitMs: 30,
      pollMs: 10,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async () => {},
    });
    expect(existsSync(join(queueDir, "worker.lock"))).toBe(false);

    enqueueHookJob({ eventType: "stop", input: makeInput("w2"), queueDir });
    const handled: string[] = [];
    const status = await runQueueWorker({
      queueDir,
      idleExitMs: 30,
      pollMs: 10,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      handleJob: async (job) => {
        handled.push(job.event_type);
      },
    });
    expect(status).toBe("ok");
    expect(handled).toEqual(["stop"]);
  });
});
