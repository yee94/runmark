import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultPluginEnvPath, legacyPluginEnvPath, loadEnvFile, resolveEnvValue } from "../src/env-file";
import { loadPluginConfig } from "../../plugin-opencode/src/index";
import { loadHookConfig } from "../../hook-cursor/src/config";
import { loadCodexConfig } from "../../plugin-codex/src/config";
import { loadClaudeCompatConfig } from "../../plugin-claude-compat/src/config";
import { loadGrokConfig } from "../../plugin-grok/src/config";
import { loadConfig } from "../../server/src/config";

const clients = [loadPluginConfig, loadHookConfig, loadCodexConfig, loadClaudeCompatConfig, loadGrokConfig];
const apiScript = resolve(import.meta.dir, "../../../skills/runmark/runmark-api.sh");
const shells = ["bash", "zsh"].filter(shell => Bun.which(shell));

describe("Runmark global configuration migration", () => {
  let home: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(RUNMARK_|AGENT_TRACKER_)/.test(key) || key === "HOME"));
    for (const key of Object.keys(previous)) delete process.env[key];
    home = mkdtempSync(join(tmpdir(), "runmark-config-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (/^(RUNMARK_|AGENT_TRACKER_)/.test(key) || key === "HOME") delete process.env[key];
    }
    Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  });

  function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function shellConfig(shell: string) {
    const result = Bun.spawnSync([shell, "-c", 'source "$1" || exit; printf "%s\\n%s" "$_RM_ENDPOINT" "$_RM_API_KEY"', "runmark-test", apiScript], {
      env: process.env, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().split("\n");
  }

  it("reads legacy configuration without creating or changing files", () => {
    const legacy = 'AGENT_TRACKER_ENDPOINT="https://legacy.test"\nAGENT_TRACKER_API_KEY=legacy-key\n';
    write(legacyPluginEnvPath(), legacy);
    expect(defaultPluginEnvPath()).toBe(join(home, ".config/runmark/env"));
    for (const load of clients) expect(load()).toMatchObject({ endpoint: "https://legacy.test", apiKey: "legacy-key" });
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://legacy.test", "legacy-key"]);
    expect(existsSync(defaultPluginEnvPath())).toBe(false);
    expect(readFileSync(legacyPluginEnvPath(), "utf8")).toBe(legacy);
  });

  it("uses the new file as a whole, without borrowing the old API key", () => {
    write(legacyPluginEnvPath(), "endpoint=https://legacy.test\napiKey=legacy-key\n");
    write(defaultPluginEnvPath(), "RUNMARK_ENDPOINT=https://current.test\n");
    for (const load of clients) expect(load()).toMatchObject({ endpoint: "https://current.test", apiKey: "dev-key-change-me" });
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://current.test", ""]);
    write(defaultPluginEnvPath(), "");
    expect(loadEnvFile()).toEqual({});
    expect(loadEnvFile(join(home, "missing"))).toEqual({});
  });

  it("prefers canonical keys within each source and keeps process overrides above files", () => {
    write(defaultPluginEnvPath(), "RUNMARK_ENDPOINT=https://file.test\nRUNMARK_API_KEY=file-key\nAGENT_TRACKER_API_KEY=stale-key\n");
    for (const load of clients) expect(load().apiKey).toBe("file-key");
    process.env.AGENT_TRACKER_ENDPOINT = "https://legacy-process.test";
    process.env.AGENT_TRACKER_API_KEY = "legacy-process-key";
    for (const load of clients) expect(load()).toMatchObject({ endpoint: "https://legacy-process.test", apiKey: "legacy-process-key" });
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://legacy-process.test", "legacy-process-key"]);
    process.env.RUNMARK_ENDPOINT = "https://process.test";
    process.env.RUNMARK_API_KEY = "process-key";
    for (const load of clients) expect(load()).toMatchObject({ endpoint: "https://process.test", apiKey: "process-key" });
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://process.test", "process-key"]);
    expect(resolveEnvValue({}, "AGENT_TRACKER_API_KEY")).toBe("process-key");
  });

  it("keeps short aliases and explicit empty canonical values", () => {
    write(defaultPluginEnvPath(), "endpoint=https://alias.test\napi_key=alias-key\n");
    for (const load of clients) expect(load()).toMatchObject({ endpoint: "https://alias.test", apiKey: "alias-key" });
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://alias.test", "alias-key"]);
    write(defaultPluginEnvPath(), "RUNMARK_ENDPOINT=https://current.test\nRUNMARK_API_KEY=\nAGENT_TRACKER_API_KEY=stale-key\n");
    for (const load of clients) expect(load().apiKey).toBe("");
    for (const shell of shells) expect(shellConfig(shell)).toEqual(["https://current.test", ""]);
  });

  it("supports new server variables while retaining read-only legacy aliases", () => {
    process.env.AGENT_TRACKER_API_KEY = "legacy-key";
    process.env.AGENT_TRACKER_PORT = "4567";
    expect(loadConfig()).toMatchObject({ apiKey: "legacy-key", port: 4567 });
    process.env.RUNMARK_API_KEY = "current-key";
    process.env.RUNMARK_PORT = "5678";
    process.env.RUNMARK_CURSOR_CRYPTO_KEY = "01".repeat(32);
    expect(loadConfig()).toMatchObject({ apiKey: "current-key", port: 5678, logFile: "data/runmark.log" });
    expect(loadConfig().cursorCryptoKey).toEqual(new Uint8Array(32).fill(1));
  });
});
