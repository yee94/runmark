import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helpers = readFileSync(join(import.meta.dir, "../../../deploy/runmark-update.sh"), "utf8").split("# ---- config ----")[0];

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
