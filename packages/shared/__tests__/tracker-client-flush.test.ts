import { afterEach, expect, test } from "bun:test";
import { TrackerClient } from "../src/tracker-client";
import { FileLogger } from "../src/logger";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("explicit flush waits for an automatic in-flight batch containing a memory source", async () => {
  let release!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(String(init?.body));
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  const logger = new FileLogger({ filePath: "/dev/null", enabled: false, component: "test" });
  const client = new TrackerClient("http://localhost:3456", "test", logger, undefined, { flushThreshold: 1 });
  client.push({ type: "message", session_id: "s", message_id: "user", role: "user", content: "请记住这个约定", created_at: "2026-10-29T00:00:00Z" });

  let finished = false;
  const flush = client.flush().then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0]!).events[0].message_id).toBe("user");
  release(Response.json({ ok: true }));
  await flush;
  expect(finished).toBe(true);
  await client.flush();
  expect(requests).toHaveLength(1);
});
