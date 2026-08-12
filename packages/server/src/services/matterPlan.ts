export const MATTER_DISPOSITION_ACTIONS = ["archive", "merge", "skip_routine", "skip_empty", "skip_trivial"] as const;

export type MatterDispositionAction = (typeof MATTER_DISPOSITION_ACTIONS)[number];

export type MatterPlanItem = {
  project?: string;
  user_intent?: string;
  classification_reason?: {
    matter_type_reason?: string;
    title_reason?: string;
  };
  title: string;
  type: "Design" | "Feature" | "Fix";
  topic: string;
  session_ids: string[];
  existing_matter_id?: string;
};

export type SessionDisposition = {
  session_id: string;
  action: MatterDispositionAction;
  reason: string;
  existing_matter_id?: string;
};

export type MatterPlan = {
  planned_matter_count: number;
  matters: MatterPlanItem[];
  session_dispositions: SessionDisposition[];
};

export type MatterPlanMetrics = {
  candidate_session_count: number;
  planned_session_count: number;
  skipped_session_count: number;
  missing_disposition_count: number;
  coverage_rate: number;
  written_matter_count: number;
  merged_matter_count: number;
};

const MATTER_TYPES = new Set(["Design", "Feature", "Fix"]);
const DISPOSITION_ACTIONS = new Set<string>(MATTER_DISPOSITION_ACTIONS);

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((id) => String(id || "").trim()).filter(Boolean);
}

export function parseMatterPlan(value: unknown): MatterPlan {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const nested = source.matter_plan && typeof source.matter_plan === "object" && !Array.isArray(source.matter_plan)
    ? source.matter_plan as Record<string, unknown>
    : null;
  const rawMatters = Array.isArray(source.matters)
    ? source.matters
    : Array.isArray(nested?.matters)
      ? nested.matters
      : [];
  const rawDispositions = Array.isArray(source.session_dispositions)
    ? source.session_dispositions
    : Array.isArray(nested?.session_dispositions)
      ? nested.session_dispositions
      : [];

  const matters = rawMatters.flatMap((raw): MatterPlanItem[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const reason = item.classification_reason && typeof item.classification_reason === "object" && !Array.isArray(item.classification_reason)
      ? item.classification_reason as Record<string, unknown>
      : {};
    return [{
      project: item.project ? String(item.project).slice(0, 120) : undefined,
      user_intent: item.user_intent ? String(item.user_intent).slice(0, 500) : undefined,
      classification_reason: {
        matter_type_reason: reason.matter_type_reason ? String(reason.matter_type_reason).slice(0, 500) : undefined,
        title_reason: reason.title_reason ? String(reason.title_reason).slice(0, 500) : undefined,
      },
      title: String(item.title || item.topic || "未命名事项").slice(0, 160),
      type: String(item.type || "") as MatterPlanItem["type"],
      topic: String(item.topic || item.title || ""),
      session_ids: normalizeIdList(item.session_ids),
      existing_matter_id: item.existing_matter_id ? String(item.existing_matter_id).trim() : undefined,
    }];
  });

  const sessionDispositions = rawDispositions.flatMap((raw): SessionDisposition[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    return [{
      session_id: String(item.session_id || "").trim(),
      action: String(item.action || "") as MatterDispositionAction,
      reason: String(item.reason || "").trim(),
      existing_matter_id: item.existing_matter_id ? String(item.existing_matter_id).trim() : undefined,
    }];
  });

  return {
    planned_matter_count: matters.length,
    matters,
    session_dispositions: sessionDispositions,
  };
}

export function validateMatterPlan(
  plan: MatterPlan,
  candidateSessionIds: ReadonlySet<string>,
  existingMatterIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const dispositionCounts = new Map<string, number>();
  const matterMembership = new Map<string, MatterPlanItem[]>();

  for (const disposition of plan.session_dispositions) {
    dispositionCounts.set(disposition.session_id, (dispositionCounts.get(disposition.session_id) || 0) + 1);
    if (!candidateSessionIds.has(disposition.session_id)) errors.push(`disposition session_id is outside this batch: ${disposition.session_id || "<empty>"}`);
    if (!DISPOSITION_ACTIONS.has(disposition.action)) errors.push(`invalid disposition action for ${disposition.session_id}: ${disposition.action || "<empty>"}`);
    if (!disposition.reason) errors.push(`disposition reason is required for ${disposition.session_id || "<empty>"}`);
  }

  for (const sessionId of candidateSessionIds) {
    const count = dispositionCounts.get(sessionId) || 0;
    if (count === 0) errors.push(`missing disposition for candidate session: ${sessionId}`);
    if (count > 1) errors.push(`duplicate disposition for candidate session: ${sessionId}`);
  }

  for (const matter of plan.matters) {
    if (!MATTER_TYPES.has(matter.type)) errors.push(`invalid matter type for ${matter.title}: ${matter.type || "<empty>"}`);
    if (!matter.session_ids.length) errors.push(`matter has no session_ids: ${matter.title}`);
    if (matter.existing_matter_id && !existingMatterIds.has(matter.existing_matter_id)) {
      errors.push(`existing_matter_id does not exist: ${matter.existing_matter_id}`);
    }
    for (const sessionId of matter.session_ids) {
      if (!candidateSessionIds.has(sessionId)) errors.push(`matter session_id is outside this batch: ${sessionId}`);
      const memberships = matterMembership.get(sessionId) || [];
      memberships.push(matter);
      matterMembership.set(sessionId, memberships);
    }
  }

  for (const disposition of plan.session_dispositions) {
    if (!DISPOSITION_ACTIONS.has(disposition.action)) continue;
    const memberships = matterMembership.get(disposition.session_id) || [];
    if (disposition.action === "archive" || disposition.action === "merge") {
      if (memberships.length !== 1) errors.push(`${disposition.action} session must belong to exactly one matter: ${disposition.session_id}`);
      if (disposition.action === "merge") {
        if (!disposition.existing_matter_id) errors.push(`merge disposition requires existing_matter_id: ${disposition.session_id}`);
        if (disposition.existing_matter_id && !existingMatterIds.has(disposition.existing_matter_id)) {
          errors.push(`merge existing_matter_id does not exist: ${disposition.existing_matter_id}`);
        }
        if (memberships.length === 1 && memberships[0].existing_matter_id !== disposition.existing_matter_id) {
          errors.push(`merge existing_matter_id does not match containing matter: ${disposition.session_id}`);
        }
      }
    } else if (memberships.length) {
      errors.push(`skipped session must not belong to a matter: ${disposition.session_id}`);
    }
  }

  return [...new Set(errors)];
}

export function computeMatterPlanMetrics(plan: MatterPlan, candidateSessionIds: ReadonlySet<string>): MatterPlanMetrics {
  const dispositionIds = new Set(plan.session_dispositions.map((item) => item.session_id).filter((id) => candidateSessionIds.has(id)));
  const plannedSessionIds = new Set(plan.session_dispositions
    .filter((item) => item.action === "archive" || item.action === "merge")
    .map((item) => item.session_id));
  const candidateCount = candidateSessionIds.size;
  const missingCount = [...candidateSessionIds].filter((id) => !dispositionIds.has(id)).length;
  return {
    candidate_session_count: candidateCount,
    planned_session_count: plannedSessionIds.size,
    skipped_session_count: candidateCount - plannedSessionIds.size - missingCount,
    missing_disposition_count: missingCount,
    coverage_rate: candidateCount ? dispositionIds.size / candidateCount : 1,
    written_matter_count: plan.matters.filter((matter) => !matter.existing_matter_id).length,
    merged_matter_count: plan.matters.filter((matter) => !!matter.existing_matter_id).length,
  };
}
