/**
 * Generate server-manifest.json (schemaVersion 1) for the auto-updater.
 * Usage: bun run scripts/release/generate-manifest.ts <version>
 *
 * Env:
 *   ARTIFACT_BASE_URL  Base URL for artifact download (https, no trailing slash).
 *                      Default: https://github.com/<owner>/<repo>/releases/download/server-v<version>
 *   GITHUB_REPOSITORY  owner/repo (set automatically on GitHub Actions)
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun run scripts/release/generate-manifest.ts <version>");
  process.exit(1);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver: ${version}`);
  process.exit(1);
}

const rootDir = join(import.meta.dir, "../..");
const distDir = join(rootDir, "dist");
const archiveName = `agent-tracker-server-v${version}.tar.gz`;

const sha256 = readFileSync(join(distDir, `${archiveName}.sha256`), "utf-8").trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(sha256)) {
  console.error("Invalid sha256");
  process.exit(1);
}

const size = statSync(join(distDir, archiveName)).size;
if (size <= 0) {
  console.error(`Invalid archive size: ${size}`);
  process.exit(1);
}

const MAX_NOTES = 65536;
let notes = "";
try {
  const r = spawnSync("bun", ["run", join(rootDir, "scripts/release/extract-changelog.ts"), version], {
    encoding: "utf-8",
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (r.status === 0 && r.stdout) notes = r.stdout.trim();
  else throw new Error(r.stderr || "changelog extract failed");
} catch {
  console.warn("Warning: changelog extract failed; using fallback notes");
  notes = `See CHANGELOG.md for v${version}`;
}
if (Buffer.byteLength(notes, "utf-8") > MAX_NOTES) {
  notes = Buffer.from(notes, "utf-8").slice(0, MAX_NOTES - 50).toString("utf-8") + "\n\n... (notes truncated)";
}

function resolveArtifactBase(): string {
  const fromEnv = (process.env.ARTIFACT_BASE_URL || "").replace(/\/+$/, "");
  if (fromEnv) {
    if (!fromEnv.startsWith("https://")) {
      throw new Error("ARTIFACT_BASE_URL must be https");
    }
    return fromEnv;
  }
  const repo = process.env.GITHUB_REPOSITORY || "yee94/runmark";
  return `https://github.com/${repo}/releases/download/server-v${version}`;
}

const artifactBase = resolveArtifactBase();
const manifest = {
  schemaVersion: 1,
  version,
  publishedAt: new Date().toISOString(),
  notes,
  artifact: {
    url: `${artifactBase}/${archiveName}`,
    sha256,
    size,
  },
};

writeFileSync(join(distDir, "server-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
console.log(`Manifest written: dist/server-manifest.json`);
console.log(JSON.stringify(manifest, null, 2));
