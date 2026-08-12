import type { IngestEvent, FileLogger } from "@agent-tracker/shared";
import type { ServerConfig } from "../config";
import { AgentRunBusyError, type AgentRuntime } from "./agents";
import {
  parseSchedule,
  type ScheduleMode,
  type ScheduleScope,
} from "./agentSchedule";

export { formatSchedule, parseSchedule, parseThrottleMs } from "./agentSchedule";

type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type ChatEventTrigger = {
  id?: string;
  enabled?: boolean;
  schedule?: string;
};
type SessionScheduleState = {
  timer: TimerHandle | null;
  /** waiting=计时中；ready=等待期结束、排队执行；idle=无待处理 */
  status: "idle" | "waiting" | "ready";
  pendingSince: number | null;
  lastStartedAt: number | null;
};
type AgentScheduleState = {
  timer: TimerHandle | null;
  running: boolean;
  pendingSessionIds: Set<string>;
  pendingSince: number | null;
  lastStartedAt: number | null;
  waitMs: number;
  mode: ScheduleMode;
  scope: ScheduleScope;
  sessions: Map<string, SessionScheduleState>;
};

const DEFAULT_THROTTLE_MS = 10 * 60 * 1000;

export class AgentThrottleScheduler {
  private agentStates = new Map<string, AgentScheduleState>();

  constructor(
    private runtime: AgentRuntime,
    private config: ServerConfig,
    private logger?: FileLogger,
  ) {}

  scheduleAfterIngest(events: IngestEvent[]): void {
    if (!this.config.agentAutoRunEnabled) return;
    // 仅有实质对话内容时触发摘要：跳过 session.created / session.idle / 空壳 tool 幽灵
    const sessionIds = [...new Set(
      events
        .filter((event) =>
          event.type === "message"
          || event.type === "turn.completed"
          || event.type === "turn.error"
          || event.type === "session.updated",
        )
        .map((event) => event.session_id)
        .filter(Boolean),
    )];
    if (!sessionIds.length) return;
    for (const agent of this.runtime.listAgents()) {
      if (!agent.enabled) continue;
      const trigger = this.chatEventTrigger(agent.triggers);
      if (!trigger) continue;
      this.scheduleAgent(agent.id, sessionIds, trigger);
    }
  }

  private chatEventTrigger(triggers: unknown): ChatEventTrigger | null {
    if (!Array.isArray(triggers)) return null;
    const trigger = triggers.find((item: any) => item?.id === "chat_event") as ChatEventTrigger | undefined;
    if (!trigger || trigger.enabled === false) return null;
    return trigger;
  }

  private getOrCreateState(agentId: string, mode: ScheduleMode, scope: ScheduleScope, waitMs: number): AgentScheduleState {
    const state = this.agentStates.get(agentId) ?? {
      timer: null,
      running: false,
      pendingSessionIds: new Set<string>(),
      pendingSince: null,
      lastStartedAt: null,
      waitMs,
      mode,
      scope,
      sessions: new Map(),
    };
    state.waitMs = waitMs;
    state.mode = mode;
    state.scope = scope;
    this.agentStates.set(agentId, state);
    return state;
  }

  private scheduleAgent(agentId: string, sessionIds: string[], trigger: ChatEventTrigger): void {
    const { mode, waitMs, scope } = parseSchedule(
      trigger.schedule,
      this.config.agentThrottleMs ?? DEFAULT_THROTTLE_MS,
    );
    const state = this.getOrCreateState(agentId, mode, scope, waitMs);
    if (scope === "session") {
      for (const sessionId of sessionIds) {
        this.scheduleSession(agentId, state, sessionId);
      }
      return;
    }
    this.scheduleAgentScoped(agentId, state, sessionIds);
  }

  /** agent 级：所有 session 共用一个 debounce/throttle 窗口（旧行为） */
  private scheduleAgentScoped(agentId: string, state: AgentScheduleState, sessionIds: string[]): void {
    const now = Date.now();
    if (!state.pendingSessionIds.size || state.mode === "debounce") state.pendingSince = now;
    for (const sessionId of sessionIds) {
      state.pendingSessionIds.add(sessionId);
    }
    if (state.mode === "debounce" && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.armAgent(agentId, state);
  }

  /** session 级：每个 session 独立计时，互不重置 */
  private scheduleSession(agentId: string, state: AgentScheduleState, sessionId: string): void {
    const now = Date.now();
    const ss = state.sessions.get(sessionId) ?? {
      timer: null,
      status: "idle" as const,
      pendingSince: null,
      lastStartedAt: null,
    };

    if (ss.status === "ready") {
      // 已过等待期、排队执行中：debounce 有新事件则重新计时；throttle 保持 ready
      if (state.mode === "debounce") {
        if (ss.timer) {
          clearTimeout(ss.timer);
          ss.timer = null;
        }
        ss.status = "waiting";
        ss.pendingSince = now;
        state.sessions.set(sessionId, ss);
        this.armSession(agentId, state, sessionId);
      }
      return;
    }

    if (ss.status === "waiting") {
      if (state.mode === "debounce") {
        ss.pendingSince = now;
        if (ss.timer) {
          clearTimeout(ss.timer);
          ss.timer = null;
        }
        state.sessions.set(sessionId, ss);
        this.armSession(agentId, state, sessionId);
      }
      // throttle：窗口已建立，忽略后续事件，不重置
      return;
    }

    // idle → waiting
    ss.status = "waiting";
    ss.pendingSince = now;
    state.sessions.set(sessionId, ss);
    this.armSession(agentId, state, sessionId);
  }

  private armAgent(agentId: string, state: AgentScheduleState): void {
    if (state.timer || state.running || !state.pendingSessionIds.size) return;
    const now = Date.now();
    const pendingReadyAt = (state.pendingSince ?? now) + state.waitMs;
    const rateReadyAt = state.mode === "throttle" && state.lastStartedAt != null
      ? state.lastStartedAt + state.waitMs
      : 0;
    const delayMs = Math.max(0, Math.max(pendingReadyAt, rateReadyAt) - now);
    const timer = setTimeout(() => {
      state.timer = null;
      void this.runAgentBatch(agentId, state);
    }, delayMs) as TimerHandle;
    timer.unref?.();
    state.timer = timer;
  }

  private armSession(agentId: string, state: AgentScheduleState, sessionId: string): void {
    const ss = state.sessions.get(sessionId);
    if (!ss || ss.timer || ss.status !== "waiting") return;
    const now = Date.now();
    const pendingReadyAt = (ss.pendingSince ?? now) + state.waitMs;
    const rateReadyAt = state.mode === "throttle" && ss.lastStartedAt != null
      ? ss.lastStartedAt + state.waitMs
      : 0;
    const delayMs = Math.max(0, Math.max(pendingReadyAt, rateReadyAt) - now);
    const timer = setTimeout(() => {
      ss.timer = null;
      if (ss.status !== "waiting") return;
      ss.status = "ready";
      void this.runReadySessions(agentId, state);
    }, delayMs) as TimerHandle;
    timer.unref?.();
    ss.timer = timer;
  }

  private async runAgentBatch(agentId: string, state: AgentScheduleState): Promise<void> {
    if (state.running || !state.pendingSessionIds.size) return;
    const changedSessionIds = [...state.pendingSessionIds];
    const batchPendingSince = state.pendingSince ?? Date.now();
    state.pendingSessionIds.clear();
    state.pendingSince = null;
    state.running = true;
    state.lastStartedAt = Date.now();
    try {
      await this.runtime.runAgent(agentId, {
        trigger: "chat_event",
        run_reason: `${state.mode}d_chat_event`,
        session_ids: changedSessionIds,
      });
    } catch (err) {
      if (err instanceof AgentRunBusyError) {
        state.pendingSessionIds = new Set([...changedSessionIds, ...state.pendingSessionIds]);
        state.pendingSince = state.pendingSince == null
          ? batchPendingSince
          : Math.min(batchPendingSince, state.pendingSince);
        this.logger?.debug(`agent ${state.mode} waiting for active run: ${agentId}`);
      } else {
        this.logger?.error(`agent ${state.mode} failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      state.running = false;
      this.armAgent(agentId, state);
    }
  }

  /** 将会话级 ready 队列合并执行；agent 仍 single-flight */
  private async runReadySessions(agentId: string, state: AgentScheduleState): Promise<void> {
    if (state.running) return;
    const readyIds = [...state.sessions.entries()]
      .filter(([, ss]) => ss.status === "ready")
      .map(([id]) => id);
    if (!readyIds.length) return;

    const now = Date.now();
    for (const sessionId of readyIds) {
      const ss = state.sessions.get(sessionId);
      if (!ss) continue;
      ss.status = "idle";
      ss.pendingSince = null;
      ss.lastStartedAt = now;
    }
    state.running = true;
    try {
      await this.runtime.runAgent(agentId, {
        trigger: "chat_event",
        run_reason: `${state.mode}d_chat_event`,
        session_ids: readyIds,
      });
    } catch (err) {
      if (err instanceof AgentRunBusyError) {
        for (const sessionId of readyIds) {
          const ss = state.sessions.get(sessionId) ?? {
            timer: null,
            status: "idle" as const,
            pendingSince: null,
            lastStartedAt: null,
          };
          // 若 busy 期间又有 debounce 新事件进入 waiting，不要覆盖
          if (ss.status === "idle") {
            ss.status = "ready";
            ss.pendingSince = null;
            state.sessions.set(sessionId, ss);
          }
        }
        this.logger?.debug(`agent ${state.mode} waiting for active run: ${agentId}`);
      } else {
        this.logger?.error(`agent ${state.mode} failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      state.running = false;
      // 先拉 ready，再给仍在 waiting 的会话补 arm（正常有 timer，busy 重入时可能需要）
      void this.runReadySessions(agentId, state);
      for (const [sessionId, ss] of state.sessions) {
        if (ss.status === "waiting" && !ss.timer) this.armSession(agentId, state, sessionId);
      }
    }
  }
}
