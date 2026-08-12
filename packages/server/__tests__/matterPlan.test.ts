import { describe, expect, it } from "bun:test";
import { computeMatterPlanMetrics, parseMatterPlan, validateMatterPlan } from "../src/services/matterPlan";

describe("Matter Plan", () => {
  it("requires a disposition for every candidate session", () => {
    const plan = parseMatterPlan({
      matters: [{
        title: "Runmark：Matter Archive 规划协议修复",
        type: "Fix",
        topic: "Matter Archive",
        session_ids: ["s-1"],
      }],
      session_dispositions: [{ session_id: "s-1", action: "archive", reason: "形成修复交付。" }],
    });

    const errors = validateMatterPlan(plan, new Set(["s-1", "s-2"]), new Set());
    expect(errors).toContain("missing disposition for candidate session: s-2");
  });

  it("accepts an all-skip plan when every candidate has a reason", () => {
    const plan = parseMatterPlan({
      matters: [],
      session_dispositions: [
        { session_id: "s-1", action: "skip_empty", reason: "空会话。" },
        { session_id: "s-2", action: "skip_trivial", reason: "没有独立交付。" },
      ],
    });

    expect(validateMatterPlan(plan, new Set(["s-1", "s-2"]), new Set())).toEqual([]);
  });

  it("reports actual links and skips instead of candidate count", () => {
    const sessionIds = Array.from({ length: 18 }, (_, index) => `s-${index + 1}`);
    const plan = parseMatterPlan({
      matters: [{ title: "唯一事项", type: "Fix", topic: "指标", session_ids: ["s-1"] }],
      session_dispositions: sessionIds.map((sessionId, index) => ({
        session_id: sessionId,
        action: index === 0 ? "archive" : "skip_trivial",
        reason: index === 0 ? "形成工程交付。" : "没有独立工程交付。",
      })),
    });

    const metrics = computeMatterPlanMetrics(plan, new Set(sessionIds));
    expect(metrics.candidate_session_count).toBe(18);
    expect(metrics.planned_session_count).toBe(1);
    expect(metrics.skipped_session_count).toBe(17);
    expect(metrics.missing_disposition_count).toBe(0);
    expect(metrics.coverage_rate).toBe(1);
  });

  it("rejects invalid merge targets and duplicate matter membership", () => {
    const plan = parseMatterPlan({
      matters: [
        { title: "事项 A", type: "Fix", topic: "A", session_ids: ["s-1"], existing_matter_id: "missing-matter" },
        { title: "事项 B", type: "Feature", topic: "B", session_ids: ["s-1"] },
      ],
      session_dispositions: [{
        session_id: "s-1",
        action: "merge",
        reason: "尝试合并。",
        existing_matter_id: "missing-matter",
      }],
    });

    const errors = validateMatterPlan(plan, new Set(["s-1"]), new Set());
    expect(errors).toContain("existing_matter_id does not exist: missing-matter");
    expect(errors).toContain("merge existing_matter_id does not exist: missing-matter");
    expect(errors).toContain("merge session must belong to exactly one matter: s-1");
  });
});
