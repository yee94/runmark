/**
 * CodeBuddy / WorkBuddy 子 agent：Stop 时扫描 subagents/*.jsonl 并产出 ingest 事件
 */
import type { IngestEvent, IngestSessionEvent } from "@agent-tracker/shared";
import type { ClaudeCompatAgent } from "./transform";
import { parseClaudeTranscriptEvents } from "./transcript";
import {
  listCodeBuddySubagentTranscripts,
  sessionIdFromTranscriptPath,
  isSubagentTranscriptPath,
  findSubagentOwningCallId,
} from "./subagent-paths";

export {
  isSubagentTranscriptPath,
  listCodeBuddySubagentTranscripts,
  parentSessionIdFromSubagentPath,
  sessionIdFromTranscriptPath,
  findSubagentOwningCallId,
} from "./subagent-paths";

export function subagentSessionCreatedEvent(opts: {
  sessionId: string;
  parentSessionId: string;
  agent: ClaudeCompatAgent;
}): IngestSessionEvent {
  return {
    type: "session.created",
    session_id: opts.sessionId,
    agent: opts.agent,
    parent_session_id: opts.parentSessionId,
    metadata: {
      is_subagent: true,
      runtime: opts.agent,
    },
  };
}

export interface CollectSubagentEventsOptions {
  parentSessionId: string;
  parentTranscriptPath: string;
  agent: ClaudeCompatAgent;
  flushPendingTools?: boolean;
  stateDir?: string;
  /** 防环；同一 Stop 内跨递归共享 */
  visited?: Set<string>;
}

/**
 * 扫描父会话旁的 subagents/*.jsonl：session.created + 复用 parseClaudeTranscriptEvents。
 * 仅 codebuddy / workbuddy。顶层是否跳过子路径由调用方决定（见 dispatch）。
 */
export function collectSubagentEvents(opts: CollectSubagentEventsOptions): IngestEvent[] {
  if (opts.agent !== "codebuddy" && opts.agent !== "workbuddy") return [];
  if (!opts.parentTranscriptPath) return [];

  const visited = opts.visited ?? new Set<string>();
  const events: IngestEvent[] = [];

  for (const childPath of listCodeBuddySubagentTranscripts(opts.parentTranscriptPath)) {
    if (visited.has(childPath)) continue;
    visited.add(childPath);

    const childId = sessionIdFromTranscriptPath(childPath);
    events.push(
      subagentSessionCreatedEvent({
        sessionId: childId,
        parentSessionId: opts.parentSessionId,
        agent: opts.agent,
      }),
    );
    events.push(
      ...parseClaudeTranscriptEvents({
        session_id: childId,
        agent: opts.agent,
        transcript_path: childPath,
        stateDir: opts.stateDir,
        flushPendingTools: opts.flushPendingTools,
      }),
    );
    // 嵌套子 agent：…/childUuid/subagents/*.jsonl
    events.push(
      ...collectSubagentEvents({
        parentSessionId: childId,
        parentTranscriptPath: childPath,
        agent: opts.agent,
        flushPendingTools: opts.flushPendingTools,
        stateDir: opts.stateDir,
        visited,
      }),
    );
  }

  return events;
}

/**
 * CodeBuddy/WorkBuddy PostToolUse：子路径改挂子 session；
 * 父路径下 call_id 已出现在 subagents JSONL 则 skip（避免子工具写入父会话）。
 * 父自己的工具（含 Agent spawn）原样上报。
 */
export function resolvePostToolUseTarget(opts: {
  agent: ClaudeCompatAgent;
  sessionId: string;
  transcriptPath?: string | null;
  callId?: string | null;
}): { sessionId: string; skip: boolean } {
  if (opts.agent !== "codebuddy" && opts.agent !== "workbuddy") {
    return { sessionId: opts.sessionId, skip: false };
  }
  const path = opts.transcriptPath ?? "";
  if (isSubagentTranscriptPath(path)) {
    return {
      sessionId: sessionIdFromTranscriptPath(path) || opts.sessionId,
      skip: false,
    };
  }
  const callId = opts.callId ?? "";
  if (callId && findSubagentOwningCallId(path, callId)) {
    return { sessionId: opts.sessionId, skip: true };
  }
  return { sessionId: opts.sessionId, skip: false };
}
