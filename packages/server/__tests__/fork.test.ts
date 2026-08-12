import { describe, expect, it } from "bun:test";
import { getDatabase } from "../src/db";
import { SCHEMA_SQL } from "../src/db/schema";
import { enrichForkSessionMetadata, resolveForkParentSessionId } from "../src/services/fork";

describe("fork session service", () => {
  const db = getDatabase(":memory:");
  db.exec(SCHEMA_SQL);

  it("resolves parent session by source title", () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('parent-1', 'opencode', 'New session - 2026-06-15T12:17:56.684Z', '2026-06-15T12:17:57.640Z', 0, 0, 0, 0, 0)
    `);
    const parentId = resolveForkParentSessionId(
      db,
      "fork-1",
      "New session - 2026-06-15T12:17:56.684Z",
    );
    expect(parentId).toBe("parent-1");
  });

  it("enriches fork metadata with parent id", () => {
    db.exec(`
      INSERT INTO sessions (id, agent, title, started_at, request_count, total_input_tokens, total_output_tokens, total_tokens, total_cost_usd)
      VALUES ('parent-2', 'opencode', '合并本月用量', '2026-06-16T07:00:00.000Z', 0, 0, 0, 0, 0)
    `);
    const meta = enrichForkSessionMetadata(
      db,
      "fork-2",
      "合并本月用量 (fork #1)",
      { opencode_agent: "orchestrator" },
    );
    expect(meta?.is_fork).toBe(true);
    expect(meta?.fork_source_title).toBe("合并本月用量");
    expect(meta?.fork_parent_session_id).toBe("parent-2");
  });
});
