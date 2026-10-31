import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { MemoryService } from "../../packages/server/src/services/memory";

type Plan = {
  sessions: Array<{id:string;directory:string;old_repo:string;repo:string}>;
  memories: Array<{id:string;revision:number;project_id:string;action:"relocate"|"invalidate";quote:string;reason:string}>;
};

export function repairReviewed(db: Database, plan: Plan, apply = false) {
  return db.transaction(() => {
    const before: any = {sessions:[],memories:[],sources:[]};
    for (const item of plan.sessions) {
      const row = db.query("SELECT * FROM sessions WHERE id=?").get(item.id) as any;
      if (!row || row.directory !== item.directory || row.repo_url !== item.old_repo) throw new Error(`Session changed: ${item.id}`);
      before.sessions.push(row);
    }
    for (const item of plan.memories) {
      const row = db.query("SELECT * FROM memories WHERE id=?").get(item.id) as any;
      if (!row || row.revision !== item.revision || row.project_id !== item.project_id || row.agent_key || row.scope !== "project" || row.status !== "active") throw new Error(`Memory changed: ${item.id}`);
      const evidence = db.query("SELECT s.*,m.content FROM memory_sources s JOIN messages m ON m.id=s.message_id AND m.session_id=s.session_id WHERE s.memory_id=? ORDER BY s.revision DESC LIMIT 1").get(item.id) as any;
      if (!evidence || !item.quote || !evidence.content.includes(item.quote) || !item.reason.trim()) throw new Error(`Missing repair evidence: ${item.id}`);
      before.memories.push(row); before.sources.push(evidence);
    }
    if (!apply) return before;
    for (const item of plan.sessions) db.query("UPDATE sessions SET repo_url=? WHERE id=?").run(item.repo,item.id);
    const service = new MemoryService(db);
    for (let i=0;i<plan.memories.length;i++) {
      const item=plan.memories[i]!, row=before.memories[i], source=before.sources[i];
      const now=new Date().toISOString();
      if (item.action === "relocate") {
        const target=service.resolveProject({session_id:row.origin_session_id});
        if (db.query("SELECT 1 FROM memories WHERE project_id=? AND name=? AND id!=?").get(target.id,row.name,row.id)) throw new Error(`Target name exists: ${row.name}`);
        db.query("UPDATE memories SET project_id=?,context_json=?,revision=revision+1,updated_at=? WHERE id=?").run(target.id,JSON.stringify({scope:"project",repo_url:`git://${target.key.slice(5)}`}),now,row.id);
      } else if (item.action === "invalidate") {
        db.query("UPDATE memories SET body='',description='',status='forgotten',revision=revision+1,updated_at=?,forgotten_at=?,forgotten_sequence=(SELECT COALESCE(MAX(sequence),0) FROM memory_message_arrivals) WHERE id=?").run(now,now,row.id);
      } else throw new Error("Unknown repair action");
      db.query("INSERT INTO memory_sources(memory_id,revision,session_id,message_id,job_id,explicit,action,created_at,assessment_json) VALUES (?,?,?,?,NULL,0,?,?,?)").run(row.id,row.revision+1,source.session_id,source.message_id,item.action,now,JSON.stringify({quote:item.quote,retention_reason:item.reason,scope_reason:item.action==="relocate"?"经人工核对来源工作目录的 Git remote，纠正错误项目身份":"撤销不满足长期留存条件的自动提取"}));
    }
    return {sessions:plan.sessions.length,memories:plan.memories.length};
  })();
}

if (import.meta.main) {
  const [dbPath,planPath,mode]=process.argv.slice(2);
  if (!dbPath || !planPath) throw new Error("Usage: bun scripts/memory/repair-reviewed.ts <db> <reviewed-plan.json> [--apply]");
  const db=new Database(dbPath);db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  const plan=await Bun.file(planPath).json();
  const before=repairReviewed(db,plan);
  if (mode==="--apply") {
    writeFileSync(planPath+".before.json",JSON.stringify(before,null,2),{mode:0o600,flag:"wx"});
    console.log(repairReviewed(db,plan,true));
  } else console.log({dry_run:true,sessions:before.sessions.length,memories:before.memories.length});
  db.close();
}
