/**
 * 数据修正脚本：重置 2026-06-19 以来所有 Cursor 会话的 turns/cost，
 * 然后用修复后的 enrichSessionUsage 重新对账。
 * 
 * 用法：bun run fix-cursor-data.ts
 * 可选参数：--dry-run 只查不改
 */

import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/db/schema";
import { enrichSessionUsage, recalculateSessionTotals } from "../src/services/cursorEnrich";

const DRY_RUN = Bun.argv.includes("--dry-run");
const SINCE = "2026-06-16";
const SINCE_EPOCH = Math.floor(new Date(SINCE + "T00:00:00Z").getTime() / 1000);

// 使用绝对路径避免 cwd 问题
const DB_PATH = process.env.AGENT_TRACKER_DB_PATH ?? "data/agent-tracker.db";
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// 确保 schema 存在
db.exec(SCHEMA_SQL);

// ---- 0. 收集受影响数据 ----
const stats = {
  turns: 0,
  events: 0,
  sessions: 0,
};

const turnCount = (db.query(`
  SELECT COUNT(*) as c FROM turns
  WHERE provider = 'cursor' AND created_at >= $since AND id NOT LIKE 'cursor-usage-%'
`).get({ $since: SINCE }) as { c: number }).c;
stats.turns = turnCount;

const eventCount = (db.query(`
  SELECT COUNT(*) as c FROM cursor_usage_events
  WHERE timestamp >= $since_epoch AND enriched_at IS NOT NULL
`).get({ $since_epoch: SINCE_EPOCH }) as { c: number }).c;
stats.events = eventCount;

const sessionRows = db.query(`
  SELECT id FROM sessions WHERE agent = 'cursor' AND started_at >= $since ORDER BY started_at
`).all({ $since: SINCE }) as Array<{ id: string }>;
stats.sessions = sessionRows.length;

console.log("=== 数据修正脚本 ===");
console.log(`模式: ${DRY_RUN ? "DRY RUN (只查不改)" : "执行修正"}`);
console.log(`时间范围: ${SINCE} 至今`);
console.log(`  cursor turns:  ${turnCount}`);
console.log(`  usage events:  ${eventCount} (已 enrich 待重置)`);
console.log(`  cursor sessions: ${sessionRows.length}`);
console.log();

if (DRY_RUN) {
  // 展示当前严重异常的 session
  const badSessions = db.query(`
    SELECT id, model, total_tokens, total_cost_usd, started_at
    FROM sessions
    WHERE agent = 'cursor' AND started_at >= $since
    ORDER BY total_cost_usd DESC
    LIMIT 10
  `).all({ $since: SINCE });
  
  console.log("Top 10 异常 Session（按费用降序）:");
  for (const s of badSessions as any[]) {
    console.log(`  ${s.id.slice(0, 20)}...  model=${s.model}  tokens=${(s.total_tokens/10000).toFixed(1)}万  cost=$${s.total_cost_usd.toFixed(2)}  ${s.started_at}`);
  }
  
  console.log("\n运行 bun run fix-cursor-data.ts 执行修正");
  process.exit(0);
}

// ---- 1. 停止定时对账，避免并发写入 ----
// 注：当前服务仍在运行，先暂停 cursor sync scheduler
// 但 scheduler 在服务进程内，这里无法直接控制。
// 建议：先 kill 服务，执行脚本，再启动服务
console.log("⚠️  请在执行前手动停止服务，避免 SQLite 并发写入冲突");
console.log("   # 示例：ssh root@<服务地址> -p <SSH端口> 'pkill -f \"bun src/index.ts\"'");

console.log("");
console.log("如果确认服务已停止，按 Enter 继续...");

// 跳过交互（自动化运行时不等待输入）
const AUTO = Bun.argv.includes("--auto");
if (!AUTO) {
  console.log("(使用 --auto 跳过此确认)");
  console.log("继续执行中...");
}

// ---- 2. 重置 cursor turns ----
console.log("\n[1/4] 重置 cursor turns (token/cost → 0)...");
const turnResult = db.query(`
  UPDATE turns SET
    input_tokens = 0, output_tokens = 0,
    cache_read_tokens = 0, cache_write_tokens = 0, reasoning_tokens = 0,
    total_tokens = 0, cost_usd = 0
  WHERE provider = 'cursor'
    AND created_at >= $since
    AND id NOT LIKE 'cursor-usage-%'
`).run({ $since: SINCE });
console.log(`  已重置 ${turnResult.changes} 个 turns`);

// ---- 3. 重置 enriched_at ----
console.log("\n[2/4] 重置 cursor_usage_events enriched_at → NULL...");
const eventResult = db.query(`
  UPDATE cursor_usage_events SET enriched_at = NULL
  WHERE timestamp >= $since_epoch AND enriched_at IS NOT NULL
`).run({ $since_epoch: SINCE_EPOCH });
console.log(`  已重置 ${eventResult.changes} 个 events`);

// ---- 4. 重置 session totals ----
console.log("\n[3/4] 重置 cursor session 聚合字段...");
db.query(`
  UPDATE sessions SET
    total_input_tokens = 0, total_output_tokens = 0,
    total_tokens = 0, total_cost_usd = 0, request_count = 0
  WHERE agent = 'cursor' AND started_at >= $since
`).run({ $since: SINCE });
console.log(`  已重置 ${sessionRows.length} 个 sessions`);

// ---- 5. 重新 enrich ----
console.log("\n[4/4] 重新 enrich 每个 session...");
let totalEnriched = 0;
let successCount = 0;
let failCount = 0;

for (let i = 0; i < sessionRows.length; i++) {
  const sid = sessionRows[i].id;
  try {
    const enriched = enrichSessionUsage(db, sid);
    if (enriched > 0) {
      totalEnriched += enriched;
      successCount++;
      console.log(`  [${i+1}/${sessionRows.length}] ${sid.slice(0, 20)}... enriched=${enriched} events`);
    } else {
      console.log(`  [${i+1}/${sessionRows.length}] ${sid.slice(0, 20)}... no events matched`);
    }
  } catch (err) {
    failCount++;
    console.error(`  [${i+1}/${sessionRows.length}] ${sid.slice(0, 20)}... FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- 6. 确保全部 session 的 total 正确 ----
console.log("\n[验证] 重新计算所有 session totals...");
for (const s of sessionRows) {
  recalculateSessionTotals(db, s.id);
}

// ---- 7. 汇总 ----
console.log("\n=== 修正完成 ===");
console.log(`  处理 session: ${sessionRows.length} (成功=${successCount}, 无事件=${sessionRows.length - successCount - failCount}, 失败=${failCount})`);
console.log(`  匹配事件: ${totalEnriched}`);
console.log();

// 验证目标 session（长开会话费用放大样例）
const targetSid = "3a1921ff-b724-45e8-80bc-cabb4ebb9012";
const targetSession = db.query(`
  SELECT id, model, total_tokens, total_cost_usd, request_count FROM sessions WHERE id = $id
`).get({ $id: targetSid }) as any;
if (targetSession) {
  console.log(`目标 Session ${targetSid.slice(0, 20)}...:`);
  console.log(`  model: ${targetSession.model}`);
  console.log(`  total_tokens: ${(targetSession.total_tokens/10000).toFixed(1)}万`);
  console.log(`  total_cost_usd: $${targetSession.total_cost_usd?.toFixed(2)}`);
  console.log(`  request_count: ${targetSession.request_count}`);
  
  const turns = db.query(`
    SELECT model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd, created_at
    FROM turns WHERE session_id = $id AND id NOT LIKE 'cursor-usage-%'
    ORDER BY created_at
  `).all({ $id: targetSid }) as any[];
  console.log(`  turns: ${turns.length}`);
  for (const t of turns) {
    console.log(`    ${t.created_at}: ${t.model} tokens=${(t.total_tokens/10000).toFixed(1)}万 cost=$${t.cost_usd?.toFixed(2)}`);
  }
} else {
  console.log(`目标 Session ${targetSid} 不在本次修正范围`);
}
