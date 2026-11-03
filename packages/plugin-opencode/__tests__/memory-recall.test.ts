import { expect, test } from "bun:test";
import { createMemoryRecall } from "../src/memoryRecall";
import { memoryRetrievalMode } from "../src/memoryRetrieval";

test("production defaults to the index branch, not an additional selector", () => {
  expect(memoryRetrievalMode()).toBe("index");
});

test("recall prefetch never blocks, consumes once, and excludes recalled or tool-read facts", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(done => { resolve = done; });
  const requests: any[] = [];
  const recall = createMemoryRecall(async (query, exclude, signal) => { requests.push({ query, exclude, signal }); return pending; });
  recall.start("user-1", "中文发布问题");
  expect(recall.take()).toBeUndefined();
  recall.start("user-1", "同一问题的 continuation");
  expect(requests).toHaveLength(1);
  recall.markRead(["tool-read"]);
  resolve({ items: [{ id: "a", markdown: "FACT_A" }, { id: "a", markdown: "DUPLICATE" }, { id: "tool-read", markdown: "ALREADY_READ" }] });
  await pending; await Bun.sleep(0);
  const content = recall.take();
  expect(content).toContain("FACT_A");
  expect(content).not.toContain("DUPLICATE");
  expect(content).not.toContain("ALREADY_READ");
  expect(recall.take()).toBeUndefined();
  recall.start("user-2", "另一个问题");
  expect(requests[1].exclude.sort()).toEqual(["a", "tool-read"]);
});

test("new queries and cleanup cancel pending selection, and reject late results", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(done => { resolve = done; });
  const signals: AbortSignal[] = [];
  const recall = createMemoryRecall(async (_query, _exclude, signal) => { signals.push(signal); return pending; });
  recall.start("user-1", "旧问题");
  recall.start("user-2", "新问题");
  expect(signals[0].aborted).toBe(true);
  recall.clear();
  expect(signals[1].aborted).toBe(true);
  resolve({ items: [{ id: "late", markdown: "STALE" }] });
  await pending; await Promise.resolve();
  expect(recall.take()).toBeUndefined();
});

test("memory bodies have line and UTF-8 budgets, failures have no keyword fallback", async () => {
  const recall = createMemoryRecall(async () => ({ items: [{ id: "large", markdown: ("中".repeat(50) + "\r\n").repeat(100) }] }));
  recall.start("user", "问题");
  await Promise.resolve(); await Promise.resolve();
  const content = recall.take()!;
  expect(content).toContain("已截断");
  expect(content).not.toContain("�");
  expect(Buffer.byteLength(content)).toBeLessThan(5000);
  const failed = createMemoryRecall(async () => { throw new Error("unavailable"); });
  failed.start("user", "问题");
  await Promise.resolve(); await Promise.resolve();
  expect(failed.take()).toBeUndefined();
});
