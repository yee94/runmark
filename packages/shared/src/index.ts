/**
 * Runmark shared types and contracts between server and plugins.
 */

import { canonicalizeModelId, normalizeModelId } from "./model-id";

export {
  canonicalizeModelId,
  normalizeModelId,
  getModelPricingAliases,
} from "./model-id";
export { SKIP_TOOL_NAMES, shouldSkipTool } from "./skip-tools";

// ============================================================================
// Ingestion API contracts
// ============================================================================

export interface IngestSessionEvent {
  type: "session.created" | "session.updated" | "session.idle" | "session.compacted";
  session_id: string;
  agent: string;
  /** OpenCode session.title */
  title?: string;
  project_name?: string;
  repo_url?: string;
  branch?: string;
  user_email?: string;
  hostname?: string;
  worktree?: string;
  directory?: string;
  provider?: string;
  model?: string;
  /** Set on session.idle */
  request_count?: number;
  /** Set on session.idle */
  ended_at?: string;
  /** OpenCode session.parentID — subagent 指向父会话 */
  parent_session_id?: string;
  /** OpenCode session.cost 累计值，用于校准 subagent 等 turn.cost 为 0 的场景 */
  session_cost_usd?: number;
  session_input_tokens?: number;
  session_output_tokens?: number;
  session_total_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface IngestTurnEvent {
  type: "turn.completed" | "turn.error";
  session_id: string;
  turn_id: string;
  message_id?: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens: number;
  duration_ms: number;
  /** Server will compute cost if not provided */
  cost_usd?: number;
  finish_reason?: string;
  error?: string;
  created_at: string;
}

export interface IngestMessageEvent {
  type: "message";
  session_id: string;
  message_id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning";
  /** Plain text or JSON-serializable content. */
  content?: string | Record<string, unknown>;
  model?: string;
  provider?: string;
  parent_message_id?: string;
  tool_calls?: IngestToolCallPayload[];
  tool_call_id?: string;
  created_at: string;
}

export interface IngestToolCallPayload {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface IngestToolResultEvent {
  type: "tool.result";
  session_id: string;
  /** 来源 agent（cursor / opencode / codex）；缺省时 ensureSession 不得默认成 opencode */
  agent?: string;
  turn_id?: string;
  tool_name: string;
  call_id: string;
  args?: Record<string, unknown>;
  output_title?: string;
  output_metadata?: Record<string, unknown>;
  output_text?: string;
  file_path?: string;
  language?: string;
  additions?: number;
  deletions?: number;
  duration_ms: number;
  error?: string;
  created_at: string;
}

export type IngestEvent =
  | IngestSessionEvent
  | IngestTurnEvent
  | IngestMessageEvent
  | IngestToolResultEvent;

export interface IngestBatchRequest {
  events: IngestEvent[];
}

// ============================================================================
// Server response contracts
// ============================================================================

export interface IngestBatchResponse {
  ingested: number;
  errors: Array<{ index: number; error: string }>;
}

export interface ApiErrorResponse {
  error: string;
}

// ============================================================================
// Domain models (also used by server serializers)
// ============================================================================

export interface Session {
  id: string;
  agent: string;
  /** OpenCode session.title，展示用 summary 优先取此字段 */
  title?: string;
  provider?: string;
  model?: string;
  project_name?: string;
  repo_url?: string;
  branch?: string;
  user_email?: string;
  hostname?: string;
  worktree?: string;
  directory?: string;
  started_at: string;
  ended_at?: string;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  /** 父会话 ID；subagent 子会话非空 */
  parent_session_id?: string;
  metadata?: string;
}

export interface ConversationMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning";
  content?: string;
  model?: string;
  provider?: string;
  parent_message_id?: string;
  tool_calls?: string;
  tool_call_id?: string;
  created_at: string;
}

export interface Turn {
  id: string;
  session_id: string;
  message_id?: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  duration_ms: number;
  cost_usd: number;
  finish_reason?: string;
  error?: string;
  created_at: string;
}

export interface ToolCall {
  id: string;
  session_id: string;
  turn_id?: string;
  tool_name: string;
  call_id: string;
  args?: string;
  output_title?: string;
  output_metadata?: string;
  output_text?: string;
  file_path?: string;
  language?: string;
  additions: number;
  deletions: number;
  duration_ms: number;
  error?: string;
  created_at: string;
}

// ============================================================================
// Pricing model
// ============================================================================

export interface ModelPricing {
  provider: string;
  model: string;
  /** Price per 1M input tokens in USD. */
  input_price: number;
  /** Price per 1M output tokens in USD. */
  output_price: number;
  cache_read_price?: number;
  cache_write_price?: number;
  reasoning_price?: number;
  /** 整次请求输入（含缓存）超过阈值时使用的价格，按最高命中阈值选择。 */
  context_tiers?: Array<{
    above: number;
    input_price: number;
    output_price: number;
    cache_read_price?: number;
    cache_write_price?: number;
    reasoning_price?: number;
  }>;
}

const ASTRA_CONTEXT_PRICING = {
  reasoning_price: 50,
  context_tiers: [{ above: 272_000, input_price: 20, output_price: 75, cache_read_price: 2, cache_write_price: 25, reasoning_price: 75 }],
};

/** Default pricing table (USD per 1M tokens). Will be kept up to date periodically. */
export const DEFAULT_PRICING: ModelPricing[] = [
  // Anthropic
  // claude-sonnet-5 按正式价 $3/$15 计；官方 intro 优惠价 $2/$10 至 2026-08-31，定价表不区分生效日期
  // Opus 4.5+ / Opus 5 官方 $5/$25（cache read 0.1x / 5m write 1.25x）；仅旧 Opus 4 / 4.1 为 $15/$75
  { provider: "anthropic", model: "claude-sonnet-5", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "anthropic", model: "claude-opus-5-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-8", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-7", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-6", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "anthropic", model: "claude-opus-4-20250514", input_price: 15.0, output_price: 75.0, cache_read_price: 1.5, cache_write_price: 18.75 },
  { provider: "anthropic", model: "claude-sonnet-4-20250514", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "anthropic", model: "claude-sonnet-4", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "anthropic", model: "claude-haiku-4-20250514", input_price: 0.5, output_price: 2.5, cache_read_price: 0.05, cache_write_price: 0.625 },
  // OpenAI
  { provider: "openai", model: "gpt-4.1", input_price: 2.0, output_price: 8.0 },
  { provider: "openai", model: "gpt-4.1-mini", input_price: 0.4, output_price: 1.6 },
  { provider: "openai", model: "gpt-4.1-nano", input_price: 0.1, output_price: 0.4 },
  { provider: "openai", model: "gpt-5.6-sol", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "openai", model: "gpt-5.6-terra", input_price: 2.5, output_price: 15.0, cache_read_price: 0.25, cache_write_price: 3.125 },
  { provider: "openai", model: "gpt-5.6-luna", input_price: 1.0, output_price: 6.0, cache_read_price: 0.1, cache_write_price: 1.25 },
  { provider: "openai", model: "gpt-5.6-sol-fast", input_price: 10.0, output_price: 60.0, cache_read_price: 1.0, cache_write_price: 12.5 },
  { provider: "openai", model: "gpt-5.6-terra-fast", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "openai", model: "gpt-5.6-luna-fast", input_price: 2.0, output_price: 12.0, cache_read_price: 0.2, cache_write_price: 2.5 },
  // GPT-6（2026-09-03 发布；>272K 长上下文整单按 $20/$75 计。base gpt-6 同 astra 标准档）
  { provider: "openai", model: "gpt-6-sol", input_price: 2, output_price: 10, cache_read_price: 0.2, cache_write_price: 2.5, reasoning_price: 10,
    context_tiers: [{ above: 272_000, input_price: 4, output_price: 15, cache_read_price: 0.4, cache_write_price: 5, reasoning_price: 15 }] },
  { provider: "openai", model: "gpt-6-sol-fast", input_price: 4, output_price: 20, cache_read_price: 0.4, cache_write_price: 5, reasoning_price: 20,
    context_tiers: [{ above: 272_000, input_price: 8, output_price: 30, cache_read_price: 0.8, cache_write_price: 10, reasoning_price: 30 }] },
  { provider: "openai", model: "gpt-6-luna", input_price: 0.1, output_price: 0.5, cache_read_price: 0.01, cache_write_price: 0.125, reasoning_price: 0.5,
    context_tiers: [{ above: 272_000, input_price: 0.2, output_price: 0.75, cache_read_price: 0.02, cache_write_price: 0.25, reasoning_price: 0.75 }] },
  { provider: "openai", model: "gpt-6-luna-fast", input_price: 0.2, output_price: 1, cache_read_price: 0.02, cache_write_price: 0.25, reasoning_price: 1,
    context_tiers: [{ above: 272_000, input_price: 0.4, output_price: 1.5, cache_read_price: 0.04, cache_write_price: 0.5, reasoning_price: 1.5 }] },
  { provider: "openai", model: "gpt-6.1-sol", input_price: 2, output_price: 10, cache_read_price: 0.1, cache_write_price: 2.5, reasoning_price: 10,
    context_tiers: [{ above: 272_000, input_price: 4, output_price: 15, cache_read_price: 0.2, cache_write_price: 5, reasoning_price: 15 }] },
  { provider: "openai", model: "gpt-6.1-sol-fast", input_price: 4, output_price: 20, cache_read_price: 0.2, cache_write_price: 5, reasoning_price: 20,
    context_tiers: [{ above: 272_000, input_price: 8, output_price: 30, cache_read_price: 0.4, cache_write_price: 10, reasoning_price: 30 }] },
  { provider: "openai", model: "gpt-6", input_price: 10.0, output_price: 50.0, cache_read_price: 1.0, cache_write_price: 12.5, ...ASTRA_CONTEXT_PRICING },
  { provider: "openai", model: "gpt-6-astra", input_price: 10.0, output_price: 50.0, cache_read_price: 1.0, cache_write_price: 12.5, ...ASTRA_CONTEXT_PRICING },
  { provider: "openai", model: "gpt-6-astra-fast", input_price: 20.0, output_price: 100.0, cache_read_price: 2.0, cache_write_price: 25.0, reasoning_price: 100,
    context_tiers: [{ above: 272_000, input_price: 40, output_price: 150, cache_read_price: 4, cache_write_price: 50, reasoning_price: 150 }] },
  { provider: "openai", model: "gpt-5.5", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5 },
  { provider: "openai", model: "gpt-5.5-fast", input_price: 12.5, output_price: 75.0, cache_read_price: 1.25 },
  { provider: "openai", model: "gpt-5.4", input_price: 2.5, output_price: 15.0, cache_read_price: 0.25 },
  { provider: "openai", model: "gpt-5.4-fast", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5 },
  { provider: "openai", model: "gpt-5.4-mini", input_price: 0.75, output_price: 4.5, cache_read_price: 0.075 },
  { provider: "openai", model: "gpt-5.4-nano", input_price: 0.2, output_price: 1.25, cache_read_price: 0.02 },
  { provider: "openai", model: "o4-mini", input_price: 1.1, output_price: 4.4, reasoning_price: 1.1 },
  { provider: "openai", model: "o3", input_price: 10.0, output_price: 40.0, reasoning_price: 10.0 },
  // Google
  { provider: "google", model: "gemini-3.6-flash", input_price: 1.5, output_price: 7.5 },
  { provider: "google", model: "gemini-3.5-flash", input_price: 1.5, output_price: 9.0 },
  { provider: "google", model: "gemini-2.5-pro", input_price: 1.25, output_price: 10.0 },
  { provider: "google", model: "gemini-2.5-flash", input_price: 0.15, output_price: 0.6 },
  // Moonshot AI (Kimi)
  { provider: "moonshot", model: "kimi-k3", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3 },
  { provider: "moonshot", model: "kimi-k2", input_price: 2.0, output_price: 8.0 },
  // Aliyun (Qwen)
  { provider: "aliyun", model: "qwen3", input_price: 0.55, output_price: 2.2 },
  // 智谱 Z.AI（基座价；glm-*-ioa 等经 canonicalizeModelId 归一后再匹配）
  { provider: "zhipu", model: "glm-5.2", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "zhipu", model: "glm-5.1", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "zhipu", model: "glm-5", input_price: 1.0, output_price: 3.2, cache_read_price: 0.2 },
  { provider: "zhipu", model: "glm-5-turbo", input_price: 1.2, output_price: 4.0, cache_read_price: 0.24 },
  { provider: "zhipu", model: "glm-4.7", input_price: 0.6, output_price: 2.2, cache_read_price: 0.11 },
  { provider: "zhipu", model: "glm-4.6", input_price: 0.6, output_price: 2.2, cache_read_price: 0.11 },
  // 混元（hy3-ioa / hy-3）
  { provider: "hunyuan", model: "hy-3", input_price: 0.5, output_price: 2.0 },
  // CodeBuddy（OpenCode / IDE 常上报 CodeBuddy + Claude-Opus-4.8 / glm-*-ioa）
  { provider: "codebuddy", model: "claude-opus-5-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codebuddy", model: "claude-opus-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codebuddy", model: "claude-opus-4-6", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codebuddy", model: "claude-opus-4-7", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codebuddy", model: "claude-opus-4-8", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codebuddy", model: "claude-sonnet-4-6", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "codebuddy", model: "gpt-6-astra", input_price: 10.0, output_price: 50.0, cache_read_price: 1.0, cache_write_price: 12.5, ...ASTRA_CONTEXT_PRICING },
  // DeepSeek 官方 API 高峰价（2026-08-17 起峰谷定价，空闲时段为半价；人民币 / USD_TO_CNY）
  { provider: "codebuddy", model: "deepseek-v4-flash", input_price: 0.429, output_price: 1.286, cache_read_price: 0.014 },
  { provider: "codebuddy", model: "deepseek-v4-pro", input_price: 1.286, output_price: 3.857, cache_read_price: 0.043 },
  { provider: "codebuddy", model: "glm-5.2", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "codebuddy", model: "glm-5.1", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "codebuddy", model: "glm-5", input_price: 1.0, output_price: 3.2, cache_read_price: 0.2 },
  { provider: "codebuddy", model: "hy-3", input_price: 0.5, output_price: 2.0 },
  // Astra / Kimi
  { provider: "astra", model: "kimi-k2", input_price: 2.0, output_price: 8.0 },
  { provider: "astra", model: "deepseek-v4-pro-code", input_price: 1.286, output_price: 3.857, cache_read_price: 0.043 },
  { provider: "astra", model: "glm-5.2", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "astra", model: "glm-5.1", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  // BoxAI（腾讯内网代理，按 Anthropic 官方定价估算）
  { provider: "boxai", model: "claude-sonnet-4-6", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "boxai", model: "claude-opus-5-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "boxai", model: "claude-opus-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "boxai", model: "claude-opus-4-6", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "boxai", model: "claude-opus-4-7", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "boxai", model: "claude-opus-4-8", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "boxai", model: "deepseek-v4-pro", input_price: 1.286, output_price: 3.857, cache_read_price: 0.043 },
  { provider: "boxai", model: "deepseek-v4-flash", input_price: 0.429, output_price: 1.286, cache_read_price: 0.014 },
  { provider: "boxai", model: "glm-5.2", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "boxai", model: "gemini-3.6-flash", input_price: 1.5, output_price: 7.5 },
  { provider: "boxai", model: "gemini-3.5-flash", input_price: 1.5, output_price: 9.0 },
  { provider: "boxai", model: "kimi-k2", input_price: 2.0, output_price: 8.0 },
  // IMate（内网代理，含 Claude / GPT / GLM / 混元）
  { provider: "imate", model: "claude-opus-5-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "imate", model: "claude-opus-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "imate", model: "claude-opus-4-6", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "imate", model: "claude-opus-4-7", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "imate", model: "claude-opus-4-8", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "imate", model: "gpt-6-astra", input_price: 10.0, output_price: 50.0, cache_read_price: 1.0, cache_write_price: 12.5, ...ASTRA_CONTEXT_PRICING },
  { provider: "imate", model: "glm-5.2", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "imate", model: "glm-5.1", input_price: 1.4, output_price: 4.4, cache_read_price: 0.26 },
  { provider: "imate", model: "hy-3", input_price: 0.5, output_price: 2.0 },
  // Cursor IDE（Hook 上报 agent=cursor）
  // Composer 2.5：Standard $0.50/$2.50 cache $0.20；Fast（默认）$3/$15（Cursor 官方表）
  { provider: "cursor", model: "composer-2.5", input_price: 0.5, output_price: 2.5, cache_read_price: 0.2 },
  { provider: "cursor", model: "composer-2.5-fast", input_price: 3.0, output_price: 15.0, cache_read_price: 0.5 },
  { provider: "cursor", model: "claude-opus-5-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "cursor", model: "claude-opus-5", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "cursor", model: "claude-opus-4-8", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "cursor", model: "claude-opus-4-7", input_price: 5.0, output_price: 25.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "cursor", model: "claude-sonnet-4", input_price: 3.0, output_price: 15.0, cache_read_price: 0.3, cache_write_price: 3.75 },
  { provider: "cursor", model: "gpt-4.1", input_price: 2.0, output_price: 8.0 },
  { provider: "cursor", model: "gemini-3.8-flash", input_price: 0.75, output_price: 3.5, cache_read_price: 0.075 },
  // Cursor / xAI 联合 Grok（Cursor 表 cache read $0.5；API 官方 cache $0.30，见 xai 行）
  { provider: "cursor", model: "cursor-grok-4.5", input_price: 2.0, output_price: 6.0, cache_read_price: 0.5, reasoning_price: 6.0 },
  { provider: "cursor", model: "grok-4.5", input_price: 2.0, output_price: 6.0, cache_read_price: 0.5, reasoning_price: 6.0 },
  // Grok 4.7（Cursor docs 2026-09-21）：standard $2/$6 cache $0.50；Fast 2x
  { provider: "cursor", model: "cursor-grok-4.7", input_price: 2.0, output_price: 6.0, cache_read_price: 0.5, reasoning_price: 6.0 },
  { provider: "cursor", model: "grok-4.7", input_price: 2.0, output_price: 6.0, cache_read_price: 0.5, reasoning_price: 6.0 },
  { provider: "cursor", model: "grok-4.7-fast", input_price: 4.0, output_price: 12.0, cache_read_price: 1.0, reasoning_price: 12.0 },
  // Codex（Hook 上报 agent=codex，模型多为 openai / 代理 id）
  { provider: "codex", model: "gpt-6-astra", input_price: 10.0, output_price: 50.0, cache_read_price: 1.0, cache_write_price: 12.5, ...ASTRA_CONTEXT_PRICING },
  { provider: "codex", model: "gpt-5.6-sol", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5, cache_write_price: 6.25 },
  { provider: "codex", model: "gpt-5.6-terra", input_price: 2.5, output_price: 15.0, cache_read_price: 0.25, cache_write_price: 3.125 },
  { provider: "codex", model: "gpt-5.6-luna", input_price: 1.0, output_price: 6.0, cache_read_price: 0.1, cache_write_price: 1.25 },
  { provider: "codex", model: "gpt-5.4", input_price: 2.5, output_price: 15.0, cache_read_price: 0.25 },
  { provider: "codex", model: "gpt-5.5", input_price: 5.0, output_price: 30.0, cache_read_price: 0.5 },
  { provider: "codex", model: "o3", input_price: 10.0, output_price: 40.0, reasoning_price: 10.0 },
  { provider: "codex", model: "o4-mini", input_price: 1.1, output_price: 4.4, reasoning_price: 1.1 },
  // xAI 官方 API（docs.x.ai；短上下文 <200k；reasoning 按 output 计）
  { provider: "xai", model: "grok-4.5", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "xai", model: "grok-4.5-build", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "xai", model: "grok-4.6", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "xai", model: "grok-4.7", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "xai", model: "grok-4.7-build-fast", input_price: 4.0, output_price: 12.0, cache_read_price: 0.5, reasoning_price: 12.0 },
  { provider: "xai", model: "grok-4.3", input_price: 1.25, output_price: 2.5, cache_read_price: 0.2, reasoning_price: 2.5 },
  { provider: "xai", model: "grok-build-0.1", input_price: 1.0, output_price: 2.0, cache_read_price: 0.2, reasoning_price: 2.0 },
  { provider: "xai", model: "grok-4", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "xai", model: "grok-3", input_price: 3.0, output_price: 15.0, cache_read_price: 0.75 },
  { provider: "xai", model: "grok-3-mini", input_price: 0.3, output_price: 0.5 },
  // open-grok-build OpenCode 插件（provider=grok-build；cost 常漏 cache，server 按 API 重算）
  { provider: "grok-build", model: "grok-4.5", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok-build", model: "grok-4.6", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok-build", model: "grok-4.7", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok-build", model: "grok-4.7-build-fast", input_price: 4.0, output_price: 12.0, cache_read_price: 0.5, reasoning_price: 12.0 },
  { provider: "grok-build", model: "grok-4.3", input_price: 1.25, output_price: 2.5, cache_read_price: 0.2, reasoning_price: 2.5 },
  { provider: "grok-build", model: "grok-build", input_price: 1.0, output_price: 2.0, cache_read_price: 0.2, reasoning_price: 2.0 },
  { provider: "grok-build", model: "grok-composer-2.5-fast", input_price: 3.0, output_price: 15.0, cache_read_price: 0.5, reasoning_price: 15.0 },
  { provider: "grok-build", model: "grok-4.20-0309-reasoning", input_price: 1.25, output_price: 2.5, cache_read_price: 0.2, reasoning_price: 2.5 },
  { provider: "grok-build", model: "grok-4.20-0309-non-reasoning", input_price: 1.25, output_price: 2.5, cache_read_price: 0.2 },
  { provider: "grok-build", model: "grok-4.20-multi-agent-0309", input_price: 1.25, output_price: 2.5, cache_read_price: 0.2, reasoning_price: 2.5 },
  // Grok CLI Hook（agent=grok）
  { provider: "grok", model: "grok-4.5", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok", model: "grok-4.5-build", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok", model: "grok-4.6", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok", model: "grok-4.7", input_price: 2.0, output_price: 6.0, cache_read_price: 0.3, reasoning_price: 6.0 },
  { provider: "grok", model: "grok-4.7-build-fast", input_price: 4.0, output_price: 12.0, cache_read_price: 0.5, reasoning_price: 12.0 },
  { provider: "grok", model: "grok-composer-2.5-fast", input_price: 3.0, output_price: 15.0, cache_read_price: 0.5, reasoning_price: 15.0 },
];

/** 模型族关键词（先匹配更具体的，避免 claude 笼统兜底） */
const MODEL_FAMILY_TOKENS = [
  "opus",
  "sonnet",
  "haiku",
  "deepseek",
  "composer",
  "grok",
  "kimi",
  "moonshot",
  "gemini",
  "gpt",
  "qwen",
  "glm",
  "hy",
] as const;

/** 档位关键词：未知新版本按同档兜底（gpt-6-mini → mini，而非旗舰） */
const MODEL_TIER_TOKENS = ["nano", "mini", "flash", "fast", "pro"] as const;

/** 折扣档：查询无档位时排除，避免 gpt-6 落到 gpt-5.4-mini */
const DISCOUNT_TIER_TOKENS = ["nano", "mini", "flash", "fast"] as const;

/** 按连字符分词判断 token，避免 gemini 误命中 mini */
function hasModelToken(modelNorm: string, token: string): boolean {
  return new RegExp(`(^|-)${token}(-|$)`).test(modelNorm);
}

/** OpenAI o 系列（o3 / o4 / o5…） */
function isOSeriesModel(modelNorm: string): boolean {
  return /(^|-)o\d/.test(modelNorm);
}

type ModelFamily =
  | { kind: "token"; token: string }
  | { kind: "o-series" };

/** 从 model id 推断定价族，供未知新版本按族兜底 */
function inferModelFamily(modelNorm: string): ModelFamily | undefined {
  const token = MODEL_FAMILY_TOKENS.find((t) => modelNorm.includes(t));
  if (token) return { kind: "token", token };
  if (isOSeriesModel(modelNorm)) return { kind: "o-series" };
  return undefined;
}

/** 定价行是否属于该模型族 */
function modelMatchesFamily(pricedNorm: string, family: ModelFamily): boolean {
  if (family.kind === "o-series") return isOSeriesModel(pricedNorm);
  return pricedNorm.includes(family.token);
}

/** 从 model id 提取档位标记（分词，避免 gemini⊃mini） */
function inferModelTiers(modelNorm: string): string[] {
  return MODEL_TIER_TOKENS.filter((token) => hasModelToken(modelNorm, token));
}

/** 在候选中选最长 model 命中，避免 gpt-5 抢先匹配 gpt-5.4 */
function pickLongestModelMatch(candidates: ModelPricing[]): ModelPricing | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, cur) =>
    canonicalizeModelId(cur.model).length > canonicalizeModelId(best.model).length ? cur : best,
  );
}

/** 同族兜底：优先同档，无档则取旗舰（排除 mini/nano/flash），再取最高 input 单价 */
function findFamilyPricing(
  candidates: ModelPricing[],
  family: ModelFamily,
  modelNorm: string,
): ModelPricing | undefined {
  const familyRows = candidates.filter((p) => modelMatchesFamily(canonicalizeModelId(p.model), family));
  if (familyRows.length === 0) return undefined;

  const queryTiers = inferModelTiers(modelNorm);
  let pool = familyRows;

  if (queryTiers.length > 0) {
    const tierMatched = familyRows.filter((p) => {
      const priced = canonicalizeModelId(p.model);
      return queryTiers.some((t) => hasModelToken(priced, t));
    });
    if (tierMatched.length > 0) pool = tierMatched;
  } else {
    const flagship = familyRows.filter((p) => {
      const priced = canonicalizeModelId(p.model);
      return !DISCOUNT_TIER_TOKENS.some((t) => hasModelToken(priced, t));
    });
    if (flagship.length > 0) pool = flagship;
  }

  return pool.reduce((best, cur) => {
    if (cur.input_price !== best.input_price) {
      return cur.input_price > best.input_price ? cur : best;
    }
    return canonicalizeModelId(cur.model).length > canonicalizeModelId(best.model).length ? cur : best;
  });
}

/**
 * 按 provider + model 查找定价。
 * model 先经 canonicalizeModelId（剥 -ioa/-official/-1m 等），再精确 / 包含 / 族兜底；
 * Codex / OpenCode / Cursor / CodeBuddy 共用，禁止盲目套用同 provider 第一条。
 */
function findPricing(
  provider: string,
  model: string,
  pricingTable: ModelPricing[],
): ModelPricing | undefined {
  const providerLower = provider.toLowerCase();
  const modelNorm = canonicalizeModelId(model);
  const key = `${providerLower}::${modelNorm}`;
  const family = inferModelFamily(modelNorm);

  const exact = pricingTable.find(
    (p) => `${p.provider.toLowerCase()}::${canonicalizeModelId(p.model)}` === key,
  );
  if (exact) return exact;

  // 精确模型的跨 provider 正价优先于本 provider 的泛型号匹配（如 gpt-6、Astra）。
  const exactModel = pricingTable.find((p) => canonicalizeModelId(p.model) === modelNorm);
  if (exactModel) return exactModel;

  const byProvider = pricingTable.filter((p) => p.provider.toLowerCase() === providerLower);
  const byProviderModel = pickLongestModelMatch(
    byProvider.filter((p) => {
      const priced = canonicalizeModelId(p.model);
      return modelNorm === priced || modelNorm.includes(priced) || priced.includes(modelNorm);
    }),
  );
  if (byProviderModel) return byProviderModel;

  // 同 provider 无精确条目时，按规范化 model 跨 provider 回退（CodeBuddy Opus → Anthropic/BoxAI 单价）
  const crossProvider = pickLongestModelMatch(
    pricingTable.filter((p) => {
      const priced = canonicalizeModelId(p.model);
      return modelNorm === priced || modelNorm.includes(priced);
    }),
  );
  if (crossProvider) return crossProvider;

  // 未知新版本：按模型族 + 档位兜底（gpt-6 → 旗舰 gpt，gpt-6-mini → mini；opus 新版绝不落到 deepseek）
  if (family) {
    const familyInProvider = findFamilyPricing(byProvider, family, modelNorm);
    if (familyInProvider) return familyInProvider;

    const familyCross = findFamilyPricing(pricingTable, family, modelNorm);
    if (familyCross) return familyCross;
  }

  return undefined;
}

/**
 * Compute cost from usage and pricing.
 * Falls back to zeros when pricing is not found.
 */
export function computeCost(
  provider: string,
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    /** Codex 等来源的 output_tokens 已包含推理，不能再次收费。 */
    output_includes_reasoning?: boolean;
  },
  pricingTable: ModelPricing[] = DEFAULT_PRICING,
): number {
  const base = findPricing(provider, model, pricingTable);

  if (!base) return 0;

  const context = usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  const tier = base.context_tiers?.filter((entry) => context > entry.above)
    .sort((a, b) => b.above - a.above)[0];
  const pricing = tier ? { ...base, ...tier } : base;

  const perM = (n?: number) => (n ?? 0) / 1_000_000;

  let cost =
    perM(usage.input_tokens) * pricing.input_price +
    perM(usage.output_tokens) * pricing.output_price;

  if (pricing.cache_read_price && usage.cache_read_tokens) {
    cost += perM(usage.cache_read_tokens) * pricing.cache_read_price;
  }
  if (pricing.cache_write_price && usage.cache_write_tokens) {
    cost += perM(usage.cache_write_tokens) * pricing.cache_write_price;
  }
  if (!usage.output_includes_reasoning && pricing.reasoning_price && usage.reasoning_tokens) {
    cost += perM(usage.reasoning_tokens) * pricing.reasoning_price;
  }

  return Math.round(cost * 1_000_000_000) / 1_000_000_000;
}

/**
 * 离线兜底汇率。展示层优先用服务端实时汇率（见 server fx）；
 * 上报与存储仍为 USD。
 */
export const USD_TO_CNY = 7;

/** 将 USD 金额换算为人民币（仅用于展示层 API）。rate 缺省时用离线兜底。 */
export function usdToCny(usd: number, rate = USD_TO_CNY): number {
  return Math.round(usd * rate * 1_000_000_000) / 1_000_000_000;
}

// ============================================================================
// Plugin configuration helpers
// ============================================================================

export interface PluginConfig {
  endpoint: string;
  apiKey: string;
  /** Send full message content (may be large). Default true. */
  includeMessageContent?: boolean;
  /** Send tool call output text. Default true. */
  includeToolOutput?: boolean;
  /** Debug 模式：日志写入文件。默认 false */
  debug?: boolean;
  /** 日志文件路径，默认 ~/.config/agent-tracker/plugin.log */
  logFile?: string;
}

export {
  FileLogger,
  defaultPluginLogPath,
  defaultCursorHookLogPath,
  defaultServerLogPath,
  isDebugEnabled,
  isFileLogMode,
} from "./logger";
export type { FileLoggerOptions, LogLevel } from "./logger";
export {
  defaultPluginEnvPath,
  expandUserPath,
  loadEnvFile,
  parseEnvFile,
  resolveEnvValue,
} from "./env-file";
export { TrackerClient, buildIngestErrorToastMessage } from "./tracker-client";
export type { IngestErrorDetail } from "./tracker-client";
export { forkSourceTitle, isForkReplayTurn, isForkSessionTitle } from "./fork";
export { isHiddenSessionTitle } from "./hidden-session";
