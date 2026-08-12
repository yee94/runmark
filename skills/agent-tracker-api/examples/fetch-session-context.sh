#!/usr/bin/env bash
# 拉取单个 session 的完整分析上下文（元数据 + 消息 + turns + tool calls）
# 用法: ./fetch-session-context.sh <session_id> [output.json]
set -euo pipefail

SESSION_ID="${1:?用法: $0 <session_id> [output.json]}"
OUT="${2:-session-${SESSION_ID}.json}"

# 自动加载 ~/.config/agent-tracker/env（静默，缺失不报错）
ENV_FILE="${HOME}/.config/agent-tracker/env"
if [[ -z "${AGENT_TRACKER_ENDPOINT:-}" ]] && [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

BASE="${AGENT_TRACKER_ENDPOINT:-http://localhost:3456}"
KEY="${AGENT_TRACKER_API_KEY:-}"
AUTH=()
if [[ -n "$KEY" ]]; then
  AUTH=(-H "X-API-Key: $KEY")
fi

curl -sS "${AUTH[@]}" "$BASE/v1/sessions/$SESSION_ID" > /tmp/at-session.json
curl -sS "${AUTH[@]}" "$BASE/v1/sessions/$SESSION_ID/messages?limit=500" > /tmp/at-messages.json
curl -sS "${AUTH[@]}" "$BASE/v1/sessions/$SESSION_ID/turns" > /tmp/at-turns.json
curl -sS "${AUTH[@]}" "$BASE/v1/sessions/$SESSION_ID/tool-calls" > /tmp/at-tools.json
curl -sS "${AUTH[@]}" "$BASE/v1/sessions/$SESSION_ID/children" > /tmp/at-children.json

jq -n \
  --slurpfile session /tmp/at-session.json \
  --slurpfile messages /tmp/at-messages.json \
  --slurpfile turns /tmp/at-turns.json \
  --slurpfile tool_calls /tmp/at-tools.json \
  --slurpfile children /tmp/at-children.json \
  '{
    session: $session[0],
    messages: $messages[0],
    turns: $turns[0],
    tool_calls: $tool_calls[0],
    children: $children[0],
    fetched_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
  }' > "$OUT"

echo "Wrote $OUT"
echo "  messages: $(jq '.messages | length' "$OUT")"
echo "  turns:    $(jq '.turns | length' "$OUT")"
echo "  tools:    $(jq '.tool_calls | length' "$OUT")"
echo "  children: $(jq '.children | length' "$OUT")"
