// 部分 OpenAI 兼容网关除 Bearer 外还要求 X-API-Key；子串列表由环境变量 AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS 提供（逗号分隔，不区分大小写）
function xApiKeyHostMarkers(): string[] {
  return String(process.env.AGENT_TRACKER_LLM_X_API_KEY_HOST_MARKERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function shouldSendXApiKey(baseUrl: string): boolean {
  const u = String(baseUrl).toLowerCase();
  return xApiKeyHostMarkers().some((m) => u.includes(m.toLowerCase()));
}

export function buildLlmAuthHeaders(apiKey: string, baseUrl = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (shouldSendXApiKey(baseUrl)) headers["X-API-Key"] = apiKey;
  return headers;
}
