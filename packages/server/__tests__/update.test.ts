import { describe, it, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { createUpdateRoute } from "../src/routes/update";
import {
  compareVersions,
  validateManifest,
  readUpdateState,
  checkForUpdates,
  getUpdateStatus,
  triggerUpdate,
  type UpdateManifest,
  type ManifestCheckResult,
  type SpawnResult,
  type UpdateState,
  type UpdatePhase,
  type TriggerUpdateParams,
} from "../src/services/update";
import { getServerVersion } from "../src/config";

// ============================================================================
// Version comparison tests
// ============================================================================

describe("compareVersions", () => {
  it("simple x.y.z comparison", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "1.0.0")).toBeLessThan(0);
  });

  it("prerelease is lower than release", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0);
  });

  it("prerelease comparison (alpha < beta < rc)", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-rc")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  it("numeric prerelease identifiers compared as numbers", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-2")).toBeLessThan(0);
    expect(compareVersions("1.0.0-10", "1.0.0-2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2")).toBeGreaterThan(0);
  });

  it("dot-separated prerelease", () => {
    expect(compareVersions("1.0.0-alpha.1.beta", "1.0.0-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.1.1")).toBeLessThan(0);
  });

  it("numeric prerelease has lower precedence than alpha", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  it("invalid versions fallback to string compare", () => {
    expect(compareVersions("not-a-version", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "not-a-version")).toBeGreaterThan(0);
  });

  it("server version is valid semver", () => {
    const v = getServerVersion();
    const parsed = validateManifest({
      schemaVersion: 1,
      version: v,
      publishedAt: "2026-01-01T00:00:00.000Z",
      notes: "test",
      artifact: { url: "https://example.com/pkg.tar.gz", sha256: "a".repeat(64) },
    });
    expect("errors" in parsed).toBe(false);
  });
});

// ============================================================================
// Manifest validation tests
// ============================================================================

function makeValidManifest(overrides?: Partial<Record<string, unknown>> & { artifact?: unknown }): unknown {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    version: "1.0.0",
    publishedAt: "2026-07-10T12:00:00.000Z",
    notes: "Release notes",
    artifact: {
      url: "https://example.com/runmark-1.0.0.tar.gz",
      sha256: "a".repeat(64),
    },
  };

  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k === "artifact" && v && typeof v === "object") {
        base.artifact = { ...(base.artifact as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else if (k === "artifact") {
        base.artifact = v;
      } else {
        base[k] = v;
      }
    }
  }

  return base;
}

describe("validateManifest", () => {
  it("valid manifest passes", () => {
    const result = validateManifest(makeValidManifest());
    expect("manifest" in result).toBe(true);
    if ("manifest" in result) {
      expect(result.manifest.schemaVersion).toBe(1);
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.manifest.artifact.sha256).toHaveLength(64);
    }
  });

  it("rejects non-object input", () => {
    const result = validateManifest("string");
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "root")).toBe(true);
    }
  });

  it("rejects wrong schemaVersion", () => {
    const result = validateManifest(makeValidManifest({ schemaVersion: 2 }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "schemaVersion")).toBe(true);
    }
  });

  it("rejects invalid version format", () => {
    const result = validateManifest(makeValidManifest({ version: "latest" }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "version")).toBe(true);
    }
  });

  it("rejects invalid publishedAt", () => {
    const result = validateManifest(makeValidManifest({ publishedAt: "not-a-date" }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "publishedAt")).toBe(true);
    }
  });

  it("rejects notes exceeding 64 KB", () => {
    const result = validateManifest(makeValidManifest({ notes: "x".repeat(65537) }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "notes")).toBe(true);
    }
  });

  it("allows notes exactly at 64 KB", () => {
    const result = validateManifest(makeValidManifest({ notes: "x".repeat(65536) }));
    expect("manifest" in result).toBe(true);
  });

  it("rejects missing artifact", () => {
    const result = validateManifest(makeValidManifest({ artifact: undefined }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact")).toBe(true);
    }
  });

  it("rejects non-http/https artifact.url", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "ftp://example.com/pkg.tar.gz", sha256: "a".repeat(64) },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.url")).toBe(true);
    }
  });

  it("rejects artifact.url with credentials (username)", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://user@example.com/pkg.tar.gz", sha256: "a".repeat(64) },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.url")).toBe(true);
    }
  });

  it("rejects artifact.url with credentials (password)", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://user:pass@example.com/pkg.tar.gz", sha256: "a".repeat(64) },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.url")).toBe(true);
    }
  });

  it("rejects invalid sha256 (wrong length)", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://example.com/pkg.tar.gz", sha256: "abc" },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.sha256")).toBe(true);
    }
  });

  it("rejects sha256 with non-hex chars", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://example.com/pkg.tar.gz", sha256: "g".repeat(64) },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.sha256")).toBe(true);
    }
  });

  it("validates optional size field", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://example.com/pkg.tar.gz", sha256: "a".repeat(64), size: -1 },
    }));
    expect("errors" in result).toBe(true);
    if ("errors" in result) {
      expect(result.errors.some((e) => e.field === "artifact.size")).toBe(true);
    }
  });

  it("allows valid size as non-negative integer", () => {
    const result = validateManifest(makeValidManifest({
      artifact: { url: "https://example.com/pkg.tar.gz", sha256: "a".repeat(64), size: 1024 },
    }));
    expect("manifest" in result).toBe(true);
  });
});

// ============================================================================
// State file reading tests
// ============================================================================

describe("readUpdateState", () => {
  it("returns idle default when file missing", () => {
    const state = readUpdateState("/nonexistent/path/state.json", () => null);
    expect(state.phase).toBe("idle");
  });

  it("returns idle default for invalid JSON", () => {
    const state = readUpdateState("/fake.json", () => "not json");
    expect(state.phase).toBe("idle");
  });

  it("returns idle default for unknown phase", () => {
    const state = readUpdateState("/fake.json", () => JSON.stringify({ phase: "garbage" }));
    expect(state.phase).toBe("idle");
  });

  it("parses valid state correctly", () => {
    const state = readUpdateState("/fake.json", () =>
      JSON.stringify({ phase: "downloading", version: "1.2.3", error: null as unknown }),
    );
    expect(state.phase).toBe("downloading");
    expect(state.version).toBe("1.2.3");
    expect(state.error).toBeUndefined();
  });

  it("parses completed state", () => {
    const state = readUpdateState("/fake.json", () =>
      JSON.stringify({ phase: "completed", version: "2.0.0", startedAt: "2026-07-10T00:00:00Z", completedAt: "2026-07-10T00:05:00Z" }),
    );
    expect(state.phase).toBe("completed");
    expect(state.version).toBe("2.0.0");
    expect(state.startedAt).toBe("2026-07-10T00:00:00Z");
    expect(state.completedAt).toBe("2026-07-10T00:05:00Z");
  });

  it("accepts error field", () => {
    const state = readUpdateState("/fake.json", () =>
      JSON.stringify({ phase: "failed", error: "Something went wrong" }),
    );
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Something went wrong");
  });

  it("accepts all valid phases", () => {
    const phases: UpdatePhase[] = ["idle", "downloading", "verifying", "installing", "backing_up", "restarting", "health_check", "completed", "failed", "rolling_back", "rolled_back"];
    for (const phase of phases) {
      const state = readUpdateState("/fake.json", () => JSON.stringify({ phase }));
      expect(state.phase).toBe(phase);
    }
  });
});

// ============================================================================
// Mock helpers
// ============================================================================

const noopLog = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
} as any;

function makeValidManifestObj(version: string = "2.0.0"): UpdateManifest {
  return {
    schemaVersion: 1,
    version,
    publishedAt: "2026-07-10T12:00:00.000Z",
    notes: "New version",
    artifact: {
      url: "https://example.com/runmark-2.0.0.tar.gz",
      sha256: "a".repeat(64),
    },
  };
}

function manifestResponse(version: string = "2.0.0"): Response {
  return new Response(JSON.stringify(makeValidManifestObj(version)), {
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// checkForUpdates tests
// ============================================================================

describe("checkForUpdates", () => {
  it("returns disabled when updateEnabled=false", async () => {
    const result = await checkForUpdates(
      false,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
    );
    expect(result.enabled).toBe(false);
    expect(result.available).toBe(false);
    expect(result.currentVersion).toBe("1.0.0");
  });

  it("returns configError when enabled but manifestUrl empty", async () => {
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "",
      "/fake.json",
      noopLog,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
    expect(result.configError).toBeDefined();
    expect(result.configError).toContain("not configured");
  });

  it("returns available=true when manifest version > current", async () => {
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(manifestResponse("2.0.0")),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(true);
    expect(result.latest?.version).toBe("2.0.0");
  });

  it("returns available=false when manifest version <= current", async () => {
    const result = await checkForUpdates(
      true,
      "2.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(manifestResponse("1.0.0")),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
  });

  it("returns available=false when manifest version == current", async () => {
    const result = await checkForUpdates(
      true,
      "2.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(manifestResponse("2.0.0")),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
  });

  it("handles network error gracefully", async () => {
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.reject(new Error("Network down")),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
  });

  it("handles HTTP error from manifest", async () => {
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(new Response("Not Found", { status: 404 })),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
  });

  it("handles invalid manifest JSON", async () => {
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(new Response("not json", { headers: { "Content-Type": "text/plain" } })),
      () => null,
    );
    expect(result.enabled).toBe(true);
    expect(result.available).toBe(false);
  });

  it("reports updating status when state phase is downloading", async () => {
    const stateJson = JSON.stringify({ phase: "downloading", version: "2.0.0" });
    const result = await checkForUpdates(
      true,
      "1.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(manifestResponse("2.0.0")),
      () => stateJson,
    );
    expect(result.status).toBe("updating");
    expect(result.currentPhase).toBe("downloading");
  });

  it("reports completed status from state file", async () => {
    const stateJson = JSON.stringify({ phase: "completed", version: "2.0.0" });
    const result = await checkForUpdates(
      true,
      "2.0.0",
      "https://example.com/manifest.json",
      "/fake.json",
      noopLog,
      () => Promise.resolve(manifestResponse("2.0.0")),
      () => stateJson,
    );
    expect(result.status).toBe("completed");
  });
});

// ============================================================================
// getUpdateStatus tests
// ============================================================================

describe("getUpdateStatus", () => {
  it("returns disabled when not enabled", () => {
    const result = getUpdateStatus(false, "1.0.0", "/fake.json", () => null);
    expect(result.enabled).toBe(false);
    expect(result.currentVersion).toBe("1.0.0");
  });

  it("returns default idle when no state file", () => {
    const result = getUpdateStatus(true, "1.0.0", "/fake.json", () => null);
    expect(result.phase).toBe("idle");
  });

  it("reads state from file", () => {
    const stateJson = JSON.stringify({ phase: "installing", version: "2.0.0", startedAt: "2026-07-10T00:00:00Z" });
    const result = getUpdateStatus(true, "1.0.0", "/fake.json", () => stateJson);
    expect(result.phase).toBe("installing");
    expect(result.version).toBe("2.0.0");
    expect(result.startedAt).toBe("2026-07-10T00:00:00Z");
  });
});

// ============================================================================
// triggerUpdate tests (injectable spawn, no real systemd-run)
// ============================================================================

describe("triggerUpdate", () => {
  const mockFetch = () => Promise.resolve(manifestResponse("2.0.0"));
  const mockReadFile = () => null;
  const mockWriteFile = (_p: string, _c: string) => {};
  const mockFileExists = (_p: string) => true;
  const mockFileExecutable = (_p: string) => true;
  const mockLog = noopLog;
  const mockPlatform = "linux" as NodeJS.Platform;

  it("returns error when update not enabled", async () => {
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: false,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });

  it("returns 409 when update is already in progress", async () => {
    const stateJson = JSON.stringify({ phase: "downloading", version: "2.0.0" });
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      readFile: () => stateJson,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(409);
  });

  it("returns error when manifest version does not match requested version (TOCTOU)", async () => {
    const fetchWrong = () => Promise.resolve(manifestResponse("3.0.0"));
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: fetchWrong,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(409);
  });

  it("returns error when target version is not newer than current", async () => {
    const fetchSame = () => Promise.resolve(manifestResponse("1.0.0"));
    const result = await triggerUpdate({
      targetVersion: "1.0.0",
      enabled: true,
      currentVersion: "2.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: fetchSame,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });

  it("returns error for invalid target version format", async () => {
    const result = await triggerUpdate({
      targetVersion: "not-semver",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });

  it("returns error when manifest fetch fails", async () => {
    const fetchFail = () => Promise.reject(new Error("Network error"));
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: fetchFail,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(502);
  });

  it("returns error when update script not found", async () => {
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/nonexistent/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: () => false,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(500);
  });

  it("returns error when update script exists but is not executable", async () => {
    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: () => true,
      fileExecutable: () => false,
      platform: mockPlatform,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(500);
      expect(result.error).toContain("not executable");
    }
  });

  it("returns 409 for in-process single-flight concurrency", async () => {
    let resolveFirst: (v: Response) => void;
    const slowFetch = () => new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    const firstPromise = triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: slowFetch,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });

    await new Promise((r) => setTimeout(r, 20));

    const secondResult = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });

    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.code).toBe(409);
      expect(secondResult.error).toContain("in-process lock");
    }

    resolveFirst!(manifestResponse("2.0.0"));
    await firstPromise;
  });

  it("successful dispatch returns ok=true with phase downloading", async () => {
    const spawnSuccess: SpawnResult = { success: true, exitCode: 0 };
    const writtenStates: UpdateState[] = [];

    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      spawnFn: () => Promise.resolve(spawnSuccess),
      readFile: mockReadFile,
      writeFile: (_p, content) => {
        writtenStates.push(JSON.parse(content));
      },
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase).toBe("downloading");
      expect(result.version).toBe("2.0.0");
    }
    expect(writtenStates.length).toBeGreaterThanOrEqual(1);
    expect(writtenStates[0].phase).toBe("downloading");
    expect(writtenStates[0].version).toBe("2.0.0");
  });

  it("handles spawn timeout and writes failed state with timedOut flag", async () => {
    const spawnTimedOut: SpawnResult = { success: false, exitCode: null, timedOut: true, error: "systemd-run timed out after 10000ms" };
    const writtenStates: UpdateState[] = [];

    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      spawnFn: () => Promise.resolve(spawnTimedOut),
      readFile: mockReadFile,
      writeFile: (_p, content) => {
        writtenStates.push(JSON.parse(content));
      },
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(500);
      expect(result.error).toContain("timed out");
    }
    expect(writtenStates.length).toBe(2);
    expect(writtenStates[1].phase).toBe("failed");
  });

  it("handles spawn failure and writes failed state", async () => {
    const spawnFail: SpawnResult = { success: false, exitCode: 1, error: "Permission denied" };
    const writtenStates: UpdateState[] = [];

    const result = await triggerUpdate({
      targetVersion: "2.0.0",
      enabled: true,
      currentVersion: "1.0.0",
      manifestUrl: "https://example.com/manifest.json",
      updateScript: "/opt/runmark-updater/update.sh",
      statePath: "/tmp/state.json",
      log: mockLog,
      fetchFn: mockFetch,
      spawnFn: () => Promise.resolve(spawnFail),
      readFile: mockReadFile,
      writeFile: (_p, content) => {
        writtenStates.push(JSON.parse(content));
      },
      fileExists: mockFileExists,
      fileExecutable: mockFileExecutable,
      platform: mockPlatform,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(500);

    expect(writtenStates.length).toBe(2);
    expect(writtenStates[0].phase).toBe("downloading");
    expect(writtenStates[1].phase).toBe("failed");
    expect(writtenStates[1].error).toContain("Permission denied");
  });
});

// ============================================================================
// Direct route tests (injecting triggerFn to assert 202 + response fields)
// ============================================================================

const integrationLog = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
} as any;

const routeConfig: ServerConfig = {
  port: 3456,
  apiKey: "route-test-key",
  dbPath: ":memory:",
  publicDir: "./public",
  publicDashboard: true,
  extraApiKeys: [],
  debug: false,
  logFile: "/tmp/agent-tracker-update-test.log",
  cursorSyncEnabled: false,
  cursorApiKey: "route-test-key",
  llmBaseUrl: "https://api.example.com/v1/chat/completions",
  llmApiKey: "ac:test",
  llmModel: "deepseek_v4_flash_code",
  agentThrottleMs: 10 * 60 * 1000,
  agentAutoRunEnabled: false,
  updateEnabled: true,
  updateManifestUrl: "https://example.com/manifest.json",
  updateScript: "/opt/runmark-updater/update.sh",
  updateStatePath: "/tmp/update-state-test.json",
};

describe("Update route (direct, injected triggerFn)", () => {
  it("POST /v1/system-update returns 202 with injected success result", async () => {
    const successTrigger = async (_params: TriggerUpdateParams) => ({
      ok: true as const,
      phase: "downloading" as const,
      version: "2.0.0",
      message: "Update to 2.0.0 has been scheduled.",
    });

    const routeApp = createUpdateRoute(routeConfig, integrationLog, successTrigger);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.phase).toBe("downloading");
    expect(body.version).toBe("2.0.0");
    expect(body.message).toContain("scheduled");
  });

  it("POST /v1/system-update returns error code from injected failure", async () => {
    const failTrigger = async (_params: TriggerUpdateParams) => ({
      ok: false as const,
      error: "Manifest fetch failed: Network error",
      code: 502,
    });

    const routeApp = createUpdateRoute(routeConfig, integrationLog, failTrigger);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Network error");
  });

  it("POST /v1/system-update returns 400 without version field", async () => {
    const routeApp = createUpdateRoute(routeConfig, integrationLog);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/system-update returns 400 without body", async () => {
    const routeApp = createUpdateRoute(routeConfig, integrationLog);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/system-update returns 500 on state write failure (injected writeFile throws)", async () => {
    const throwingTrigger = async (params: TriggerUpdateParams) => {
      return triggerUpdate({
        ...params,
        enabled: true,
        fetchFn: () => Promise.resolve(manifestResponse("2.0.0")),
        readFile: () => null,
        writeFile: () => { throw new Error("ENOSPC: no space left on device"); },
        fileExists: () => true,
        fileExecutable: () => true,
        spawnFn: () => Promise.resolve({ success: true, exitCode: 0 }),
        platform: "linux" as NodeJS.Platform,
      });
    };

    const routeApp = createUpdateRoute(routeConfig, integrationLog, throwingTrigger);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to write update state");
  });

  it("POST /v1/system-update spawn failure with writeFile also throwing returns 500 (error state write is best-effort)", async () => {
    let writeCount = 0;
    const throwingTrigger = async (params: TriggerUpdateParams) => {
      return triggerUpdate({
        ...params,
        enabled: true,
        fetchFn: () => Promise.resolve(manifestResponse("2.0.0")),
        readFile: () => null,
        writeFile: () => {
          writeCount++;
          throw new Error("Disk full");
        },
        fileExists: () => true,
        fileExecutable: () => true,
        spawnFn: () => Promise.resolve({ success: false, exitCode: 1, error: "Permission denied" }),
        platform: "linux" as NodeJS.Platform,
      });
    };

    const routeApp = createUpdateRoute(routeConfig, integrationLog, throwingTrigger);
    const res = await routeApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to write update state");
    expect(writeCount).toBe(1);
  });

  it("GET /v1/system-update/check returns sensible fields", async () => {
    const routeApp = createUpdateRoute(
      { ...routeConfig, updateEnabled: false },
      integrationLog,
    );
    const res = await routeApp.request("/v1/system-update/check");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.currentVersion).toBeDefined();
    expect(body.available).toBe(false);
  });

  it("GET /v1/system-update/status returns sensible fields", async () => {
    const routeApp = createUpdateRoute(routeConfig, integrationLog);
    const res = await routeApp.request("/v1/system-update/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.phase).toBeDefined();
    expect(typeof body.currentVersion).toBe("string");
  });
});

// ============================================================================
// createApp-level integration tests (auth + endpoint reachability)
// ============================================================================

const testConfig: ServerConfig = {
  port: 3456,
  apiKey: "test-update-key",
  dbPath: ":memory:",
  publicDir: "./public",
  publicDashboard: false,
  extraApiKeys: [],
  debug: false,
  logFile: "/tmp/agent-tracker-update-test.log",
  cursorSyncEnabled: false,
  cursorApiKey: "test-update-key",
  llmBaseUrl: "https://api.example.com/v1/chat/completions",
  llmApiKey: "ac:test",
  llmModel: "deepseek_v4_flash_code",
  agentThrottleMs: 10 * 60 * 1000,
  agentAutoRunEnabled: false,
  updateEnabled: true,
  updateManifestUrl: "",
  updateScript: "/opt/runmark-updater/update.sh",
  updateStatePath: "/tmp/update-state-test.json",
};

describe("Update API route integration (createApp)", () => {
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    ({ app } = createApp(testConfig));
  });

  it("GET /v1/system-update/check returns 401 without auth", async () => {
    const res = await app.request("/v1/system-update/check");
    expect(res.status).toBe(401);
  });

  it("GET /v1/system-update/check returns 200 with X-API-Key", async () => {
    const res = await app.request("/v1/system-update/check", {
      headers: { "X-API-Key": "test-update-key" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /v1/system-update/check returns 200 with Cookie auth", async () => {
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-update-key" }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie")!;

    const res = await app.request("/v1/system-update/check", {
      headers: { Cookie: setCookie.split(";")[0] },
    });
    expect(res.status).toBe(200);
  });

  it("GET /v1/system-update/status returns 401 without auth", async () => {
    const res = await app.request("/v1/system-update/status");
    expect(res.status).toBe(401);
  });

  it("GET /v1/system-update/status returns 200 with X-API-Key", async () => {
    const res = await app.request("/v1/system-update/status", {
      headers: { "X-API-Key": "test-update-key" },
    });
    expect(res.status).toBe(200);
  });

  it("POST /v1/system-update returns 401 without auth", async () => {
    const res = await app.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/system-update returns 400 with Cookie but empty body (authenticated, body validation fails)", async () => {
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-update-key" }),
    });
    const setCookie = loginRes.headers.get("set-cookie")!;

    const res = await app.request("/v1/system-update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: setCookie.split(";")[0],
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/system-update returns 400 when update is disabled", async () => {
    const { app: disabledApp } = createApp({ ...testConfig, updateEnabled: false });
    const res = await disabledApp.request("/v1/system-update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "test-update-key" },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/system-update with Cookie passes auth and reaches triggerUpdate (not 401)", async () => {
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-update-key" }),
    });
    const setCookie = loginRes.headers.get("set-cookie")!;

    const res = await app.request("/v1/system-update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: setCookie.split(";")[0],
      },
      body: JSON.stringify({ version: "2.0.0" }),
    });
    expect(res.status).not.toBe(401);
  });
});
