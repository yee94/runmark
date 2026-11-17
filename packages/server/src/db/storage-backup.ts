import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest, foreignKeySummary, hasPayloadCatalog, readShardPayload, shardPath, validatePayloadRef, verifyPayloads, type PayloadRef } from "./payloads";

type ObjectInfo = { hash: string; bytes: number };
type ShardInfo = ObjectInfo & { month: string };
type Manifest = { version: 1; createdAt: string; main: ObjectInfo; shards: ShardInfo[]; foreignKeys?: { count: number; hash: string } };

function fileHash(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    let bytes: number;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, bytes));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

function syncPath(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function objectPath(root: string, info: ObjectInfo): string {
  if (!info || !/^[a-f0-9]{64}$/.test(info.hash) || !Number.isSafeInteger(info.bytes) || info.bytes < 1) throw new Error("Invalid backup object");
  return join(root, "objects", `${info.hash}.db`);
}

function checkObject(root: string, info: ObjectInfo): string {
  const path = objectPath(root, info);
  if (!existsSync(path) || statSync(path).size !== info.bytes || fileHash(path) !== info.hash) throw new Error(`Backup object checksum mismatch: ${info.hash}`);
  return path;
}

function publishObject(root: string, path: string): ObjectInfo {
  const info = { hash: fileHash(path), bytes: statSync(path).size };
  const target = objectPath(root, info);
  if (existsSync(target)) {
    checkObject(root, info);
    rmSync(path);
  } else {
    syncPath(path);
    renameSync(path, target);
    syncPath(dirname(target));
  }
  return info;
}

function snapshot(db: Database, path: string) {
  db.query("VACUUM INTO ?").run(path);
}

/** 主库先固定水位；月库正文只追加，因此随后快照仍包含水位前的所有引用。 */
export function backupStorage(db: Database, directory: string) {
  const root = resolve(directory);
  for (const folder of ["objects", "manifests", "shards"]) mkdirSync(join(root, folder), { recursive: true });
  const stage = mkdtempSync(join(root, ".backup-"));
  const copiedMonths: string[] = [];
  const reusedMonths: string[] = [];
  try {
    const mainPath = join(stage, "main.db");
    snapshot(db, mainPath);
    const main = new Database(mainPath, { readonly: true });
    const shards: ShardInfo[] = [];
    let foreignKeys: { count: number; hash: string };
    try {
      const refs = hasPayloadCatalog(main) ? main.query("SELECT * FROM payload_refs ORDER BY month,hash,bytes").all() as PayloadRef[] : [];
      for (const ref of refs) validatePayloadRef(main, ref);
      for (const month of [...new Set(refs.map(ref => ref.month))]) {
        const required = refs.filter(ref => ref.month === month);
        const inventory = digest(JSON.stringify([...new Set(required.map(ref => `${ref.hash}:${ref.bytes}`))]));
        const cachePath = join(root, "shards", `${month}-${inventory}.json`);
        let info: ObjectInfo;
        if (existsSync(cachePath)) {
          info = JSON.parse(readFileSync(cachePath, "utf8"));
          checkObject(root, info);
          reusedMonths.push(month);
        } else {
          const source = shardPath(db, month);
          if (!existsSync(source)) throw new Error(`Missing payload shard: ${month}`);
          const shard = new Database(source, { readonly: true });
          const target = join(stage, `${month}.db`);
          try { snapshot(shard, target); } finally { shard.close(); }
          info = publishObject(root, target);
          copiedMonths.push(month);
        }
        const stored = new Database(checkObject(root, info), { readonly: true });
        try { for (const ref of required) readShardPayload(stored, ref); } finally { stored.close(); }
        const cacheTemp = join(stage, `${month}.json`);
        writeFileSync(cacheTemp, JSON.stringify(info));
        syncPath(cacheTemp);
        renameSync(cacheTemp, cachePath);
        syncPath(dirname(cachePath));
        shards.push({ month, ...info });
      }
      if ((main.query("PRAGMA quick_check").get() as any).quick_check !== "ok") throw new Error("Invalid main snapshot");
      foreignKeys = foreignKeySummary(main);
    } finally { main.close(); }
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), main: publishObject(root, mainPath), shards, foreignKeys };
    const tempManifest = join(stage, "manifest.json");
    writeFileSync(tempManifest, JSON.stringify(manifest, null, 2));
    syncPath(tempManifest);
    const path = join(root, "manifests", `${Date.now()}-${randomUUID()}.json`);
    renameSync(tempManifest, path);
    syncPath(dirname(path));
    return { manifest: path, copiedMonths, reusedMonths, foreignKeyViolations: foreignKeys.count };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/** 只恢复到新目录；校验全部对象和引用后，原子发布整个目录，不覆盖运行库。 */
export function restoreStorage(manifestPath: string, directory: string) {
  const destination = resolve(directory);
  if (existsSync(destination)) throw new Error("Restore destination already exists; refusing to overwrite");
  const root = dirname(dirname(resolve(manifestPath)));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.shards)) throw new Error("Unsupported backup manifest");
  checkObject(root, manifest.main);
  const seen = new Set<string>();
  for (const shard of manifest.shards) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(shard.month) || seen.has(shard.month)) throw new Error("Invalid or duplicate backup month");
    seen.add(shard.month);
    checkObject(root, shard);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), ".restore-"));
  try {
    const path = join(stage, "main.db");
    copyFileSync(checkObject(root, manifest.main), path);
    syncPath(path);
    const main = new Database(path, { readonly: true });
    try {
      for (const shard of manifest.shards) {
        const target = shardPath(main, shard.month);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(checkObject(root, shard), target);
        syncPath(target);
      }
      verifyPayloads(main, manifest.foreignKeys);
    } finally { main.close(); }
    if (existsSync(join(stage, "main.db.payloads"))) syncPath(join(stage, "main.db.payloads"));
    syncPath(stage);
    renameSync(stage, destination);
    syncPath(dirname(destination));
    return { restored: true, db: join(destination, "main.db"), foreignKeyViolations: manifest.foreignKeys?.count ?? 0 };
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
}
