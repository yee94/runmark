import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helpers = readFileSync(join(import.meta.dir, "../../../deploy/runmark-update.sh"), "utf8").split("# ---- config ----")[0];

for (const relative of [false, true]) {
  test(`failed updater exit restores code and data with ${relative ? "relative" : "absolute"} RUNMARK_DB_PATH`, () => {
    const dir = mkdtempSync(join(tmpdir(), "runmark-rollback-"));
    try {
      for (const folder of ["app", "backup/code", "backup/data", "bin", "staging"]) mkdirSync(join(dir, folder), { recursive: true });
      const db = join(dir, "app", "main.db");
      writeFileSync(db, "new database");
      writeFileSync(join(dir, "backup/data/main.db"), "old database");
      writeFileSync(join(dir, "app/version"), "new code");
      writeFileSync(join(dir, "backup/code/version"), "old code");
      writeFileSync(join(dir, "app/.env"), `RUNMARK_DB_PATH=${relative ? "main.db" : db}\nAGENT_TRACKER_PORT=3456\n`);
      for (const [name, body] of Object.entries({ systemctl: "exit 0", sleep: "exit 0", curl: "echo '{\"status\":\"ok\"}'" })) {
        writeFileSync(join(dir, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      }
      const result = spawnSync("bash", ["-c", `${helpers}
APP_ROOT="$PWD/app"
SERVICE_NAME=rehearsal
BUN_BIN=${JSON.stringify(process.execPath)}
LOG_FILE="$PWD/update.log"
STATE_FILE="$PWD/state.json"
STAGING_DIR="$PWD/staging"
BACKUP_PATH="$PWD/backup"
EXPECTED_VERSION=1.0.1
UPDATE_STARTED_AT=rehearsal
CURRENT_PHASE=health_check
ROLLBACK_NEEDED=true
SERVICE_WAS_STOPPED=true
trap on_exit EXIT
exit 23
`], { cwd: dir, env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
      expect(result.status, result.stderr?.toString()).toBe(23);
      expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).phase).toBe("rolled_back");
      expect(readFileSync(db, "utf8")).toBe("old database");
      expect(readFileSync(join(dir, "app/version"), "utf8")).toBe("old code");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const [version, fail, expected, compat] of [
  [1, false, 0, false], [2, false, 0, true],
  [2, true, 1, true], [3, false, 1, false], [null, false, 1, false],
] as const) {
  test(`install lock=${version}, failure=${fail}: preserves frozen lock`, () => {
    const dir = mkdtempSync(join(tmpdir(), "runmark-compat-"));
    try {
      const lock = JSON.stringify({ lockfileVersion: version });
      if (version !== null) writeFileSync(join(dir, "bun.lock"), lock);
      writeFileSync(join(dir, "bun"), `#!/bin/bash
echo "$*" >> calls
if [ "$1" = -e ]; then exit 1; fi
exit ${fail ? 1 : 0}
`, { mode: 0o755 });
      const result = spawnSync("bash", ["-c", `${helpers}
BUN_BIN="$PWD/bun"
LOG_FILE="$PWD/log"
install_staging_dependencies
`], { cwd: dir });
      expect(result.status).toBe(expected);
      if (version !== null) expect(readFileSync(join(dir, "bun.lock"), "utf8")).toBe(lock);
      if (version === 1 || version === 2) {
        const calls = readFileSync(join(dir, "calls"), "utf8");
        expect(calls).toContain("install --production --frozen-lockfile");
        expect(calls.includes("x --bun bun@1.4.0")).toBe(compat);
        expect(calls).not.toContain("--no-frozen-lockfile");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
