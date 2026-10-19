/**
 * CodeBuddy / WorkBuddy 子 agent 路径约定（无其它本地模块依赖）
 *
 *   …/<parentUuid>.jsonl
 *   …/<parentUuid>/subagents/<childUuid>.jsonl
 */
import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** 路径是否落在 /subagents/ 段下 */
export function isSubagentTranscriptPath(transcriptPath: string): boolean {
  if (!transcriptPath) return false;
  const normalized = transcriptPath.replace(/\\/g, "/");
  return normalized.includes("/subagents/");
}

/**
 * …/<parentUuid>/subagents/<child>.jsonl → parentUuid（owner 目录名）
 */
export function parentSessionIdFromSubagentPath(transcriptPath: string): string | undefined {
  if (!isSubagentTranscriptPath(transcriptPath)) return undefined;
  const subagentsDir = dirname(transcriptPath);
  const ownerDir = dirname(subagentsDir);
  const parentName = basename(ownerDir);
  return parentName || undefined;
}

/** transcript 文件名（去 .jsonl）作为 session_id */
export function sessionIdFromTranscriptPath(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/i, "");
}

/**
 * 父路径为 …/<id>.jsonl 时，列出 …/<id>/subagents/*.jsonl。
 * 对已在 /subagents/ 下的子文件同样适用（嵌套 …/childId/subagents/）。
 * 非 .jsonl 或不存在目录 → []。
 */
export function listCodeBuddySubagentTranscripts(parentTranscriptPath: string): string[] {
  if (!parentTranscriptPath) return [];
  const lower = parentTranscriptPath.toLowerCase();
  if (!lower.endsWith(".jsonl")) return [];

  const parentId = sessionIdFromTranscriptPath(parentTranscriptPath);
  if (!parentId) return [];

  const subDir = join(dirname(parentTranscriptPath), parentId, "subagents");
  if (!existsSync(subDir)) return [];

  try {
    return readdirSync(subDir)
      .filter((name) => name.toLowerCase().endsWith(".jsonl"))
      .map((name) => join(subDir, name))
      .sort();
  } catch {
    return [];
  }
}

/** 含子会话及嵌套 …/child/subagents/*.jsonl */
export function listNestedCodeBuddySubagentTranscripts(
  parentTranscriptPath: string,
  visited: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const childPath of listCodeBuddySubagentTranscripts(parentTranscriptPath)) {
    if (visited.has(childPath)) continue;
    visited.add(childPath);
    out.push(childPath);
    out.push(...listNestedCodeBuddySubagentTranscripts(childPath, visited));
  }
  return out;
}

function transcriptContainsCallId(transcriptPath: string, callId: string): boolean {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    if (!raw.includes(callId)) return false;
    for (const line of raw.split("\n")) {
      if (!line.includes(callId)) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        record.callId === callId ||
        record.call_id === callId ||
        record.tool_use_id === callId ||
        record.id === callId
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 父 transcript 旁的 subagents JSONL 是否已包含该 call_id。
 * 命中则返回子 session_id（文件名）。
 */
export function findSubagentOwningCallId(
  parentTranscriptPath: string,
  callId: string,
): string | undefined {
  if (!parentTranscriptPath || !callId) return undefined;
  for (const childPath of listNestedCodeBuddySubagentTranscripts(parentTranscriptPath)) {
    if (transcriptContainsCallId(childPath, callId)) {
      return sessionIdFromTranscriptPath(childPath);
    }
  }
  return undefined;
}
