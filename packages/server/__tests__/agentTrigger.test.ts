import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { resetDatabase } from "../src/db";
import type { ServerConfig } from "../src/config";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function triggerTestConfig(dbPath: string): ServerConfig {
  return {
    port: 3456,
    apiKey: "trigger-test-key",
    dbPath,
    publicDir: "./public",
    publicDashboard: true,
    extraApiKeys: [],
    debug: false,
    logFile: "",
    cursorSyncEnabled: false,
    cursorApiKey: "trigger-test-key",
    llmBaseUrl: "https://api.deepseek.com",
    llmApiKey: "ac:test",
    llmModel: "deepseek-chat",
    agentThrottleMs: 25,
    agentAutoRunEnabled: true,
    updateEnabled: false,
    updateManifestUrl: "",
    updateScript: "/opt/runmark-updater/update.sh",
    updateStatePath: "/opt/runmark-updater/update-state.json",
  };
}

function llmResponse(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { headers: { "Content-Type": "application/json" } });
}

describe("chat_event trigger integration", () => {
  it("runs debounced session summaries and throttled matter archive through ingest", async () => {
    const dbPath = `/tmp/agent-tracker-trigger-${crypto.randomUUID()}.db`;
    resetDatabase(dbPath);
    const { app, db } = createApp(triggerTestConfig(dbPath));
    const originalFetch = globalThis.fetch;
    // session 级防抖：各会话独立计时；matter 仍用 agent 级节流聚合
    const shortDebounceTriggers = JSON.stringify([{ id: "chat_event", enabled: true, schedule: "session:debounce:25ms" }]);
    const shortThrottleTriggers = JSON.stringify([{ id: "chat_event", enabled: true, schedule: "throttle:25ms" }]);
    db.query("UPDATE agents SET triggers = $triggers WHERE id = 'agent-session-summary'").run({ $triggers: shortDebounceTriggers });
    db.query("UPDATE agents SET triggers = $triggers WHERE id = 'agent-matter-archive'").run({ $triggers: shortThrottleTriggers });

    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit)?.body || "{}"));
      const messages = payload.messages || [];
      const allContent = messages.map((m: any) => String(m.content || "")).join("\n");
      const lastContent = String(messages[messages.length - 1]?.content || "");

      if (lastContent.includes("Tool observations JSON")) {
        return llmResponse({ thought: "工具调用已完成。", final: { summary: "done" } });
      }

      if (allContent.includes("session.summary.write")) {
        const sessionId = allContent.match(/"current_session_id":"(trig-[ab])"/)?.[1] || "trig-a";
        return llmResponse({
          thought: "写入会话摘要。",
          tool_calls: [{
            name: "session.summary.write",
            arguments: {
              session_id: sessionId,
              title: `${sessionId} 自动摘要`,
              summary: `${sessionId} 已总结`,
              markdown: `## 摘要\nAgent 已根据 ${sessionId} 的新对话写入会话总结。`,
            },
          }],
        });
      }

      if (allContent.includes("phase: matter_plan")) {
        expect(allContent).toContain("trigger_session_changes");
        expect(allContent).toContain("trig-a");
        expect(allContent).toContain("trig-b");
        return llmResponse({
          thought: "本轮 chat_event 包含 trig-a 和 trig-b，需要规划为同一事项。",
          tool_calls: [{
            name: "matter.plan.submit",
            arguments: {
              matters: [{
                title: "本地 Trigger 集成测试",
                type: "Feature",
                topic: "chat_event 触发器本地验证",
                session_ids: ["trig-a", "trig-b"],
              }],
              session_dispositions: [
                { session_id: "trig-a", action: "archive", reason: "形成同一项工程交付。" },
                { session_id: "trig-b", action: "archive", reason: "形成同一项工程交付。" },
              ],
            },
          }],
        });
      }

      if (allContent.includes("phase: write_single_matter")) {
        expect(allContent).toContain("trig-a");
        expect(allContent).toContain("trig-b");
        return llmResponse({
          thought: "本轮 chat_event 包含 trig-a 和 trig-b，需要写入同一事项。",
          tool_calls: [{
            name: "matter.archive.write",
            arguments: {
              title: "本地 Trigger 集成测试",
              type: "Feature",
              topic: "chat_event 触发器本地验证",
              summary: "Agent 将本轮节流窗口内的 trig-a 与 trig-b 关联为同一事项。",
              result: "事项归档写入成功。",
              markdown: "## 摘要\nAgent 在本地 trigger 集成测试中综合关注 trig-a 与 trig-b，并写入同一事项。",
              dependency_refs: ["packages/server/src/services/agentScheduler.ts"],
              timeline_points: [
                "2026-07-08T10:00:00.000Z: trig-a 产生新对话",
                "2026-07-08T10:00:01.000Z: trig-b 产生新对话",
              ],
            },
          }],
        });
      }

      return llmResponse({ thought: "noop", final: { summary: "noop" } });
    }) as typeof fetch;

    try {
      const first = await app.request("/v1/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "trigger-test-key" },
        body: JSON.stringify({ events: [
          { type: "session.created", session_id: "trig-a", agent: "codex", title: "Trigger A" },
          { type: "message", session_id: "trig-a", message_id: "msg-a", role: "user", content: "A 产生新对话", created_at: "2026-07-08T10:00:00.000Z" },
        ] }),
      });
      expect(first.status).toBe(200);

      await wait(10);

      const second = await app.request("/v1/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "trigger-test-key" },
        body: JSON.stringify({ events: [
          { type: "session.created", session_id: "trig-b", agent: "codex", title: "Trigger B" },
          { type: "message", session_id: "trig-b", message_id: "msg-b", role: "user", content: "B 产生新对话", created_at: "2026-07-08T10:00:01.000Z" },
        ] }),
      });
      expect(second.status).toBe(200);

      await wait(180);

      const jobs = db.query("SELECT agent_id, status, trigger, run_reason FROM agent_jobs ORDER BY started_at").all() as any[];
      const summaries = db.query("SELECT session_id, title FROM session_summaries ORDER BY session_id").all() as any[];
      const matterSessions = db.query("SELECT session_id FROM matter_sessions ORDER BY session_id").all().map((row: any) => row.session_id);

      const summaryJobs = jobs.filter((job) => job.agent_id === "agent-session-summary" && job.status === "success");
      const matterJobs = jobs.filter((job) => job.agent_id === "agent-matter-archive" && job.status === "success");
      expect(summaryJobs).toHaveLength(2);
      expect(matterJobs).toHaveLength(1);
      expect(jobs.every((job) => job.trigger === "chat_event")).toBe(true);
      expect(summaryJobs.every((job) => job.run_reason === "debounced_chat_event")).toBe(true);
      expect(matterJobs[0].run_reason).toBe("throttled_chat_event");
      expect(summaries.map((row) => row.session_id)).toEqual(["trig-a", "trig-b"]);
      expect(matterSessions).toEqual(["trig-a", "trig-b"]);
    } finally {
      globalThis.fetch = originalFetch;
      resetDatabase(":memory:");
      try {
        Bun.file(dbPath).delete();
      } catch {}
    }
  });
});
