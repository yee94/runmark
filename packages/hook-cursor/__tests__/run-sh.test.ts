import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("run.sh fail-open", () => {
  const runSh = join(import.meta.dir, "..", "scripts", "run.sh");

  it("beforeSubmitPrompt always emits continue and exits 0", () => {
    const payload = JSON.stringify({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conv-test",
      prompt: "hello",
    });
    const res = spawnSync("bash", [runSh], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"continue":true');
  });

  it("sessionStart exits 0 even when node missing", () => {
    const payload = JSON.stringify({
      hook_event_name: "sessionStart",
      session_id: "sess-test",
    });
    const res = spawnSync("bash", [runSh], {
      input: payload,
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(res.status).toBe(0);
  });

  it("sessionEnd returns immediately while telemetry uploads in the background", () => {
    const payload = JSON.stringify({
      hook_event_name: "sessionEnd",
      session_id: "sess-test",
    });
    const startedAt = performance.now();
    const res = spawnSync("bash", [runSh], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    expect(res.status).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
