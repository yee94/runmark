import type { Database } from "bun:sqlite";
import { PAYLOAD_TABLES, externalizePayloads, initializePayloadStorage, payloadsEnabled, readPayload, validatePayloadRef, type PayloadRef, type PayloadTable } from "./payloads";

export function migratePayloads(db: Database, batchSize = 500, maxBatches = Infinity, skipCompleted = false) {
  initializePayloadStorage(db);
  if (skipCompleted && payloadsEnabled(db) && (db.query("SELECT migration_complete FROM payload_storage WHERE id=1").get() as { migration_complete: number }).migration_complete) {
    return { complete: true, skipped: true, processed: 0, externalized: 0 };
  }
  initializePayloadStorage(db, true);
  db.exec("CREATE TABLE IF NOT EXISTS payload_migrations (table_name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL)");
  let processed = 0;
  let externalized = 0;
  let batches = 0;
  for (const table of Object.keys(PAYLOAD_TABLES) as PayloadTable[]) {
    while (true) {
      const cursor = (db.query("SELECT last_rowid FROM payload_migrations WHERE table_name=?").get(table) as { last_rowid: number } | null)?.last_rowid ?? 0;
      const rows = db.query(`SELECT rowid AS cursor, id FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(cursor, batchSize) as { cursor: number; id: string | number }[];
      if (!rows.length) break;
      if (batches >= maxBatches) return { complete: false, processed, externalized };
      db.transaction(() => {
        for (const row of rows) externalized += externalizePayloads(db, table, row.id);
        db.query("INSERT OR REPLACE INTO payload_migrations VALUES (?, ?)").run(table, rows.at(-1)!.cursor);
      }).immediate();
      processed += rows.length;
      batches++;
    }
  }
  db.transaction(() => {
    db.exec("DROP TABLE payload_migrations");
    db.exec("UPDATE payload_storage SET migration_complete=1 WHERE id=1");
  })();
  return { complete: true, processed, externalized };
}

/** 可中断重试；先关闭新外置写入，逐批把所有引用还原为旧版可读正文。 */
export function inlinePayloads(db: Database, batchSize = 500) {
  initializePayloadStorage(db, false);
  db.exec("UPDATE payload_storage SET migration_complete=0 WHERE id=1");
  let restored = 0;
  while (true) {
    const count = db.transaction(() => {
      const refs = db.query("SELECT * FROM payload_refs LIMIT ?").all(batchSize) as PayloadRef[];
      for (const ref of refs) {
        validatePayloadRef(db, ref);
        const text = readPayload(db, ref);
        if (!db.query(`SELECT 1 FROM ${ref.table_name} WHERE id=?`).get(ref.row_id)) throw new Error("Dangling payload reference");
        db.query(`UPDATE ${ref.table_name} SET ${ref.field}=? WHERE id=?`).run(text, ref.row_id);
      }
      return refs.length;
    }).immediate();
    restored += count;
    if (!count) break;
  }
  db.exec("DROP TABLE IF EXISTS payload_migrations");
  return { complete: true, restored, enabled: false };
}
