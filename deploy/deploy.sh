#!/usr/bin/env bash
# 本地执行：同步代码到远程并触发 setup-remote.sh
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:?请设置 REMOTE_HOST，例如: REMOTE_HOST=<服务地址> ./deploy/deploy.sh}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PORT="${REMOTE_PORT:-36000}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agent-tracker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH="ssh -p $REMOTE_PORT ${REMOTE_USER}@${REMOTE_HOST}"
RSYNC_SSH="ssh -p $REMOTE_PORT"


echo "==> Syncing to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"

rsync -avz --delete \
  -e "$RSYNC_SSH" \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.db' \
  --exclude '*.db-shm' \
  --exclude '*.db-wal' \
  --exclude '*.db-journal' \
  --exclude '*.log' \
  --exclude .env \
  --exclude .DS_Store \
  "$ROOT_DIR/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> Running remote setup..."
$SSH "chmod +x ${REMOTE_DIR}/deploy/setup-remote.sh && bash ${REMOTE_DIR}/deploy/setup-remote.sh"
