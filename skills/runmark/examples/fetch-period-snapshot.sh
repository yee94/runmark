#!/usr/bin/env bash
# 拉取某时间段的统计快照 + 未按时间过滤的近期会话列表（供 Agent 分析用量趋势）
# 用法: ./fetch-period-snapshot.sh [range] [output.json] [from] [to]
# range: today | 24h | 7d | month | last_month | custom | all
set -euo pipefail

RANGE="${1:-7d}"
OUT="${2:-period-${RANGE}.json}"
FROM="${3:-}"
TO="${4:-}"
if [[ ( -n "$FROM" && -z "$TO" ) || ( -z "$FROM" && -n "$TO" ) || ( "$RANGE" == custom && -z "$FROM" ) ]]; then
  echo "from / to 必须成对传入；custom 必填" >&2
  exit 1
fi
STATS_QUERY=(-G --data-urlencode "range=$RANGE")
if [[ -n "$FROM" ]]; then
  STATS_QUERY+=(--data-urlencode "from=$FROM" --data-urlencode "to=$TO")
fi

# 自动加载 ~/.config/agent-tracker/env（静默，缺失不报错）
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runmark-api.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/runmark-period.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
runmark_get /v1/stats/summary "${STATS_QUERY[@]}" > "$TMP/summary.json"
runmark_get /v1/stats/by-model "${STATS_QUERY[@]}" --data-urlencode 'sort=tokens' > "$TMP/by-model.json"
runmark_get /v1/stats/by-agent "${STATS_QUERY[@]}" --data-urlencode 'sort=tokens' > "$TMP/by-agent.json"
runmark_get /v1/stats/daily "${STATS_QUERY[@]}" > "$TMP/daily.json"
runmark_get '/v1/sessions?limit=100' > "$TMP/sessions.json"
runmark_get '/v1/turns?limit=50' > "$TMP/recent-turns.json"
runmark_get /v1/cursor/status > "$TMP/cursor-status.json"

jq -n \
  --arg range "$RANGE" \
  --slurpfile summary "$TMP/summary.json" \
  --slurpfile by_model "$TMP/by-model.json" \
  --slurpfile by_agent "$TMP/by-agent.json" \
  --slurpfile daily "$TMP/daily.json" \
  --slurpfile sessions "$TMP/sessions.json" \
  --slurpfile recent_turns "$TMP/recent-turns.json" \
  --slurpfile cursor_status "$TMP/cursor-status.json" \
  '{
    range: $range,
    summary: $summary[0],
    by_model: $by_model[0],
    by_agent: $by_agent[0],
    daily: $daily[0],
    recent_sessions: $sessions[0],
    recent_turns: $recent_turns[0],
    cursor_status: $cursor_status[0],
    fetched_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
  }' > "$OUT"

echo "Wrote $OUT"
