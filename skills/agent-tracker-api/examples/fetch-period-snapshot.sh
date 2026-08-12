#!/usr/bin/env bash
# 拉取某时间段的统计快照 + 近期会话列表（供 Agent 分析用量趋势）
# 用法: ./fetch-period-snapshot.sh [range] [output.json]
# range: today | 24h | 7d | month | all
set -euo pipefail

RANGE="${1:-7d}"
OUT="${2:-period-${RANGE}.json}"

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

curl -sS "${AUTH[@]}" "$BASE/v1/stats/summary?range=$RANGE" > /tmp/at-summary.json
curl -sS "${AUTH[@]}" "$BASE/v1/stats/by-model?range=$RANGE&sort=tokens" > /tmp/at-by-model.json
curl -sS "${AUTH[@]}" "$BASE/v1/stats/by-agent?range=$RANGE&sort=tokens" > /tmp/at-by-agent.json
curl -sS "${AUTH[@]}" "$BASE/v1/stats/daily" > /tmp/at-daily.json
curl -sS "${AUTH[@]}" "$BASE/v1/sessions?limit=100" > /tmp/at-sessions.json
curl -sS "${AUTH[@]}" "$BASE/v1/turns?limit=50" > /tmp/at-recent-turns.json
curl -sS "${AUTH[@]}" "$BASE/v1/cursor/status" > /tmp/at-cursor-status.json

jq -n \
  --arg range "$RANGE" \
  --slurpfile summary /tmp/at-summary.json \
  --slurpfile by_model /tmp/at-by-model.json \
  --slurpfile by_agent /tmp/at-by-agent.json \
  --slurpfile daily /tmp/at-daily.json \
  --slurpfile sessions /tmp/at-sessions.json \
  --slurpfile recent_turns /tmp/at-recent-turns.json \
  --slurpfile cursor_status /tmp/at-cursor-status.json \
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
