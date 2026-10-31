import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeHooksConfig, runInit } from "../src/init";
import { HOOK_ENTRY_FILE, HOOK_INSTALL_DIR, HOOK_WRAPPER_FILE, TRACKED_HOOK_EVENTS } from "../src/constants";

describe("mergeHooksConfig", () => {
  it("registers all tracked events with hook command", () => {
    const merged = mergeHooksConfig(null, `./hooks/${HOOK_INSTALL_DIR}/${HOOK_WRAPPER_FILE}`);
    for (const event of TRACKED_HOOK_EVENTS) {
      expect(merged.hooks[event]?.some((h) => h.command.includes(HOOK_WRAPPER_FILE))).toBe(true);
    }
  });

  it("replaces previous agent-tracker hooks without duplicating", () => {
    const existing = {
      version: 1,
      hooks: {
        sessionStart: [
          { command: "./hooks/other.sh" },
          { command: `./hooks/${HOOK_INSTALL_DIR}/${HOOK_ENTRY_FILE}` },
          { command: `./hooks/${HOOK_INSTALL_DIR}/${HOOK_WRAPPER_FILE}` },
        ],
      },
    };
    const merged = mergeHooksConfig(existing, `./hooks/${HOOK_INSTALL_DIR}/${HOOK_WRAPPER_FILE}`);
    const cmds = merged.hooks.sessionStart?.map((h) => h.command) ?? [];
    expect(cmds.filter((c) => c.includes(HOOK_INSTALL_DIR))).toHaveLength(1);
    expect(cmds).toContain("./hooks/other.sh");
  });
});

describe("runInit", () => {
  let tempRoot: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "agent-tracker-init-"));
    previousHome = process.env.HOME;
    process.env.HOME = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("writes hooks.json and copies hook script", () => {
    const cursorDir = join(tempRoot, ".cursor");
    const distDir = join(tempRoot, "dist");
    const wrapperSource = join(tempRoot, "run.sh");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "hook.mjs"), "export async function runHook() {}\n", "utf-8");
    writeFileSync(join(distDir, "constants-test.mjs"), "export {}\n", "utf-8");
    writeFileSync(wrapperSource, "#!/usr/bin/env bash\nexit 0\n", "utf-8");

    const result = runInit({ cursorDir, hookDistDir: distDir, wrapperSourcePath: wrapperSource });
    expect(existsSync(result.hooksPath)).toBe(true);
    expect(existsSync(join(cursorDir, "hooks", HOOK_INSTALL_DIR, HOOK_ENTRY_FILE))).toBe(true);
    expect(existsSync(join(cursorDir, "hooks", HOOK_INSTALL_DIR, HOOK_WRAPPER_FILE))).toBe(true);

    const hooks = JSON.parse(readFileSync(result.hooksPath, "utf-8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.beforeSubmitPrompt?.[0]?.command).toBe(`./hooks/${HOOK_INSTALL_DIR}/${HOOK_WRAPPER_FILE}`);
    const envPath = join(tempRoot, ".config/runmark/env");
    expect(readFileSync(envPath, "utf8")).toContain('RUNMARK_ENDPOINT="http://localhost:3456"');
    expect(existsSync(join(tempRoot, ".config/agent-tracker/env"))).toBe(false);

    rmSync(envPath);
    const legacyPath = join(tempRoot, ".config/agent-tracker/env");
    mkdirSync(join(tempRoot, ".config/agent-tracker"), { recursive: true });
    const legacy = "endpoint=https://existing.test\napiKey=existing-key\n";
    writeFileSync(legacyPath, legacy);
    runInit({ cursorDir, hookDistDir: distDir, wrapperSourcePath: wrapperSource });
    expect(existsSync(envPath)).toBe(false);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
  });
});
