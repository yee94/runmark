import { expect, test } from "bun:test";
import { setupAgentTrackerV2 } from "../src/plugin-v2";
import type { OpenCode2Event } from "../src/opencode2-events";
import type { IngestEvent } from "@agent-tracker/shared";

test("V2 telemetry persists the reported Agent across plugin reloads", async () => {
  const stored = new Map<string, string>();
  let received: IngestEvent[] = [];
  let complete = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { events: IngestEvent[] };
      received.push(...body.events);
      if (received.length >= 3) complete.resolve();
      return Response.json({ ingested: body.events.length, errors: [] });
    },
  });
  const run = async (events: OpenCode2Event[]) => {
    received = [];
    complete = Promise.withResolvers<void>();
    const dispose = await setupAgentTrackerV2({
      location: { directory: "/runmark-agent-test" },
      options: { endpoint: server.url.origin, apiKey: "test", memoryEnabled: false },
      storage: {
        get: async key => stored.get(key),
        set: async (key, value) => { stored.set(key, value); },
      },
      session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/runmark-agent-test" } }) },
      event: {
        async *subscribe() { for (const event of events) yield event; },
      },
    });
    try {
      await complete.promise;
      return [...received];
    } finally {
      dispose?.();
    }
  };
  const event = (type: string, data: Record<string, unknown> = {}): OpenCode2Event => ({ type, data: { sessionID: "session", ...data } });
  try {
    const first = await run([
      event("session.inbox.enqueued", { inboxID: "input", item: { type: "user", payload: { text: "hello", metadata: { client: { id: "yuri" } } } } }),
      event("session.inbox.delivered", { inboxID: "input" }),
      event("session.execution.succeeded"),
    ]);
    expect(first).toContainEqual({ type: "session.updated", session_id: "session", agent: "yuri" });
    expect(stored.get("tracker/agent/session")).toBe("yuri");
    const reloaded = await run([event("session.renamed", { title: "renamed" }), event("session.execution.succeeded")]);
    expect(reloaded).toHaveLength(3);
    expect(reloaded.every(item => "agent" in item && item.agent === "yuri")).toBe(true);
  } finally {
    server.stop(true);
  }
});
