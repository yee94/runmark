import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("update polling keeps waiting for a long backup and completes on backend confirmation", async () => {
  const source = readFileSync(new URL("../public/modules/system-update.eficy.js", import.meta.url), "utf8");
  const start = source.indexOf("async function pollUntilReady(target)");
  const end = source.indexOf("async function checkUpdateSilent()", start);
  let tick: () => Promise<void>;
  let backendPhase = "backing_up";
  let stopped = false;
  const phase = { value: "downloading" };
  const context = {
    updatePhase: phase,
    updateError: { value: "" },
    statusData: { value: null },
    pollTimer: { value: null },
    stopPoll: () => { stopped = true; },
    setInterval: (fn: () => Promise<void>) => { tick = fn; stopped = false; return 1; },
    setTimeout: () => 1,
    batch: (fn: () => void) => fn(),
    peek: (signal: { value: unknown }) => signal.value,
    appendLog: () => {},
    appendLogOnPhaseChange: () => {},
    mapBackendPhase: (value: string) => value,
    BACKEND_ACTIVE_PHASES: new Set(["backing_up", "health_check"]),
    UPDATE_PHASES: { backing_up: { label: "备份中" }, health_check: { label: "校验中" } },
    apiFetch: async () => ({ ok: true, json: async () => ({ phase: backendPhase, version: "0.2.33" }) }),
    checkUpdateSilent: () => {},
  };
  await runInNewContext(source.slice(start, end) + '\npollUntilReady("0.2.33")', context);
  for (let i = 0; i < 150; i++) await tick!();
  expect(phase.value).toBe("backing_up");
  expect(stopped).toBe(false);
  backendPhase = "health_check";
  for (let i = 0; i < 150; i++) await tick!();
  expect(phase.value).toBe("health_check");
  backendPhase = "completed";
  await tick!();
  expect(phase.value).toBe("success");
  expect(stopped).toBe(true);
});
