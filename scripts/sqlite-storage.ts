import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { initializePayloadStorage, verifyPayloads } from "../packages/server/src/db/payloads";
import { migratePayloads, inlinePayloads } from "../packages/server/src/db/storage-maintenance";
import { backupStorage, restoreStorage } from "../packages/server/src/db/storage-backup";

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    return { usage: "bun scripts/sqlite-storage.ts <enable|upgrade|migrate|inline|verify|backup> --db PATH [--batch-size N] [--max-batches N] [--out BACKUP_ROOT]; restore --manifest PATH --out NEW_DIRECTORY" };
  }
  if (!["enable", "upgrade", "migrate", "inline", "verify", "backup", "restore"].includes(command)) throw new Error(`Unknown storage command: ${command}`);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--db", "--out", "--manifest", "--baseline-manifest", "--batch-size", "--max-batches"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(`Invalid or duplicate option: ${key}`);
    options.set(key, value);
  }
  const required = (name: string) => {
    const value = options.get(name);
    if (!value) throw new Error(`${command} requires ${name}`);
    return value;
  };
  const positive = (name: string, fallback: number) => {
    if (!options.has(name)) return fallback;
    const value = Number(options.get(name));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  if (command === "restore") return restoreStorage(required("--manifest"), required("--out"));
  const path = required("--db");
  if (!existsSync(path)) throw new Error("An existing --db path is required");
  const readOnly = command === "verify" || command === "backup";
  let db = new Database(path, readOnly ? { readonly: true } : { readwrite: true });
  if (readOnly) {
    try {
      db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    } catch (error) {
      db.close();
      if ((error as { code?: string }).code !== "SQLITE_CANTOPEN") throw error;
      // WAL 数据库没有侧文件时，部分 SQLite 只读连接无法建立共享内存。
      db = new Database(path, { readwrite: true });
      try { db.query("SELECT 1 FROM sqlite_master LIMIT 1").get(); }
      catch (retryError) { db.close(); throw retryError; }
    }
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const batchSize = positive("--batch-size", 500);
    switch (command) {
      case "enable":
        db.transaction(() => initializePayloadStorage(db, true)).immediate();
        return { enabled: true };
      case "verify": {
        const baselinePath = options.get("--baseline-manifest");
        let baseline: { count: number; hash: string } | undefined;
        if (baselinePath) {
          const manifest = JSON.parse(readFileSync(baselinePath, "utf8"));
          baseline = manifest.foreignKeys;
          if (manifest.version !== 1 || !baseline || !Number.isSafeInteger(baseline.count) || baseline.count < 0 || !/^[a-f0-9]{64}$/.test(baseline.hash)) throw new Error("Invalid foreign key baseline manifest");
        }
        return db.transaction(() => verifyPayloads(db, baseline))();
      }
      case "migrate": return migratePayloads(db, batchSize, positive("--max-batches", Infinity));
      case "upgrade": return migratePayloads(db, batchSize, positive("--max-batches", Infinity), true);
      case "inline": return inlinePayloads(db, batchSize);
      case "backup": return backupStorage(db, required("--out"));
    }
  } finally { db.close(); }
}

try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
