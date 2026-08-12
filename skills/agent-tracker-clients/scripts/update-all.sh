#!/usr/bin/env bash
# 本机一键安装 / 更新 Runmark 客户端（转调品牌包 @runmarks/runmark）
# 用法：
#   ./skills/agent-tracker-clients/scripts/update-all.sh
#   ./skills/agent-tracker-clients/scripts/update-all.sh all
#   ./skills/agent-tracker-clients/scripts/update-all.sh cursor,codex,workbuddy
set -euo pipefail

# Use public npmjs by default; honor NPM_CONFIG_REGISTRY if already set
if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
  export NPM_CONFIG_REGISTRY
fi

CLIENTS="${1:-all}"

ENV_FILE="${HOME}/.config/agent-tracker/env"
if [ ! -f "$ENV_FILE" ]; then
  echo "WARN: $ENV_FILE 不存在。请先写入 AGENT_TRACKER_ENDPOINT / AGENT_TRACKER_API_KEY。"
  echo "      参考 skills/agent-tracker-clients/SKILL.md §1"
else
  echo "==> Found env: $ENV_FILE"
fi
echo

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ -x "$ROOT/packages/runmark/install.sh" ]; then
  echo "==> 使用仓库源码入口 packages/runmark"
  bash "$ROOT/packages/runmark/install.sh" --clients "$CLIENTS"
else
  echo "==> 使用 npm 包 @runmarks/runmark"
  if command -v bunx >/dev/null 2>&1; then
    bunx --bun @runmarks/runmark --clients "$CLIENTS"
  else
    npx --yes @runmarks/runmark --clients "$CLIENTS"
  fi
fi
