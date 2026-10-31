import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../packages/server/src/db";
import { loadConfig } from "../../packages/server/src/config";
import { getAgentRuntime, MEMORY_EXTRACTION_AGENT_ID } from "../../packages/server/src/services/agents";

// 显式运行：使用已配置模型，但所有验收数据仅写入内存库。
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Usage: bun scripts/memory/evaluate-extraction.ts <configured-server.db>");
const source = new Database(sourcePath, { readonly: true });
const cases = [
  { name: "one-off-diagram", repo: "https://github.com/yee94/opencode-eficy", text: "给我解释全画幅和 APS-C 的区别，用 eficy 把原理图绘制出来，连图带文，其他型号也一并类比。", scope: null },
  { name: "scheduled-replay", repo: "https://github.com/yee94/yuri", text: "在项目 /workspace/ai-monorepo 下执行：使用 qk80-magpie-theme skill 更新键盘主题，数据采集、生图、裁剪和上传按 skill 执行，全程静默，无需确认。特别要求：热点按 daily-lineart.md 顺序轮换，每次新任务调用一次 topic-rotation.mjs；同日共享热点池和游标，生图重试沿用本次选题。每次运行新建递增目录 run-001、run-002，保存数值快照、选题副本、生成图、裁剪图及上传结果，保留历史产物。键盘未连接时照常生成静态图。以上要求优先于 skill 中复用旧 topic 或覆盖同日产物的说明。完成后用一句话汇报费用、Token、余额、热点及上传状态，展示本次 preview-3x.png。", scope: null },
  { name: "wrong-project", repo: "https://github.com/example/app", text: "Yuri 已有亮暗两套图标，我要求 Yuri 的 Dock 图标跟随应用内主题，而不是系统主题。", scope: null },
  { name: "product-constraint", repo: "https://github.com/yee94/yuri", text: "Yuri 已有亮暗两套图标，我要求 Yuri 的 Dock 图标跟随应用内主题，而不是系统主题。", scope: "project" },
  { name: "global-preference", repo: "https://github.com/example/app", text: "以后无论在哪个项目，解释复杂概念时都先给我图文结合的直观说明，再展开技术细节。这是我的长期偏好。", scope: "global" },
  { name: "global-feedback", repo: "https://github.com/yee94/yuri", text: "刚才先查文档、核对代码再下结论的方式很好，以后所有项目都这样协作。", scope: "global" },
];
let failures = 0;
for (const item of cases) {
  if (process.argv[3] && item.name !== process.argv[3]) continue;
  const db = new Database(":memory:");
  initializeDatabase(db);
  for (const table of ["agent_providers", "agent_models"]) for (const row of source.query(`SELECT * FROM ${table}`).all() as Record<string, any>[]) {
    const columns = Object.keys(row);
    db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${columns.filter(c=>c!=="id").map(c=>`${c}=excluded.${c}`).join(",")}`).run(...Object.values(row));
  }
  const agent = source.query("SELECT model_id FROM agents WHERE id=?").get(MEMORY_EXTRACTION_AGENT_ID) as {model_id:string};
  db.query("UPDATE agents SET model_id=?,enabled=1 WHERE id=?").run(agent.model_id,MEMORY_EXTRACTION_AGENT_ID);
  db.query("INSERT INTO sessions(id,agent,repo_url,directory,started_at) VALUES (?,'evaluation',?,'/evaluation',?)").run(item.name,item.repo,new Date().toISOString());
  db.query("INSERT INTO messages(id,session_id,role,content,created_at) VALUES (?,?,'user',?,?)").run(item.name,item.name,item.text,new Date().toISOString());
  const job = await getAgentRuntime(db, loadConfig()).runAgent(MEMORY_EXTRACTION_AGENT_ID,{session_id:item.name});
  const records = db.query("SELECT scope FROM memories WHERE status='active'").all() as {scope:string}[];
  const passed = job.status === "success" && (item.scope === null ? records.length === 0 : records.length > 0 && records.every(row=>row.scope===item.scope));
  if (!passed) failures++;
  console.log(JSON.stringify({case:item.name,passed,status:job.status,expected:item.scope,scopes:records.map(r=>r.scope),output:JSON.parse(job.output_json || "null"),error:job.error}));
  db.close();
}
source.close();
if (failures) process.exitCode=1;
