#!/usr/bin/env bash
# 在目标机器上执行：安装 Bun、依赖、systemd 服务
set -euo pipefail

APP_ROOT="/opt/agent-tracker"
ENV_FILE="$APP_ROOT/.env"
BUN_INSTALL="$HOME/.bun/bin/bun"

echo "==> Runmark remote setup ($APP_ROOT)"

if [[ ! -x "$BUN_INSTALL" ]]; then
  echo "==> Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
fi

export PATH="$HOME/.bun/bin:$PATH"
bun --version

cd "$APP_ROOT"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE"
  API_KEY="$(openssl rand -hex 24)"
  CURSOR_KEY="$(openssl rand -hex 32)"
  cp "$APP_ROOT/deploy/env.example" "$ENV_FILE"
  sed -i "s/^AGENT_TRACKER_API_KEY=CHANGE_ME/AGENT_TRACKER_API_KEY=$API_KEY/" "$ENV_FILE"
  sed -i "s/^AGENT_TRACKER_CURSOR_CRYPTO_KEY=CHANGE_ME_CURSOR_CRYPTO_KEY/AGENT_TRACKER_CURSOR_CRYPTO_KEY=$CURSOR_KEY/" "$ENV_FILE"
  echo "==> Generated AGENT_TRACKER_API_KEY (saved in $ENV_FILE)"
  echo "==> Generated AGENT_TRACKER_CURSOR_CRYPTO_KEY (for Cursor Session Token encryption)"
else
  echo "==> Reusing existing $ENV_FILE"
fi

# 幂等追加更新字段到已存在的 .env
for field in AGENT_TRACKER_UPDATE_ENABLED AGENT_TRACKER_UPDATE_MANIFEST_URL AGENT_TRACKER_UPDATE_SCRIPT AGENT_TRACKER_UPDATE_STATE_PATH; do
  if ! grep -q "^${field}=" "$ENV_FILE" 2>/dev/null; then
    case "$field" in
      AGENT_TRACKER_UPDATE_ENABLED) echo "AGENT_TRACKER_UPDATE_ENABLED=true" >> "$ENV_FILE" ;;
      AGENT_TRACKER_UPDATE_MANIFEST_URL) echo "AGENT_TRACKER_UPDATE_MANIFEST_URL=https://github.com/yee94/runmark/releases/latest/download/server-manifest.json" >> "$ENV_FILE" ;;
      AGENT_TRACKER_UPDATE_SCRIPT) echo "AGENT_TRACKER_UPDATE_SCRIPT=/opt/runmark-updater/update.sh" >> "$ENV_FILE" ;;
      AGENT_TRACKER_UPDATE_STATE_PATH) echo "AGENT_TRACKER_UPDATE_STATE_PATH=/opt/runmark-updater/update-state.json" >> "$ENV_FILE" ;;
    esac
    echo "==> Added ${field} to ${ENV_FILE}"
  fi
done

mkdir -p "$APP_ROOT/packages/server/data"

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

echo "==> Initializing / migrating SQLite database..."
(
  cd "$APP_ROOT/packages/server"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  bun -e '
    import { loadConfig } from "./src/config";
    import { getDatabase } from "./src/db";
    const cfg = loadConfig();
    const db = getDatabase(cfg.dbPath);
    db.close();
    console.log(`DB ready: ${cfg.dbPath}`);
  '
)

echo "==> Installing systemd unit..."
cp "$APP_ROOT/deploy/agent-tracker.service" /etc/systemd/system/agent-tracker.service
systemctl daemon-reload
systemctl enable agent-tracker
systemctl restart agent-tracker

# ============================================================
# 安装自动更新器
# ============================================================
UPDATER_ROOT="/opt/runmark-updater"
UPDATER_SCRIPT="$UPDATER_ROOT/update.sh"

echo "==> Installing auto-updater to $UPDATER_ROOT"

mkdir -p "$UPDATER_ROOT"
mkdir -p "$UPDATER_ROOT/staging"
mkdir -p "$UPDATER_ROOT/backups"

# 安装更新脚本（root 所有）
cp "$APP_ROOT/deploy/runmark-update.sh" "$UPDATER_SCRIPT"
chown root:root "$UPDATER_SCRIPT"
chmod 700 "$UPDATER_SCRIPT"

# 确保目录权限
chown -R root:root "$UPDATER_ROOT"
chmod 755 "$UPDATER_ROOT"
chmod 755 "$UPDATER_ROOT/staging"
chmod 755 "$UPDATER_ROOT/backups"

# 初始化状态文件（如果不存在）
if [ ! -f "$UPDATER_ROOT/update-state.json" ]; then
  "$BUN_INSTALL" -e "
    const fs = require('fs');
    fs.writeFileSync('${UPDATER_ROOT}/update-state.json', JSON.stringify({
      phase: 'idle',
      version: null,
      startedAt: null,
      completedAt: null,
      error: null
    }, null, 2), 'utf-8');
  "
  chown root:root "$UPDATER_ROOT/update-state.json"
  chmod 644 "$UPDATER_ROOT/update-state.json"
fi

echo "==> Auto-updater installed: $UPDATER_SCRIPT"
echo "    手动触发: bash $UPDATER_SCRIPT --manifest-url <url> --expected-version <ver>"
echo "    状态文件: $UPDATER_ROOT/update-state.json"
echo "    备份目录: $UPDATER_ROOT/backups"

sleep 2
systemctl status agent-tracker --no-pager || true

PORT="$(grep '^AGENT_TRACKER_PORT=' "$ENV_FILE" | cut -d= -f2)"
API_KEY="$(grep '^AGENT_TRACKER_API_KEY=' "$ENV_FILE" | cut -d= -f2)"

echo ""
echo "==> Deploy complete"
echo "    Dashboard: http://$(hostname -I | awk '{print $1}'):${PORT}/"
echo "    Health:    http://$(hostname -I | awk '{print $1}'):${PORT}/health"
echo "    API Key:   ${API_KEY}"
echo ""
echo "OpenCode 插件 / Cursor Hook 共用配置（~/.config/agent-tracker/env）："
echo "    endpoint=\"http://<服务地址>:${PORT}\""
echo "    apiKey=\"${API_KEY}\""
echo ""
echo "Cursor Hook 初始化（本机执行一次）："
echo "    npx @runmark/cursor-hooks init"
echo "    # 然后重启 Cursor IDE"
echo ""
echo "Cursor 账单对账（Dashboard 可选）："
echo "    登录 Dashboard → 顶栏「Cursor 账单」→ 粘贴 WorkosCursorSessionToken"
