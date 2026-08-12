/**
 * 本地 / 开发机：按官方 API 价重算 grok-build / xai / grok 历史 turns。
 *
 * 用法（在 packages/server 或 monorepo 根）:
 *   bun packages/server/scripts/reprice-grok.ts
 *   bun packages/server/scripts/reprice-grok.ts --from 2026-07-24 --to 2026-07-27
 *
 * 需 AGENT_TRACKER_DB_PATH 或默认 data/agent-tracker.db。
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { DEFAULT_PRICING } from "@agent-tracker/shared";
import { costService } from "../src/services/cost";
import { repriceTurns } from "../src/services/reprice";

function parseArgs(argv: string[]) {
  let from: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) from = argv[++i];
    else if (argv[i] === "--to" && argv[i + 1]) to = argv[++i];
  }
  return { from, to };
}

const dbPath =
  process.env.AGENT_TRACKER_DB_PATH ||
  resolve(import.meta.dir, "../data/agent-tracker.db");

const { from, to } = parseArgs(process.argv.slice(2));

costService.setPricing(DEFAULT_PRICING);
const db = new Database(dbPath);

const result = repriceTurns(db, {
  from: from ? (from.includes("T") ? from : `${from}T00:00:00.000Z`) : undefined,
  to: to ? (to.includes("T") ? to : `${to}T23:59:59.999Z`) : undefined,
  providers: ["grok-build", "xai", "grok"],
  limit: 100_000,
});

console.log(JSON.stringify(result, null, 2));
db.close();
