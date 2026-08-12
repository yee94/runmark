/**
 * Extract release notes for a version from CHANGELOG.md
 * Usage: bun run scripts/release/extract-changelog.ts <version>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun run scripts/release/extract-changelog.ts <version>");
  process.exit(1);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver: ${version}`);
  process.exit(1);
}

const rootDir = join(import.meta.dir, "../..");
const content = readFileSync(join(rootDir, "CHANGELOG.md"), "utf-8");

function extractNotes(text: string, ver: string): string | null {
  const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^## ${escaped}\\b`, "m"));
  if (!m || m.index === undefined) return null;
  const after = text.indexOf("\n", m.index) + 1;
  const next = text.slice(after).match(/^## /m);
  let notes = text.slice(after, next ? after + (next.index ?? 0) : text.length).trim();
  const vIdx = notes.lastIndexOf("### 版本");
  if (vIdx > 0) notes = notes.slice(0, vIdx).trimEnd();
  return notes;
}

const notes = extractNotes(content, version);
if (!notes) {
  console.error(`Version ${version} not found in CHANGELOG.md`);
  process.exit(1);
}
console.log(notes);
