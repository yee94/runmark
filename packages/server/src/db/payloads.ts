import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const PAYLOAD_TABLES = {
  tool_calls: { time: "created_at", fields: ["args", "output_metadata", "output_text"] },
  agent_jobs: { time: "started_at", fields: ["input_json", "prompt", "output_json"] },
  agent_tool_calls: { time: "created_at", fields: ["args", "result"] },
  ingest_events: { time: "received_at", fields: ["event_json"] },
} as const;
export type PayloadTable = keyof typeof PAYLOAD_TABLES;
export type PayloadRef = { table_name: PayloadTable; row_id: string; field: string; month: string; hash: string; bytes: number };
const THRESHOLD = 4096;
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function databasePath(db: Database): string {
  const row = (db.query("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main");
  if (!row?.file) throw new Error("Monthly payload storage requires a file-backed database");
  return row.file;
}

export function hasPayloadCatalog(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payload_storage'").get();
}

/** 仅增加目录和引用表；默认继续内联，已有引用始终可读。 */
export function initializePayloadStorage(db: Database, enabled?: boolean): void {
  db.exec(`CREATE TABLE IF NOT EXISTS payload_storage (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, enabled INTEGER NOT NULL);
    INSERT OR IGNORE INTO payload_storage (id, version, enabled) VALUES (1, 1, 0);
    CREATE TABLE IF NOT EXISTS payload_refs (
      table_name TEXT NOT NULL, row_id TEXT NOT NULL, field TEXT NOT NULL,
      month TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(table_name, row_id, field));`);
  const version = db.query("SELECT version FROM payload_storage WHERE id=1").get() as { version: number };
  if (version.version !== 1) throw new Error(`Unsupported payload storage version: ${version.version}`);
  const storageColumns = db.query("PRAGMA table_info(payload_storage)").all() as { name: string }[];
  if (!storageColumns.some(column => column.name === "migration_complete")) db.exec("ALTER TABLE payload_storage ADD COLUMN migration_complete INTEGER NOT NULL DEFAULT 0");
  const columns = db.query("PRAGMA table_info(ingest_events)").all() as { name: string }[];
  if (!columns.some(column => column.name === "event_hash")) db.exec("ALTER TABLE ingest_events ADD COLUMN event_hash TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_event_hash ON ingest_events(source, event_key, event_hash)");
  for (const [table, spec] of Object.entries(PAYLOAD_TABLES)) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS payload_delete_${table} AFTER DELETE ON ${table} BEGIN
      DELETE FROM payload_refs WHERE table_name='${table}' AND row_id=CAST(OLD.id AS TEXT); END;`);
    for (const field of spec.fields) db.exec(`CREATE TRIGGER IF NOT EXISTS payload_update_${table}_${field} AFTER UPDATE OF ${field} ON ${table} BEGIN
      DELETE FROM payload_refs WHERE table_name='${table}' AND row_id=CAST(OLD.id AS TEXT) AND field='${field}'; END;`);
  }
  if (enabled !== undefined) {
    if (enabled) databasePath(db);
    db.query("UPDATE payload_storage SET enabled=? WHERE id=1").run(enabled ? 1 : 0);
  }
}

export function payloadsEnabled(db: Database): boolean {
  return hasPayloadCatalog(db) && !!(db.query("SELECT enabled FROM payload_storage WHERE id=1").get() as { enabled: number })?.enabled;
}

export function shardPath(db: Database, month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid payload month: ${month}`);
  return join(`${databasePath(db)}.payloads`, `${month}.db`);
}

function monthOf(value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid payload timestamp: ${value}`);
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 7);
}

function savePayload(db: Database, month: string, text: string): { hash: string; bytes: number } {
  const path = shardPath(db, month);
  if (!existsSync(path) && db.query("SELECT 1 FROM payload_refs WHERE month=? LIMIT 1").get(month)) throw new Error(`Missing payload shard: ${month}`);
  mkdirSync(`${databasePath(db)}.payloads`, { recursive: true });
  const shard = new Database(path, { create: true });
  try {
    shard.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS payloads (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, codec TEXT NOT NULL, body BLOB NOT NULL);`);
    const raw = Buffer.from(text);
    const hash = digest(raw);
    shard.query("INSERT OR IGNORE INTO payloads VALUES (?, ?, 'deflate', ?)").run(hash, raw.length, deflateRawSync(raw));
    const ref = { hash, bytes: raw.length };
    // 已存在的内容也校验，不能把新引用提交到一个损坏的 payload。
    readShardPayload(shard, { month, ...ref });
    for (const directory of [dirname(path), dirname(dirname(path))]) {
      const fd = openSync(directory, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return ref;
  } finally { shard.close(); }
}

export function readShardPayload(shard: Database, ref: Pick<PayloadRef, "month" | "hash" | "bytes">): string {
  const row = shard.query("SELECT bytes, codec, body FROM payloads WHERE hash=?").get(ref.hash) as { bytes: number; codec: string; body: Uint8Array } | null;
  if (!row || row.codec !== "deflate" || row.bytes !== ref.bytes) throw new Error(`Missing or invalid payload: ${ref.month}/${ref.hash}`);
  const raw = inflateRawSync(row.body, { maxOutputLength: Math.max(1, ref.bytes) });
  if (raw.length !== ref.bytes || digest(raw) !== ref.hash) throw new Error(`Payload checksum mismatch: ${ref.month}/${ref.hash}`);
  return raw.toString("utf8");
}

export function validatePayloadRef(db: Database, ref: PayloadRef): void {
  if (!Object.hasOwn(PAYLOAD_TABLES, ref.table_name) || !(PAYLOAD_TABLES[ref.table_name].fields as readonly string[]).includes(ref.field)
    || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("Invalid payload reference");
  shardPath(db, ref.month);
  if (!db.query(`SELECT 1 FROM ${ref.table_name} WHERE id=?`).get(ref.row_id)) throw new Error(`Dangling payload reference: ${ref.table_name}/${ref.row_id}`);
}

export function readPayload(db: Database, ref: PayloadRef): string {
  const path = shardPath(db, ref.month);
  if (!existsSync(path)) throw new Error(`Missing payload shard: ${ref.month}`);
  const shard = new Database(path, { readonly: true });
  try { return readShardPayload(shard, ref); } finally { shard.close(); }
}

/** 引用在主库事务中提交；不可变正文先独立落盘，失败最多留下无引用正文。 */
export function externalizePayloads(db: Database, table: PayloadTable, id: string | number): number {
  if (!payloadsEnabled(db)) return 0;
  return db.transaction(() => {
    const row = db.query(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, any> | null;
    if (!row) return 0;
    let count = 0;
    for (const field of PAYLOAD_TABLES[table].fields) {
      if (db.query("SELECT 1 FROM payload_refs WHERE table_name=? AND row_id=? AND field=?").get(table, String(id), field)) continue;
      const text = row[field];
      if (typeof text !== "string" || Buffer.byteLength(text) < THRESHOLD) continue;
      let timestamp = row[PAYLOAD_TABLES[table].time];
      let placeholder: string | null = null;
      if (table === "ingest_events") {
        const event = JSON.parse(text);
        timestamp = event.created_at ?? timestamp;
        if (String(event.type).startsWith("session.")) continue;
        const { content, args, output_text, output_metadata, ...projection } = event;
        placeholder = JSON.stringify({ ...projection, _runmark_payload_hash: digest(text) });
      }
      const month = monthOf(timestamp);
      const ref = savePayload(db, month, text);
      if (table === "ingest_events") db.query("UPDATE ingest_events SET event_hash=? WHERE id=?").run(ref.hash, id);
      db.query(`UPDATE ${table} SET ${field}=? WHERE id=?`).run(placeholder, id);
      db.query("INSERT OR REPLACE INTO payload_refs VALUES (?, ?, ?, ?, ?, ?)").run(table, String(id), field, month, ref.hash, ref.bytes);
      count++;
    }
    return count;
  })();
}

/** 只还原调用方选出的字段，避免列表查询意外加载全部正文。 */
export function hydratePayloads<T>(db: Database, table: PayloadTable, row: T): T {
  if (!row || !hasPayloadCatalog(db)) return row;
  return db.transaction(() => {
    const result = { ...row } as Record<string, any>;
    const fields = (PAYLOAD_TABLES[table].fields as readonly string[]).filter(field => Object.hasOwn(result, field));
    if (!fields.length) return row;
    // 与引用目录使用同一个读快照，避免并行 inline 后拿到旧 NULL、新目录。
    const current = db.query(`SELECT ${fields.join(",")} FROM ${table} WHERE id=?`).get(result.id);
    if (current) Object.assign(result, current);
    const refs = db.query("SELECT * FROM payload_refs WHERE table_name=? AND row_id=?").all(table, String(result.id)) as PayloadRef[];
    for (const ref of refs) if (Object.hasOwn(result, ref.field)) result[ref.field] = readPayload(db, ref);
    return result as T;
  })();
}

/** 月库正文仍使用 SQLite LIKE，保留转义符及大小写语义，匹配后再应用 LIMIT。 */
export function searchToolPayloads(db: Database, sessionId: string, like: string, limit: number) {
  const external = hasPayloadCatalog(db) ? "OR EXISTS (SELECT 1 FROM payload_refs r WHERE r.table_name='tool_calls' AND r.row_id=tool_calls.id AND r.field='output_text')" : "";
  const candidates = db.query(`SELECT id, tool_name, output_title, output_text, created_at FROM tool_calls
    WHERE session_id=? AND (tool_name LIKE ? ESCAPE '\\' OR IFNULL(output_title,'') LIKE ? ESCAPE '\\'
    OR IFNULL(output_text,'') LIKE ? ESCAPE '\\' ${external}) ORDER BY created_at ASC`);
  const matches: Array<{ id: string; tool_name: string; output_title: string | null; output_text: string | null; created_at: string }> = [];
  for (const candidate of candidates.iterate(sessionId, like, like, like)) {
    const row = hydratePayloads(db, "tool_calls", candidate) as typeof matches[number];
    const matched = db.query("SELECT (? LIKE ? ESCAPE '\\' OR IFNULL(?,'') LIKE ? ESCAPE '\\' OR IFNULL(?,'') LIKE ? ESCAPE '\\') AS matched")
      .get(row.tool_name, like, row.output_title, like, row.output_text, like) as { matched: number };
    if (matched.matched) matches.push(row);
    if (matches.length >= limit) break;
  }
  return matches;
}

export function foreignKeySummary(db: Database): { count: number; hash: string } {
  const violations = db.query("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number | null; parent: string; fkid: number }>;
  const normalized = violations.map(row => JSON.stringify([row.table, row.rowid, row.parent, row.fkid])).sort();
  return { count: normalized.length, hash: digest(JSON.stringify(normalized)) };
}

export function verifyPayloads(db: Database, expectedForeignKeys?: { count: number; hash: string }) {
  const refs = hasPayloadCatalog(db) ? db.query("SELECT * FROM payload_refs ORDER BY month").all() as PayloadRef[] : [];
  const months = [...new Set(refs.map(ref => ref.month))];
  for (const month of months) {
    const path = shardPath(db, month);
    if (!existsSync(path)) throw new Error(`Missing payload shard: ${month}`);
    const shard = new Database(path, { readonly: true });
    try {
      if ((shard.query("PRAGMA quick_check").get() as any).quick_check !== "ok") throw new Error(`Corrupt shard: ${month}`);
      for (const ref of refs.filter(ref => ref.month === month)) {
        validatePayloadRef(db, ref);
        readShardPayload(shard, ref);
      }
    } finally { shard.close(); }
  }
  if ((db.query("PRAGMA quick_check").get() as any).quick_check !== "ok") throw new Error("Corrupt main database");
  const foreignKeys = foreignKeySummary(db);
  if (foreignKeys.count && (!expectedForeignKeys || foreignKeys.count !== expectedForeignKeys.count || foreignKeys.hash !== expectedForeignKeys.hash)) throw new Error(`Main database foreign key check failed: ${foreignKeys.count} violations`);
  if (expectedForeignKeys && (foreignKeys.count !== expectedForeignKeys.count || foreignKeys.hash !== expectedForeignKeys.hash)) throw new Error("Main database foreign key baseline mismatch");
  return { valid: true, months, references: refs.length, enabled: payloadsEnabled(db), foreignKeyViolations: foreignKeys.count };
}
