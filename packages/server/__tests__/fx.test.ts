import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USD_TO_CNY } from "@agent-tracker/shared";
import { displayCny } from "../src/services/currency";
import {
  fxRefreshSettled,
  getUsdToCny,
  resetFxForTests,
  setFxRateUrlForTests,
  startFxRefresh,
} from "../src/services/fx";

describe("fx rate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetFxForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the offline fallback until a refresh is started", () => {
    expect(getUsdToCny()).toBe(USD_TO_CNY);
    expect(displayCny(2)).toBeCloseTo(14, 6);
  });

  it("fetches CNY per USD and keeps it for the next read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmark-fx-"));
    dirs.push(dir);
    const cache = join(dir, "fxrate.json");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ result: "success", rates: { CNY: 8.4 } });
      },
    });
    const restore = setFxRateUrlForTests(`http://127.0.0.1:${server.port}/v6/latest/USD`);
    try {
      startFxRefresh(cache);
      await fxRefreshSettled();
      expect(getUsdToCny()).toBe(8.4);
      expect(displayCny(10)).toBeCloseTo(84, 6);
      expect(JSON.parse(readFileSync(cache, "utf8")).rate).toBe(8.4);
    } finally {
      restore();
      server.stop(true);
    }
  });

  it("keeps a stale cached rate when the endpoint is down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runmark-fx-"));
    dirs.push(dir);
    const cache = join(dir, "fxrate.json");
    writeFileSync(cache, JSON.stringify({ rate: 6.9, at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }));
    const restore = setFxRateUrlForTests("http://127.0.0.1:1/v6/latest/USD");
    try {
      startFxRefresh(cache);
      await fxRefreshSettled();
      expect(getUsdToCny()).toBe(6.9);
    } finally {
      restore();
    }
  });
});
