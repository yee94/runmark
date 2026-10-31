#!/usr/bin/env bash
# 拉取单个 session 的分析上下文（元数据 + 分页消息 + turns + tool calls）
# 用法: ./fetch-session-context.sh <session_id> [output.json]
set -euo pipefail

SESSION_ID="${1:?用法: $0 <session_id> [output.json]}"
OUT="${2:-session-${SESSION_ID}.json}"

# 自动加载 ~/.config/agent-tracker/env（静默，缺失不报错）
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runmark-api.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/runmark-session.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
runmark_get "/v1/sessions/$SESSION_ID" > "$TMP/session.json"
offset=0
while :; do
  runmark_get "/v1/sessions/$SESSION_ID/messages?limit=500&offset=$offset" > "$TMP/page.json"
  jq -e 'type == "array"' "$TMP/page.json" >/dev/null
  jq -c '.[]' "$TMP/page.json" >> "$TMP/messages.jsonl"
  count="$(jq 'length' "$TMP/page.json")"
  [[ "$count" -lt 500 ]] && break
  offset=$((offset + count))
done
jq -s . "$TMP/messages.jsonl" > "$TMP/messages.json"
runmark_get "/v1/sessions/$SESSION_ID/turns" > "$TMP/turns.json"
runmark_get "/v1/sessions/$SESSION_ID/tool-calls" > "$TMP/tools.json"
runmark_get "/v1/sessions/$SESSION_ID/children" > "$TMP/children.json"

jq -n \
  --slurpfile session "$TMP/session.json" \
  --slurpfile messages "$TMP/messages.json" \
  --slurpfile turns "$TMP/turns.json" \
  --slurpfile tool_calls "$TMP/tools.json" \
  --slurpfile children "$TMP/children.json" \
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
