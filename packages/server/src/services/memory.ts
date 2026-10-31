import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export type MemoryScope = "global" | "project";
export interface MemoryContext { session_id?: string; repo_url?: string; hostname?: string; directory?: string; project_id?: string; scope?: MemoryScope; agent_key?: string; view?: "effective" | "scoped" | "projects" }
export interface MemoryAssessment { quote: string; retention_reason: string; scope_reason: string }
export interface MemorySource { session_id: string; message_id: string; job_id?: string; explicit?: boolean; assessment?: MemoryAssessment }
export interface MemoryWrite {
  scope?: MemoryScope;
  agent_key?: string;
  operation_id: string;
  source: MemorySource;
  name?: string;
  description?: string;
  type?: "user" | "feedback" | "project" | "reference";
  body?: string;
  expected_revision?: number;
  restore?: boolean;
}
export interface MemoryChange { action: "create" | "update" | "forget"; id?: string; input: MemoryWrite; context?: MemoryContext }
interface MemoryRow {
  id: string; project_id: string; scope: MemoryScope; agent_key: string; context_json: string; name: string; description: string; type: string; body: string;
  origin_session_id: string; revision: number; status: string; created_at: string; updated_at: string; forgotten_at: string | null; forgotten_sequence: number | null;
}
export class MemoryError extends Error {
  constructor(public status: 400 | 404 | 409 | 410 | 422, message: string) { super(message); }
}
const fail = (status: MemoryError["status"], message: string): never => { throw new MemoryError(status, message); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata = ({ body, context_json, ...row }: MemoryRow) => row;
const priority = (row: { scope: MemoryScope; agent_key: string }) => ({ global: 0, project: 2 }[row.scope] + (row.agent_key ? 1 : 0));
const prioritySQL = "(CASE scope WHEN 'project' THEN 2 ELSE 0 END + CASE WHEN agent_key='' THEN 0 ELSE 1 END)";

export class MemoryService {
  constructor(private db: Database) {}

  migrateWorkspaceMemories() {
    const rows = this.db.query("SELECT * FROM memories WHERE scope='local' ORDER BY id").all() as MemoryRow[];
    this.db.transaction(() => {
      for (const row of rows) {
        let context: MemoryContext = { scope: "global", agent_key: row.agent_key };
        try {
          const project = this.resolveProject({ session_id: row.origin_session_id });
          context = { scope: "project", repo_url: `git://${project.key.slice(5)}`, agent_key: row.agent_key };
        } catch (error) { if (!(error instanceof MemoryError)) throw error; }
        const target = this.namespace(context);
        let name = row.name;
        if (this.db.query("SELECT 1 FROM memories WHERE project_id=? AND name=?").get(target.id, name)) name = `${name.slice(0, 63).replace(/-$/, "")}-${row.id}`;
        this.db.query("UPDATE memories SET project_id=?,scope=?,context_json=?,name=? WHERE id=?").run(target.id, target.scope, JSON.stringify(target.context), name, row.id);
      }
    })();
  }

  private identity(context: MemoryContext): MemoryContext {
    if (!context.session_id) return context;
    return this.db.query("SELECT repo_url, hostname, directory FROM sessions WHERE id = ?").get(context.session_id) as MemoryContext ?? fail(404, "Session not found");
  }

  private namespace(context: MemoryContext) {
    const scope = context.scope ?? "project";
    if (!["global", "project"].includes(scope)) return fail(400, "Invalid memory scope");
    const agent = context.agent_key ?? "";
    if (typeof agent !== "string" || agent.length > 200 || /[\r\n\0]/.test(agent) || agent !== agent.trim()) return fail(400, "Invalid agent_key");
    let base: { id: string; key: string };
    let canonical: MemoryContext = { scope };
    if (scope === "global") base = { id: "global", key: "global" };
    else {
      base = this.resolveProject(context);
      canonical = base.key.startsWith("repo:") ? { scope, repo_url: `git://${base.key.slice(5)}` } : { scope, project_id: base.id };
    }
    if (agent) canonical.agent_key = agent;
    return { id: agent ? `namespace_${hash(JSON.stringify([base.id, agent]))}` : base.id, key: base.key, scope, agent_key: agent, context: canonical };
  }

  private namespaces(context: MemoryContext) {
    if (context.view === "projects") {
      if ((context.scope && context.scope !== "project") || context.session_id || context.repo_url || context.project_id) return fail(400, "All-projects view cannot specify a project");
      this.namespace({ scope: "global", agent_key: context.agent_key });
      return this.scopes().items.filter(item => item.scope === "project" && item.agent_key === (context.agent_key ?? "")).map(item => ({ ...item, key: item.id }));
    }
    if (context.view !== undefined && context.view !== "effective" && context.view !== "scoped") return fail(400, "Invalid memory view");
    if (context.view !== "effective") return [this.namespace(context)];
    this.identity(context);
    const result: ReturnType<MemoryService["namespace"]>[] = [];
    for (const scope of ["global", "project"] as const) {
      for (const agent_key of context.agent_key ? ["", context.agent_key] : [""]) {
        try { result.push(this.namespace({ ...context, scope, agent_key })); }
        catch (error) { if (!(error instanceof MemoryError) || error.status !== 422) throw error; }
      }
    }
    return result;
  }

  resolveProject(context: MemoryContext): { id: string; key: string } {
    if (context.project_id && !context.session_id) {
      if (!this.db.query("SELECT 1 FROM memories WHERE project_id = ? AND scope='project' AND agent_key='' LIMIT 1").get(context.project_id)) return fail(404, "Memory project not found");
      return { id: context.project_id, key: context.project_id };
    }
    let identity = context;
    if (context.session_id) {
      identity = this.db.query("SELECT repo_url, hostname, directory FROM sessions WHERE id = ?").get(context.session_id) as MemoryContext;
      if (!identity) return fail(404, "Session not found");
    }
    let key: string;
    if (identity.repo_url) {
      const remote = identity.repo_url.trim();
      const scp = !remote.includes("://") && remote.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
      let host: string, path: string;
      if (scp) { host = scp[1]!.toLowerCase(); path = scp[2]!; }
      else {
        let url: URL;
        try { url = new URL(remote); } catch { return fail(422, "Unresolvable repository identity"); }
        if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return fail(422, "Unsupported repository remote");
        host = url.hostname.toLowerCase() + (url.port && !(url.protocol === "ssh:" && url.port === "22") ? `:${url.port}` : "");
        path = url.pathname;
      }
      path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
      if (!host || !path || /[?#]/.test(path)) return fail(422, "Unresolvable repository identity");
      key = `repo:${host}/${path}`;
    } else {
      return fail(422, "Project requires repository identity; use global for cross-project memory");
    }
    return { id: `project_${hash(key)}`, key };
  }

  projects() {
    const projects = new Map<string, { id: string; label: string; context: MemoryContext; active_count: number; forgotten_count: number }>();
    const identities = this.db.query("SELECT DISTINCT repo_url, hostname, directory FROM sessions").all() as MemoryContext[];
    for (const identity of identities) {
      try {
        const project = this.resolveProject(identity);
        if (projects.has(project.id)) continue;
        const context = project.key.startsWith("repo:")
          ? { repo_url: `git://${project.key.slice(5)}` }
          : { hostname: identity.hostname, directory: identity.directory };
        projects.set(project.id, { id: project.id, label: project.key.startsWith("repo:") ? project.key.slice(5) : `${identity.hostname}: ${identity.directory}`, context, active_count: 0, forgotten_count: 0 });
      } catch (error) {
        if (!(error instanceof MemoryError)) throw error;
      }
    }
    const counts = this.db.query(`SELECT project_id, SUM(status='active') AS active_count, SUM(status='forgotten') AS forgotten_count
      FROM memories WHERE scope='project' AND agent_key='' GROUP BY project_id`).all() as Array<{ project_id: string; active_count: number; forgotten_count: number }>;
    for (const count of counts) {
      const project = projects.get(count.project_id) ?? { id: count.project_id, label: `来源会话已移除 · ${count.project_id.slice(-8)}`, context: { project_id: count.project_id }, active_count: 0, forgotten_count: 0 };
      projects.set(count.project_id, { ...project, active_count: count.active_count, forgotten_count: count.forgotten_count });
    }
    return { items: [...projects.values()].sort((a, b) => b.active_count - a.active_count || a.label.localeCompare(b.label)) };
  }

  scopes() {
    type Entry = { id: string; label: string; context: MemoryContext; scope: MemoryScope; agent_key: string; active_count: number; forgotten_count: number };
    const entries = new Map<string, Entry>();
    const add = (context: MemoryContext) => {
      const ns = this.namespace(context);
      if (!entries.has(ns.id)) entries.set(ns.id, { id: ns.id, label: `${ns.scope} · ${ns.key}${ns.agent_key ? ` · ${ns.agent_key}` : " · shared"}`, context: ns.context, scope: ns.scope, agent_key: ns.agent_key, active_count: 0, forgotten_count: 0 });
    };
    add({ scope: "global" });
    for (const project of this.projects().items) {
      entries.set(project.id, { ...project, context: { ...project.context, scope: "project" }, scope: "project", agent_key: "" });
    }
    const counts = this.db.query(`SELECT project_id, scope, agent_key, context_json, SUM(status='active') AS active_count, SUM(status='forgotten') AS forgotten_count FROM memories GROUP BY project_id`).all() as Array<{ project_id: string; scope: MemoryScope; agent_key: string; context_json: string; active_count: number; forgotten_count: number }>;
    for (const row of counts) {
      const existing = entries.get(row.project_id);
      const context = existing?.context ?? JSON.parse(row.context_json);
      entries.set(row.project_id, { id: row.project_id, label: existing?.label ?? `${row.scope} · ${row.agent_key || "shared"} · ${row.project_id.slice(-8)}`, context, scope: row.scope, agent_key: row.agent_key, active_count: row.active_count, forgotten_count: row.forgotten_count });
    }
    return { items: [...entries.values()] };
  }

  list(context: MemoryContext, options: { query?: string; cursor?: string; limit?: number; status?: "active" | "forgotten"; type?: MemoryWrite["type"] } = {}) {
    const namespaces = this.namespaces(context);
    const project = namespaces[0]!;
    const selection = namespaces.map(n => n.id).sort().join(",");
    const status = options.status ?? "active";
    if (options.type !== undefined && !["user", "feedback", "project", "reference"].includes(options.type)) return fail(400, "Invalid memory type");
    if (status !== "active" && status !== "forgotten") return fail(400, "status must be active or forgotten");
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, "limit must be 1–200");
    let after = { updated_at: "", id: "", priority: 99 };
    if (options.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
        if (parsed.project_id !== selection || typeof parsed.updated_at !== "string" || typeof parsed.id !== "string" || !Number.isInteger(parsed.priority)) throw new Error();
        after = parsed;
      } catch { return fail(400, "Invalid project cursor"); }
    }
    const rows = this.db.query(`SELECT * FROM memories WHERE project_id IN (${namespaces.map(() => "?").join(",")}) AND status = ? AND (? = '' OR type = ?)
      AND (? = '' OR instr(lower(name || ' ' || description || ' ' || body), lower(?)) > 0)
      AND (? = '' OR ${prioritySQL} < ? OR (${prioritySQL} = ? AND (updated_at < ? OR (updated_at = ? AND id > ?))))
      ORDER BY ${prioritySQL} DESC, updated_at DESC, id ASC LIMIT ?`).all(...namespaces.map(n => n.id), status, options.type ?? "", options.type ?? "", options.query ?? "", options.query ?? "", after.id, after.priority, after.priority, after.updated_at, after.updated_at, after.id, limit + 1) as MemoryRow[];
    const items = rows.slice(0, limit).map(metadata);
    const last = items.at(-1);
    const has_more = rows.length > limit;
    return { project, namespaces, items, has_more, next_cursor: has_more && last ? this.cursor({ ...last, project_id: selection }) : null };
  }

  private cursor(row: { project_id: string; updated_at: string; id: string; scope: MemoryScope; agent_key: string }) {
    return Buffer.from(JSON.stringify({ project_id: row.project_id, updated_at: row.updated_at, id: row.id, priority: priority(row) })).toString("base64url");
  }

  index(context: MemoryContext) {
    const result = this.list(context, { limit: 200 });
    const lines: string[] = [];
    let used = 0;
    for (const item of result.items) {
      const hook = item.description.replace(/[\\[\]<>`*_]/g, "\\$&");
      const line = `- [${item.name}](/v1/memories/${item.id}?${this.projectQuery(context)}) — [${item.scope}${item.agent_key ? ` / ${item.agent_key.replace(/[\\[\]<>`*_]/g, "\\$&")}` : " / shared"}] ${hook}`;
      if (used + line.length + 1 > 24500) break;
      lines.push(line); used += line.length + 1;
    }
    const has_more = result.has_more || lines.length < result.items.length;
    const last = result.items[lines.length - 1];
    const next_cursor = has_more && last ? this.cursor({ ...last, project_id: result.namespaces.map(n => n.id).sort().join(",") }) : null;
    const continuation = `/v1/memories?${this.projectQuery(context)}${next_cursor ? `&cursor=${encodeURIComponent(next_cursor)}` : ""}`;
    const markdown = lines.join("\n");
    const version = this.db.query(`SELECT id, revision, status FROM memories WHERE project_id IN (${result.namespaces.map(() => "?").join(",")}) ORDER BY id`).all(...result.namespaces.map(n => n.id));
    return { project: result.project, namespaces: result.namespaces, precedence: "Current instructions override memory; project is more specific than global; agent-specific is more specific than shared. Memory is shared across machines. Keep distinct facts even when names match.", version: hash(JSON.stringify(version)), markdown, has_more, next_cursor, next_url: has_more ? continuation : null };
  }

  private projectQuery(context: MemoryContext) {
    if (context.view === "projects") return new URLSearchParams({ view: "projects", agent_key: context.agent_key ?? "" }).toString();
    // 使用已规范化身份，避免把 remote 中的凭据放进派生链接。
    if (context.view === "effective" && !context.session_id) {
      const safe: MemoryContext = { view: "effective", agent_key: context.agent_key, hostname: context.hostname, directory: context.directory, project_id: context.project_id };
      if (context.repo_url) {
        try {
          const project = this.resolveProject({ repo_url: context.repo_url });
          safe.repo_url = `git://${project.key.slice(5)}`;
        } catch (error) {
          if (!(error instanceof MemoryError) || error.status !== 422) throw error;
        }
      }
      return new URLSearchParams(Object.entries(safe).filter(([, value]) => value !== undefined) as [string, string][]).toString();
    }
    if (context.session_id || context.view === "effective" || context.scope === "global" || context.agent_key) {
      const safe = context.session_id ? { session_id: context.session_id, scope: context.scope, agent_key: context.agent_key, view: context.view } : { ...this.namespace(context).context, view: context.view };
      return new URLSearchParams(Object.entries(safe).filter(([, value]) => value !== undefined) as [string, string][]).toString();
    }
    const project = this.resolveProject(context);
    if (context.project_id) return new URLSearchParams({ project_id: project.id }).toString();
    if (context.session_id) return new URLSearchParams({ session_id: context.session_id }).toString();
    if (project.key.startsWith("repo:")) return new URLSearchParams({ repo_url: `git://${project.key.slice(5)}` }).toString();
    const [hostname, directory] = JSON.parse(project.key.slice(10));
    return new URLSearchParams({ hostname, directory }).toString();
  }

  private row(projectId: string, id: string): MemoryRow {
    const row = this.db.query("SELECT * FROM memories WHERE id = ? AND project_id = ?").get(id, projectId) as MemoryRow | null;
    return row ?? fail(404, "Memory not found in project");
  }

  read(context: MemoryContext, id: string) {
    const namespaces = this.namespaces(context);
    const row = this.db.query(`SELECT * FROM memories WHERE id=? AND project_id IN (${namespaces.map(() => "?").join(",")})`).get(id, ...namespaces.map(n => n.id)) as MemoryRow | null;
    if (!row) return fail(404, "Memory not found in applicable scope");
    if (row.status === "forgotten") return fail(410, "Memory forgotten; previous content must no longer be used");
    const sources = this.db.query(`SELECT s.*, CASE WHEN m.id IS NOT NULL AND m.session_id = s.session_id AND m.content IS NOT NULL THEN 1 ELSE 0 END AS available
      FROM memory_sources s LEFT JOIN messages m ON m.id = s.message_id WHERE memory_id = ? ORDER BY revision`).all(id).map((source: any) => {
        const { assessment_json, ...rest } = source;
        return { ...rest, assessment: assessment_json ? JSON.parse(assessment_json) : null };
      });
    const markdown = `---\nname: ${JSON.stringify(row.name)}\ndescription: ${JSON.stringify(row.description)}\nmetadata:\n  node_type: memory\n  type: ${row.type}\n  scope: ${row.scope}\n  agent_key: ${JSON.stringify(row.agent_key)}\n  originSessionId: ${JSON.stringify(row.origin_session_id)}\n---\n\n${row.body}`;
    return { ...metadata(row), body: row.body, markdown, sources };
  }

  create(context: MemoryContext, input: MemoryWrite) { return this.write(context, "create", undefined, input); }
  update(context: MemoryContext, id: string, input: MemoryWrite) { return this.write(context, "update", id, input); }
  forget(context: MemoryContext, id: string, input: MemoryWrite) { return this.write(context, "forget", id, input); }

  private write(context: MemoryContext, action: MemoryChange["action"], id: string | undefined, input: MemoryWrite) {
    return this.db.transaction(() => {
      if (context.view && context.view !== "scoped") return fail(400, "Writes require an exact scope");
      for (const key of ["scope", "agent_key"] as const) if (input?.[key] !== undefined && context[key] !== undefined && input[key] !== context[key]) return fail(400, `Conflicting ${key}`);
      const project = this.namespace({ ...context, scope: input?.scope ?? context.scope, agent_key: input?.agent_key ?? context.agent_key });
      if (!input || typeof input.operation_id !== "string" || !input.operation_id.trim() || input.operation_id.length > 200) return fail(400, "operation_id required (max 200 characters)");
      if (input.restore !== undefined && typeof input.restore !== "boolean") return fail(400, "restore must be boolean");
      if (action === "forget" && [input.name,input.description,input.type,input.body,input.restore].some(value => value !== undefined)) return fail(400, "Forget only accepts operation_id, source and expected_revision");
      const fingerprintInput = [action, id ?? null, ...["name", "description", "type", "body", "expected_revision", "restore"].map(k => (input as any)[k] ?? null), input.source?.session_id, input.source?.message_id, input.source?.job_id ?? null, input.source?.explicit ?? false];
      if (input.source?.assessment) fingerprintInput.push(input.source.assessment);
      const fingerprint = hash(JSON.stringify(fingerprintInput));
      const operation = this.db.query("SELECT * FROM memory_operations WHERE project_id = ? AND operation_id = ?").get(project.id, input.operation_id) as { fingerprint: string; memory_id: string } | null;
      if (operation) {
        if (operation.fingerprint !== fingerprint) return fail(409, "operation_id reused with different input");
        const row = this.row(project.id, operation.memory_id);
        return { ...metadata(row), success: true, replayed: true };
      }
      const source = input.source;
      if (!source || typeof source.session_id !== "string" || typeof source.message_id !== "string" || (source.explicit !== undefined && typeof source.explicit !== "boolean")) return fail(400, "Real source session and message required");
      this.identity({ session_id: source.session_id });
      if (this.namespace({ session_id: source.session_id, scope: project.scope, agent_key: project.agent_key }).id !== project.id) return fail(422, "Source belongs to another project");
      const message = this.db.query(`SELECT m.role, m.content, m.agent_key, a.sequence FROM messages m
        JOIN memory_message_arrivals a ON a.message_id=m.id AND a.session_id=m.session_id
        WHERE m.id = ? AND m.session_id = ?`).get(source.message_id, source.session_id) as { role: string; content: string; agent_key: string | null; sequence: number } | null;
      if (!message?.content?.trim() || !["user", "assistant"].includes(message.role)) return fail(422, "Source message unavailable or not conversation text");
      if (source.assessment) {
        for (const key of ["quote", "retention_reason", "scope_reason"] as const) if (typeof source.assessment[key] !== "string" || !source.assessment[key].trim() || source.assessment[key].length > 2000) return fail(400, "Invalid memory assessment");
        if (!message.content.includes(source.assessment.quote)) return fail(422, "Assessment quote must match source text");
      }
      if (project.agent_key && message.agent_key !== project.agent_key) return fail(422, "Source belongs to another named Agent or has no Agent identity");
      if (source.explicit && message.role !== "user") return fail(422, "Explicit actions require a user source");
      if (source.job_id) {
        if (typeof source.job_id !== "string") return fail(400, "Invalid source job_id");
        const job = this.db.query("SELECT target_session_id, input_json FROM agent_jobs WHERE id = ?").get(source.job_id) as { target_session_id: string | null; input_json: string | null } | null;
        let sessions: unknown = [];
        try { sessions = JSON.parse(job?.input_json ?? "{}").session_ids; } catch {}
        if (!job || (job.target_session_id !== source.session_id && !(Array.isArray(sessions) && sessions.includes(source.session_id)))) return fail(422, "Source job unavailable or belongs to another session");
      }
      if (action === "create" && this.db.query(`SELECT 1 FROM memory_sources s JOIN memories m ON m.id=s.memory_id
        WHERE m.project_id=? AND m.forgotten_at IS NOT NULL AND s.session_id=? AND s.message_id=?
        AND ? <= m.forgotten_sequence`).get(project.id, source.session_id, source.message_id, message.sequence)) return fail(409, "Previously forgotten source cannot create another memory; restore the original with a new explicit user request");
      const old = action === "create" ? null : this.row(project.id, id!);
      if (old && (!Number.isInteger(input.expected_revision) || input.expected_revision !== old.revision)) return fail(409, "Memory revision conflict");
      if (old?.forgotten_at && (old.forgotten_sequence === null || message.sequence <= old.forgotten_sequence)) return fail(410, "Source predates the memory's forgetting record");
      if (old?.status === "forgotten") {
        if (action !== "update" || input.restore !== true || !source.explicit || message.role !== "user") return fail(410, "Forgotten memory requires a new explicit user request to restore");
      }
      const now = new Date().toISOString();
      const row: MemoryRow = {
        id: old?.id ?? randomUUID(), project_id: project.id, scope: project.scope, agent_key: project.agent_key, context_json: JSON.stringify(project.context),
        name: input.name ?? old?.name ?? "", description: input.description ?? old?.description ?? "",
        type: input.type ?? old?.type ?? "", body: input.body ?? old?.body ?? "",
        origin_session_id: old?.origin_session_id ?? source.session_id, revision: (old?.revision ?? 0) + 1,
        status: action === "forget" ? "forgotten" : "active", created_at: old?.created_at ?? now, updated_at: now,
        forgotten_at: action === "forget" ? now : old?.forgotten_at ?? null,
        forgotten_sequence: action === "forget" ? (this.db.query("SELECT COALESCE(MAX(sequence),0) AS value FROM memory_message_arrivals").get() as { value: number }).value : old?.forgotten_sequence ?? null,
      };
      if (action !== "forget") {
        if (typeof row.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.name) || row.name.length > 100) return fail(400, "name must be short kebab-case");
        if (typeof row.description !== "string" || !row.description.trim() || /[\r\n]/.test(row.description) || row.description.length > 1000) return fail(400, "description must be a single-line reading hook (max 1000 characters)");
        if (!["user", "feedback", "project", "reference"].includes(row.type)) return fail(400, "Invalid memory type");
        if (typeof row.body !== "string" || !row.body.trim() || row.body.length > 100000 || /^\s*---(?:\r?\n|$)/.test(row.body)) return fail(400, "body must be Markdown without frontmatter (max 100000 characters)");
        if (["feedback", "project"].includes(row.type) && (!/Why:\s*\S/i.test(row.body) || !/How to apply:\s*\S/i.test(row.body))) return fail(400, "feedback/project require Why: and How to apply:");
      } else { row.body = ""; row.description = ""; }
      if (this.db.query("SELECT id FROM memories WHERE project_id = ? AND name = ? AND id != ?").get(project.id, row.name, row.id)) return fail(409, "Memory name already exists (including forgotten records)");
      this.db.query(`INSERT INTO memories (id,project_id,name,description,type,body,origin_session_id,revision,status,created_at,updated_at,forgotten_at,forgotten_sequence,scope,agent_key,context_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,type=excluded.type,body=excluded.body,revision=excluded.revision,status=excluded.status,updated_at=excluded.updated_at,forgotten_at=excluded.forgotten_at,forgotten_sequence=excluded.forgotten_sequence`)
        .run(row.id,row.project_id,row.name,row.description,row.type,row.body,row.origin_session_id,row.revision,row.status,row.created_at,row.updated_at,row.forgotten_at,row.forgotten_sequence,row.scope,row.agent_key,row.context_json);
      this.db.query("INSERT INTO memory_sources(memory_id,revision,session_id,message_id,job_id,explicit,action,created_at,assessment_json) VALUES (?,?,?,?,?,?,?,?,?)").run(row.id,row.revision,source.session_id,source.message_id,source.job_id ?? null,source.explicit ? 1 : 0,action,now,source.assessment ? JSON.stringify(source.assessment) : null);
      this.db.query("INSERT INTO memory_operations VALUES (?,?,?,?)").run(project.id,input.operation_id,fingerprint,row.id);
      return { ...metadata(row), success: true, replayed: false };
    })();
  }

  initializeExtraction(): void {
    this.db.transaction(() => {
      this.db.query(`INSERT INTO memory_extraction_progress(session_id,cursor)
        SELECT s.id, COALESCE(MAX(a.sequence),0) FROM sessions s LEFT JOIN memory_message_arrivals a ON a.session_id=s.id GROUP BY s.id
        ON CONFLICT(session_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`).run();
    })();
  }

  getExtractionCursor(sessionId: string): number {
    return (this.db.query("SELECT cursor FROM memory_extraction_progress WHERE session_id = ?").get(sessionId) as { cursor: number } | null)?.cursor ?? 0;
  }

  getExtractionMessages(sessionId: string, afterCursor: number) {
    return this.db.query(`SELECT a.sequence AS cursor, m.* FROM messages m
      JOIN memory_message_arrivals a ON a.message_id=m.id AND a.session_id=m.session_id
      WHERE m.session_id = ? AND a.sequence > ? ORDER BY a.sequence`).all(sessionId, afterCursor) as Array<{ cursor: number; id: string; session_id: string; role: string; content: string | null; created_at: string }>;
  }

  commitExtraction(input: { session_id: string; expected_cursor: number; cursor: number; changes: MemoryChange[] }) {
    return this.db.transaction(() => {
      if (this.getExtractionCursor(input.session_id) !== input.expected_cursor) return fail(409, "Extraction cursor conflict");
      if (!Number.isInteger(input.cursor) || input.cursor < input.expected_cursor || (input.cursor > 0 && !this.db.query("SELECT 1 FROM memory_message_arrivals WHERE session_id = ? AND sequence = ?").get(input.session_id, input.cursor))) return fail(400, "Invalid extraction cursor");
      const results = input.changes.map(change => {
        if (!["create", "update", "forget"].includes(change.action) || (change.action !== "create" && !change.id)) return fail(400, "Invalid memory change");
        if (change.input.source?.session_id !== input.session_id) return fail(422, "Extraction source must belong to the processed session");
        const source = this.db.query("SELECT sequence AS cursor FROM memory_message_arrivals WHERE message_id = ? AND session_id = ?").get(change.input.source.message_id, input.session_id) as { cursor: number } | null;
        if (!source || source.cursor > input.cursor) return fail(422, "Source exceeds extraction cursor");
        return this.write({ ...change.context, session_id: input.session_id }, change.action, change.id, change.input);
      });
      this.db.query("INSERT INTO memory_extraction_progress VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor").run(input.session_id,input.cursor);
      return { cursor: input.cursor, results };
    })();
  }
}
