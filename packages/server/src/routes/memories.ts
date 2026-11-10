import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { MemoryError, MemoryService, type MemoryContext } from "../services/memory";
import type { ServerConfig } from "../config";
import { getAgentRuntime, MEMORY_RECALL_AGENT_ID } from "../services/agents";

export function createMemoriesRoute(db: Database, config?: ServerConfig) {
  const app = new Hono();
  const service = new MemoryService(db);
  app.onError((error, c) => {
    if (error instanceof MemoryError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
    throw error;
  });
  function context(query: Record<string, string>, body: Record<string, unknown> = {}): MemoryContext {
    const merged = { ...body, ...query };
    const result: MemoryContext = {};
    for (const key of ["session_id", "repo_url", "hostname", "directory", "project_id", "scope", "agent_key", "view"] as const) {
      if (merged[key] !== undefined && typeof merged[key] !== "string") throw new MemoryError(400, `Invalid ${key}`);
      if (merged[key] !== undefined) (result as Record<string, string>)[key] = merged[key] as string;
    }
    return result;
  }
  async function input(c: { req: { json(): Promise<any> } }) {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new MemoryError(400, "JSON object required");
    const allowed = new Set(["session_id", "repo_url", "hostname", "directory", "project_id", "scope", "agent_key", "operation_id", "source", "name", "description", "type", "body", "expected_revision", "restore"]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new MemoryError(400, `Unsupported field: ${key}`);
    return body;
  }
  app.get("/v1/memories/projects", c => c.json(service.projects()));
  app.get("/v1/memories/scopes", c => c.json(service.scopes()));
  app.get("/v1/memories/index", c => c.json(service.index(context(c.req.query()))));
  app.get("/v1/memories/index-state", c => c.json(service.indexState(context(c.req.query()))));
  app.post("/v1/memories/recall", async c => {
    if (!config) throw new MemoryError(400, "Memory recall is unavailable");
    const body = await c.req.json();
    if (!body || typeof body.query !== "string" || body.query.length > 16_000
      || (body.exclude_ids !== undefined && (!Array.isArray(body.exclude_ids) || body.exclude_ids.length > 200 || body.exclude_ids.some((id: unknown) => typeof id !== "string")))) throw new MemoryError(400, "Invalid recall query");
    const runtime = getAgentRuntime(db, config);
    if (!runtime.listAgents().find(agent => agent.id === MEMORY_RECALL_AGENT_ID)?.enabled) return c.json({ items: [] });
    const requested = { ...context(c.req.query(), body), view: "effective" as const };
    const project = service.list(requested, { limit: 1 }).namespaces.find(namespace => namespace.scope === "project");
    const canonical: MemoryContext = {
      ...(requested.session_id ? { session_id: requested.session_id } : project ? { repo_url: project.context.repo_url, project_id: project.context.project_id } : {}),
      agent_key: requested.agent_key, view: "effective",
    };
    const job = await runtime.runAgent(MEMORY_RECALL_AGENT_ID, {
      session_id: canonical.session_id, memory_context: canonical, search_query: body.query,
      exclude_memory_ids: body.exclude_ids, signal: c.req.raw.signal,
    });
    const output = job.status === "success" ? JSON.parse(job.output_json) : { items: [] };
    if (!c.req.raw.signal.aborted) service.recordRecalls(output.items);
    return c.json(output);
  });
  app.get("/v1/memories", c => c.json(service.list(context(c.req.query()), {
    query: c.req.query("query"), cursor: c.req.query("cursor"),
    type: c.req.query("type") as import("../services/memory").MemoryWrite["type"],
    sort: c.req.query("sort") as "updated" | "recall_asc" | "recall_desc" | undefined,
    status: c.req.query("status") as "active" | "forgotten" | undefined,
    limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
  })));
  app.get("/v1/memories/:id", c => {
    const detail = service.read(context(c.req.query()), c.req.param("id"));
    if (c.req.query("usage") !== "inspect") service.recordRecalls([detail]);
    return c.json(detail);
  });
  app.post("/v1/memories", async c => {
    const body = await input(c);
    const result = service.create(context(c.req.query(), body), body);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.patch("/v1/memories/:id", async c => {
    const body = await input(c);
    return c.json(service.update(context(c.req.query(), body), c.req.param("id"), body));
  });
  app.delete("/v1/memories/:id", async c => {
    const body = await input(c);
    return c.json(service.forget(context(c.req.query(), body), c.req.param("id"), body));
  });
  return app;
}
