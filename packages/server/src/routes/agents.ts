import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { FileLogger } from "@agent-tracker/shared";
import type { ServerConfig } from "../config";
import { AgentRunBusyError, MATTER_ARCHIVE_AGENT_ID, MATTER_SEARCH_AGENT_ID, MEMORY_EXTRACTION_AGENT_ID, SESSION_SEARCH_AGENT_ID, SESSION_SUMMARY_AGENT_ID, getAgentRuntime } from "../services/agents";
import { MemoryService } from "../services/memory";
import { buildLlmAuthHeaders } from "../services/llmHeaders";

async function testOpenAiCompatible(baseUrl: string, apiKey: string, model: string): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: buildLlmAuthHeaders(apiKey, baseUrl),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a connectivity test endpoint." },
          { role: "user", content: "Reply with OK." },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data?.error?.message || data?.message || `HTTP ${res.status}` };
    const content = data?.choices?.[0]?.message?.content;
    return { ok: !!content, message: content ? "connected" : "response missing content" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function createAgentsRoute(db: Database, config: ServerConfig, logger?: FileLogger) {
  const app = new Hono();
  const runtime = getAgentRuntime(db, config, logger);

  const isSyncRun = (c: any) => {
    const value = String(c.req.query("sync") ?? "").toLowerCase();
    return value === "1" || value === "true";
  };

  const runAgentForRequest = async (c: any, agentId: string, input: any) => {
    try {
      if (isSyncRun(c)) {
        const run = await runtime.runAgent(agentId, input);
        return c.json(run, run?.status === "failed" ? 500 : 200);
      }
      const run = runtime.startAgent(agentId, input);
      return c.json(run, 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, err instanceof AgentRunBusyError ? 409 : 400);
    }
  };

  app.get("/v1/agents", (c) => {
    return c.json(runtime.listAgents());
  });

  app.get("/v1/agents/:id/config", (c) => {
    const agent = runtime.listAgents().find((a) => a.id === c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  app.put("/v1/agents/:id/config", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      enabled?: boolean;
      model_id?: string;
      tools?: string[];
      triggers?: unknown[];
      system_prompt?: string;
      task_brief?: string;
    }>();
    const existing = runtime.listAgents().find((a) => a.id === id);
    if (!existing) return c.json({ error: "Agent not found" }, 404);
    db.transaction(() => {
      if (id === MEMORY_EXTRACTION_AGENT_ID && !existing.enabled && body.enabled === true) {
        new MemoryService(db).initializeExtraction();
      }
      db.query(`
        UPDATE agents SET
          enabled = COALESCE($enabled, enabled),
          model_id = COALESCE($model_id, model_id),
          tools = COALESCE($tools, tools),
          triggers = COALESCE($triggers, triggers),
          system_prompt = COALESCE($system_prompt, system_prompt),
          task_brief = COALESCE($task_brief, task_brief),
          updated_at = $updated_at
        WHERE id = $id
      `).run({
        $id: id,
        $enabled: typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : null,
        $model_id: body.model_id ?? null,
        $tools: body.tools ? JSON.stringify(body.tools) : null,
        $triggers: body.triggers ? JSON.stringify(body.triggers) : null,
        $system_prompt: body.system_prompt ?? null,
        $task_brief: body.task_brief ?? null,
        $updated_at: new Date().toISOString(),
      });
    })();
    if (body.system_prompt || body.task_brief) {
      db.query(`
        INSERT INTO agent_prompts (agent_id, system_prompt, task_brief, updated_at)
        VALUES ($agent_id, $system_prompt, $task_brief, $updated_at)
        ON CONFLICT(agent_id) DO UPDATE SET
          system_prompt = excluded.system_prompt,
          task_brief = excluded.task_brief,
          updated_at = excluded.updated_at
      `).run({
        $agent_id: id,
        $system_prompt: body.system_prompt ?? existing.system_prompt ?? "",
        $task_brief: body.task_brief ?? existing.task_brief ?? "",
        $updated_at: new Date().toISOString(),
      });
    }
    const agent = runtime.listAgents().find((a) => a.id === id);
    return c.json(agent);
  });

  app.post("/v1/agents/:id/runs", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      return await runAgentForRequest(c, id, body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/v1/agent-runs", (c) => {
    const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 30)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
    const total = runtime.countJobs();
    const items = runtime.listJobs(limit, offset);
    return c.json({
      items,
      total,
      limit,
      offset,
      has_more: offset + items.length < total,
    });
  });

  app.get("/v1/agent-runs/:id", (c) => {
    const run = runtime.getJob(c.req.param("id"));
    if (!run) return c.json({ error: "Agent run not found" }, 404);
    return c.json(run);
  });

  app.post("/v1/agent-runs/:id/retry", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const retry = runtime.buildRetryInput(id, body);
      if (isSyncRun(c)) {
        const run = await runtime.runAgent(retry.agentId, retry.input);
        runtime.deleteJob(id);
        return c.json(run, run?.status === "failed" ? 500 : 200);
      }
      const run = runtime.startAgent(retry.agentId, retry.input);
      runtime.deleteJob(id);
      return c.json(run, 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof AgentRunBusyError || message.includes("Only failed")
        ? 409
        : message.includes("not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.post("/v1/sessions/:id/resummarize", async (c) => {
    const id = c.req.param("id");
    const session = db.query("SELECT id FROM sessions WHERE id = $id").get({ $id: id });
    if (!session) return c.json({ error: "Session not found" }, 404);
    const activeJob = db.query(`
      SELECT id
      FROM agent_jobs
      WHERE agent_id = $agent_id
        AND target_session_id = $session_id
        AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get({
      $agent_id: SESSION_SUMMARY_AGENT_ID,
      $session_id: id,
    }) as { id: string } | null;
    if (activeJob) {
      const run = runtime.getJob(activeJob.id);
      return c.json({ ...run, deduplicated: true }, 202);
    }
    db.query("UPDATE sessions SET AISummary = NULL WHERE id = $id").run({ $id: id });
    return await runAgentForRequest(c, SESSION_SUMMARY_AGENT_ID, {
      session_id: id,
      run_reason: "session_resummarize",
      trigger: "session_action",
      force: true,
    });
  });

  app.get("/v1/matters", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    return c.json(runtime.listMatters(c.req.query("tab"), { limit, offset, q: c.req.query("q") }));
  });

  app.post("/v1/matters/agent-search", async (c) => {
    const body: { query?: unknown } = await c.req.json().catch(() => ({}));
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return c.json({ error: "query is required" }, 400);
    if (query.length > 500) return c.json({ error: "query must be at most 500 characters" }, 400);
    return await runAgentForRequest(c, MATTER_SEARCH_AGENT_ID, {
      search_query: query,
      run_reason: "matter_agent_search",
      trigger: "matter_search",
      force: true,
    });
  });

  app.post("/v1/sessions/agent-search", async (c) => {
    const body: { query?: unknown } = await c.req.json().catch(() => ({}));
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return c.json({ error: "query is required" }, 400);
    if (query.length > 500) return c.json({ error: "query must be at most 500 characters" }, 400);
    return await runAgentForRequest(c, SESSION_SEARCH_AGENT_ID, {
      search_query: query,
      run_reason: "session_agent_search",
      trigger: "session_search",
      force: true,
    });
  });

  app.get("/v1/matters/:id", (c) => {
    const matter = runtime.getMatter(c.req.param("id"));
    if (!matter) return c.json({ error: "Matter not found" }, 404);
    return c.json(matter);
  });

  app.post("/v1/matters/resummarize", async (c) => {
    const body: { session_ids?: unknown; append_matters?: boolean } = await c.req.json().catch(() => ({}));
    const selectedSessionIds = Array.isArray(body.session_ids)
      ? body.session_ids.map((v: unknown) => String(v).trim()).filter(Boolean)
      : [];
    if (!selectedSessionIds.length) return c.json({ error: "session_ids is required" }, 400);
    const candidates = runtime.listMatters()
      .slice(0, 12)
      .map((m) => m.id);
    return await runAgentForRequest(c, MATTER_ARCHIVE_AGENT_ID, {
      session_ids: selectedSessionIds,
      candidate_matter_ids: candidates,
      run_reason: "matter_resummarize",
      trigger: "matter_action",
      append_matters: !!body.append_matters,
      force: true,
    });
  });

  app.post("/v1/matters/:id/resummarize", async (c) => {
    const id = c.req.param("id");
    const matter = runtime.getMatter(id);
    if (!matter) return c.json({ error: "Matter not found" }, 404);
    const body: { session_ids?: unknown; append_matters?: boolean } = await c.req.json().catch(() => ({}));
    const selectedSessionIds = Array.isArray(body.session_ids)
      ? body.session_ids.map((v: unknown) => String(v).trim()).filter(Boolean)
      : matter.relatedSessionIds;
    if (!selectedSessionIds.length) return c.json({ error: "session_ids is required" }, 400);
    const candidates = runtime.listMatters()
      .filter((m) => m.id !== id)
      .slice(0, 12)
      .map((m) => m.id);
    return await runAgentForRequest(c, MATTER_ARCHIVE_AGENT_ID, {
      matter_id: id,
      session_ids: selectedSessionIds,
      candidate_matter_ids: candidates,
      run_reason: "matter_resummarize",
      trigger: "matter_action",
      append_matters: !!body.append_matters,
      force: true,
    });
  });

  app.post("/v1/matters/:id/archive", (c) => {
    const matter = runtime.archiveMatter(c.req.param("id"));
    if (!matter) return c.json({ error: "Matter not found" }, 404);
    return c.json(matter);
  });

  app.get("/v1/system-config", (c) => {
    return c.json(runtime.listProvidersAndModels());
  });

  app.post("/v1/system-config/providers/test", async (c) => {
    const body = await c.req.json<{ base_url?: string; api_key?: string; model?: string }>();
    if (!body.base_url || !body.api_key || !body.model) {
      return c.json({ ok: false, message: "base_url, api_key and model are required" }, 400);
    }
    const result = await testOpenAiCompatible(body.base_url, body.api_key, body.model);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.put("/v1/system-config/providers/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string;
      type?: string;
      base_url?: string;
      api_key?: string;
    }>();
    const existing = db.query("SELECT * FROM agent_providers WHERE id = $id").get({ $id: id }) as {
      id: string;
      api_key?: string | null;
    } | null;
    if (!existing) return c.json({ error: "Provider 不存在" }, 404);
    if (!body.name || !body.base_url) {
      return c.json({ error: "name 和 base_url 为必填项" }, 400);
    }
    const now = new Date().toISOString();
    const type = body.type ?? "openai";
    if (body.api_key) {
      db.query(`
        UPDATE agent_providers
        SET name = $name, type = $type, base_url = $base_url, api_key = $api_key, updated_at = $updated_at
        WHERE id = $id
      `).run({
        $id: id,
        $name: body.name,
        $type: type,
        $base_url: body.base_url,
        $api_key: body.api_key,
        $updated_at: now,
      });
    } else {
      db.query(`
        UPDATE agent_providers
        SET name = $name, type = $type, base_url = $base_url, updated_at = $updated_at
        WHERE id = $id
      `).run({
        $id: id,
        $name: body.name,
        $type: type,
        $base_url: body.base_url,
        $updated_at: now,
      });
    }
    return c.json({ ok: true, config: runtime.listProvidersAndModels() });
  });

  app.post("/v1/system-config/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ base_url?: string; api_key?: string; model?: string }>().catch(() => ({} as { base_url?: string; api_key?: string; model?: string }));
    const existing = db.query("SELECT * FROM agent_providers WHERE id = $id").get({ $id: id }) as {
      id: string;
      base_url?: string | null;
      api_key?: string | null;
    } | null;
    if (!existing) return c.json({ ok: false, message: "Provider 不存在" }, 404);
    const baseUrl = body.base_url || existing.base_url;
    const apiKey = body.api_key || existing.api_key || (existing.id === "provider-deepseek-default" ? (config.llmApiKey ?? "") : "");
    let model = body.model;
    if (!model) {
      const row = db.query("SELECT model FROM agent_models WHERE provider_id = $provider_id ORDER BY label LIMIT 1")
        .get({ $provider_id: id }) as { model?: string } | null;
      model = row?.model;
    }
    if (!baseUrl || !apiKey || !model) {
      return c.json({ ok: false, message: "base_url、api_key 和 model 为必填项" }, 400);
    }
    const result = await testOpenAiCompatible(baseUrl, apiKey, model);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/v1/system-config/providers", async (c) => {
    const body = await c.req.json<{
      name?: string;
      type?: string;
      base_url?: string;
      api_key?: string;
      model?: string;
      purpose?: string;
    }>();
    if (!body.name || !body.base_url || !body.api_key || !body.model) {
      return c.json({ error: "name, base_url, api_key and model are required" }, 400);
    }
    const now = new Date().toISOString();
    const providerId = `provider-${crypto.randomUUID()}`;
    const modelId = `model-${crypto.randomUUID()}`;
    db.query(`
      INSERT INTO agent_providers (id, name, type, base_url, api_key, status, updated_at)
      VALUES ($id, $name, $type, $base_url, $api_key, 'available', $updated_at)
    `).run({
      $id: providerId,
      $name: body.name,
      $type: body.type ?? "openai",
      $base_url: body.base_url,
      $api_key: body.api_key,
      $updated_at: now,
    });
    db.query(`
      INSERT INTO agent_models (id, provider_id, label, model, purpose, enabled, updated_at)
      VALUES ($id, $provider_id, $label, $model, $purpose, 1, $updated_at)
    `).run({
      $id: modelId,
      $provider_id: providerId,
      $label: body.model,
      $model: body.model,
      $purpose: body.purpose ?? "自定义模型",
      $updated_at: now,
    });
    return c.json({ ok: true, providerId, modelId, config: runtime.listProvidersAndModels() }, 201);
  });

  app.post("/v1/system-config/models", async (c) => {
    const body = await c.req.json<{
      provider_id?: string;
      model?: string;
      label?: string;
      purpose?: string;
    }>();
    if (!body.provider_id || !body.model) {
      return c.json({ error: "provider_id 和 model 为必填项" }, 400);
    }
    const provider = db.query("SELECT id FROM agent_providers WHERE id = $id").get({ $id: body.provider_id });
    if (!provider) return c.json({ error: "Provider 不存在" }, 404);
    const now = new Date().toISOString();
    const modelId = `model-${crypto.randomUUID()}`;
    db.query(`
      INSERT INTO agent_models (id, provider_id, label, model, purpose, enabled, updated_at)
      VALUES ($id, $provider_id, $label, $model, $purpose, 1, $updated_at)
    `).run({
      $id: modelId,
      $provider_id: body.provider_id,
      $label: body.label ?? body.model,
      $model: body.model,
      $purpose: body.purpose ?? "自定义模型",
      $updated_at: now,
    });
    return c.json({ ok: true, modelId, config: runtime.listProvidersAndModels() }, 201);
  });

  app.delete("/v1/system-config/models/:id", (c) => {
    const id = c.req.param("id");
    const model = db.query("SELECT id FROM agent_models WHERE id = $id").get({ $id: id });
    if (!model) return c.json({ error: "模型不存在" }, 404);
    const usage = db.query("SELECT COUNT(*) as count FROM agents WHERE model_id = $id").get({ $id: id }) as { count: number };
    if (usage.count > 0) {
      return c.json({ error: "模型正在被智能体使用，不能删除" }, 409);
    }
    db.query("DELETE FROM agent_models WHERE id = $id").run({ $id: id });
    return c.json({ ok: true, config: runtime.listProvidersAndModels() });
  });

  return app;
}
