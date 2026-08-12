import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrackerClient, buildIngestErrorToastMessage, FileLogger, type IngestEvent } from "@agent-tracker/shared";
import { loadPluginConfig } from "../src/index";

function testLogger(): FileLogger {
  return new FileLogger({ filePath: "/tmp/agent-tracker-test.log", enabled: false, component: "test" });
}

describe("TrackerClient", () => {
  it("buffers events and auto-flushes when buffer reaches limit", () => {
    // We test the buffering logic without real HTTP calls
    const client = new TrackerClient("http://localhost:3456", "test-key", testLogger());
    const events: IngestEvent[] = [];

    // Mock fetch to capture calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, opts: any) => {
      const body = JSON.parse(opts.body as string);
      events.push(...body.events);
      return new Response(JSON.stringify({ ingested: body.events.length, errors: [] }), { status: 200 });
    };

    // Push 9 events (below threshold) — no flush yet
    for (let i = 0; i < 9; i++) {
      client.push({
        type: "session.created",
        session_id: `s-${i}`,
        agent: "opencode",
      });
    }
    expect(events.length).toBe(0); // Not flushed yet

    // Push 10th event — triggers flush
    client.push({
      type: "session.created",
      session_id: "s-10",
      agent: "opencode",
    });
    expect(events.length).toBe(10);

    globalThis.fetch = originalFetch;
  });

  it("manual flush sends all buffered events", async () => {
    const client = new TrackerClient("http://localhost:3456", "test-key", testLogger());
    const events: IngestEvent[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, opts: any) => {
      const body = JSON.parse(opts.body as string);
      events.push(...body.events);
      return new Response(JSON.stringify({ ingested: body.events.length, errors: [] }), { status: 200 });
    };

    client.push({ type: "session.created", session_id: "s-1", agent: "opencode" });
    expect(events.length).toBe(0);

    await client.flush();
    expect(events.length).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it("applies a bounded request timeout by default", async () => {
    const client = new TrackerClient("http://localhost:3456", "test-key", testLogger());
    let signal: AbortSignal | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, opts: any) => {
      signal = opts.signal;
      return new Response(JSON.stringify({ ingested: 1, errors: [] }), { status: 200 });
    };

    try {
      client.push({ type: "session.created", session_id: "s-timeout", agent: "opencode" });
      await client.flush();
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls onIngestError when ingest fails", async () => {
    const errors: Array<{ kind: string; status?: number }> = [];
    const client = new TrackerClient(
      "http://localhost:3456",
      "test-key",
      testLogger(),
      (detail) => errors.push(detail),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

    client.push({ type: "session.created", session_id: "s-err", agent: "opencode" });
    await client.flush();

    expect(errors).toEqual([{ kind: "http", status: 401 }]);

    globalThis.fetch = originalFetch;
  });

  it("buildIngestErrorToastMessage includes config steps", () => {
    const message = buildIngestErrorToastMessage("http://example.com:3456", { kind: "network" });
    expect(message).toContain("~/.config/agent-tracker/env");
    expect(message).toContain('endpoint="<服务地址>"');
    expect(message).toContain("无需修改 shell 配置");
    expect(message).toContain("curl http://example.com:3456/health");
  });

  it("loadPluginConfig reads endpoint and apiKey from env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-plugin-env-"));
    const path = join(dir, "env");
    writeFileSync(path, 'endpoint="http://remote:3456"\napiKey=remote-key\n');

    const prevEndpoint = process.env.AGENT_TRACKER_ENDPOINT;
    const prevApiKey = process.env.AGENT_TRACKER_API_KEY;
    delete process.env.AGENT_TRACKER_ENDPOINT;
    delete process.env.AGENT_TRACKER_API_KEY;

    try {
      expect(loadPluginConfig(path)).toMatchObject({
        endpoint: "http://remote:3456",
        apiKey: "remote-key",
      });
    } finally {
      if (prevEndpoint === undefined) delete process.env.AGENT_TRACKER_ENDPOINT;
      else process.env.AGENT_TRACKER_ENDPOINT = prevEndpoint;
      if (prevApiKey === undefined) delete process.env.AGENT_TRACKER_API_KEY;
      else process.env.AGENT_TRACKER_API_KEY = prevApiKey;
    }
  });
});
