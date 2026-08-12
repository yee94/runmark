#!/usr/bin/env bash
set -eo pipefail

# =============================================================================
# Runmark Bootstrap Script
# Clone 后执行 ./setup.sh 即可完成所有初始化
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 颜色定义 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

step()   { echo -e "\n${BLUE}==>${NC} ${BOLD}$1${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }
err()    { echo -e "  ${RED}✗${NC} $1"; }

# ── 运行模式检测 ──────────────────────────────────────────────────────────────
# 如果传入参数 --server，认为是远程服务器模式：
#   远程模式只做：依赖安装 + SQLite 初始化 + .env 生成 + systemd 注册
#   本地模式做：上述 + 插件构建 + 客户端配置 + OpenCode 注册 + 健康检查

SERVER_MODE=false
if [[ "${1:-}" == "--server" ]]; then
  SERVER_MODE=true
fi

# =============================================================================
# 1. 前置检查
# =============================================================================
step "1/8 前置检查"

# 检查 git
if command -v git &>/dev/null; then
  ok "git 已安装: $(git --version)"
else
  err "git 未安装，请先安装 git"
  exit 1
fi

# 检查 bun
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version)"
  ok "bun 已安装: v${BUN_VERSION}"

  # 版本检查 >= 1.1.0
  BUN_MAJOR="$(echo "$BUN_VERSION" | cut -d. -f1)"
  BUN_MINOR="$(echo "$BUN_VERSION" | cut -d. -f2)"
  if [ "$BUN_MAJOR" -lt 1 ] || { [ "$BUN_MAJOR" -eq 1 ] && [ "$BUN_MINOR" -lt 1 ]; }; then
    err "bun 版本过低 (v${BUN_VERSION})，需要 >= 1.1.0"
    echo -e "  请运行: ${CYAN}curl -fsSL https://bun.sh/install | bash${NC}"
    exit 1
  fi
else
  err "bun 未安装"
  echo -e "  请运行: ${CYAN}curl -fsSL https://bun.sh/install | bash${NC}"
  exit 1
fi

# =============================================================================
# 2. 安装依赖
# =============================================================================
step "2/8 安装依赖"

bun install
ok "bun install 完成"

# =============================================================================
# 3. 初始化 / 迁移 SQLite 数据库
# =============================================================================
step "3/8 初始化 / 迁移 SQLite 数据库"

DATA_DIR="${SCRIPT_DIR}/packages/server/data"
DB_PATH="${DATA_DIR}/agent-tracker.db"

mkdir -p "$DATA_DIR"

(cd "$SCRIPT_DIR" && AGENT_TRACKER_DB_PATH="$DB_PATH" bun -e "
  import { loadConfig } from './packages/server/src/config';
  import { getDatabase } from './packages/server/src/db';
  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  db.close();
  console.log(cfg.dbPath);
")
ok "数据库初始化 / 增量迁移完成: ${DB_PATH}"

# =============================================================================
# 4. 生成服务端环境变量
# =============================================================================
step "4/8 生成服务端环境变量"

SERVER_ENV="${SCRIPT_DIR}/packages/server/.env"

if [ -f "$SERVER_ENV" ]; then
  ok ".env 已存在，跳过生成: ${SERVER_ENV}"
  # 读取现有 API Key
  GENERATED_API_KEY="$(grep '^AGENT_TRACKER_API_KEY=' "$SERVER_ENV" | cut -d= -f2-)"
  GENERATED_CRYPTO_KEY="$(grep '^AGENT_TRACKER_CURSOR_CRYPTO_KEY=' "$SERVER_ENV" | cut -d= -f2-)"
else
  GENERATED_API_KEY="$(openssl rand -hex 24)"
  GENERATED_CRYPTO_KEY="$(openssl rand -hex 32)"

  cat > "$SERVER_ENV" <<EOF
# Runmark 本地开发配置
# 由 setup.sh 自动生成

AGENT_TRACKER_PORT=3456
AGENT_TRACKER_API_KEY=${GENERATED_API_KEY}
AGENT_TRACKER_DB_PATH=data/agent-tracker.db
AGENT_TRACKER_PUBLIC_DIR=./public
AGENT_TRACKER_PUBLIC_DASHBOARD=true
AGENT_TRACKER_LOG_FILE=data/agent-tracker.log

# Cursor Usage API 对账
AGENT_TRACKER_CURSOR_SYNC_ENABLED=true
AGENT_TRACKER_CURSOR_CRYPTO_KEY=${GENERATED_CRYPTO_KEY}
EOF

  ok ".env 已生成: ${SERVER_ENV}"
fi

echo -e "  ${YELLOW}API Key: ${GENERATED_API_KEY}${NC}"

# =============================================================================
# 5. 构建插件（仅本地模式）
# =============================================================================
if [ "$SERVER_MODE" = false ]; then
step "5/8 构建插件"

(cd "${SCRIPT_DIR}/packages/plugin-opencode" && bun run build)

PLUGIN_DIST="${SCRIPT_DIR}/packages/plugin-opencode/dist/index.mjs"
if [ -f "$PLUGIN_DIST" ]; then
  ok "插件构建成功: ${PLUGIN_DIST}"
else
  err "插件构建失败，未找到 ${PLUGIN_DIST}"
  exit 1
fi
fi

# =============================================================================
# 6. 配置客户端 (~/.config/agent-tracker/env)（仅本地模式）
# =============================================================================
if [ "$SERVER_MODE" = false ]; then
step "6/8 配置客户端"

CLIENT_CONFIG_DIR="${HOME}/.config/agent-tracker"
CLIENT_CONFIG="${CLIENT_CONFIG_DIR}/env"

mkdir -p "$CLIENT_CONFIG_DIR"

if [ -f "$CLIENT_CONFIG" ]; then
  ok "客户端配置已存在: ${CLIENT_CONFIG}"
  warn "请确认 endpoint 和 apiKey 是否与服务器一致"
  echo -e "  当前内容:"
  echo -e "  ${CYAN}$(cat "$CLIENT_CONFIG")${NC}"
else
  cat > "$CLIENT_CONFIG" <<EOF
endpoint="http://localhost:3456"
apiKey="${GENERATED_API_KEY}"
EOF

  ok "客户端配置已生成: ${CLIENT_CONFIG}"
fi
fi

# =============================================================================
# 7. 配置 OpenCode 插件注册（仅本地模式）
# =============================================================================
if [ "$SERVER_MODE" = false ]; then
step "7/8 配置 OpenCode 插件注册"

OPENCODE_CONFIG="${HOME}/.config/opencode/opencode.jsonc"
PLUGIN_NAME="@runmark/opencode-plugin"
PLUGIN_REGISTERED=false

# 必须 patch，禁止整文件覆写 / mv 替换（会拆掉 Mackup symlink、丢掉其它 plugin）
PATCH_OPENCODE_PY="${SCRIPT_DIR}/packages/runmark/lib/patch_opencode_config.py"
if [ -f "$PATCH_OPENCODE_PY" ]; then
  PATCH_MSG="$(python3 "$PATCH_OPENCODE_PY" "$OPENCODE_CONFIG" "$PLUGIN_NAME" 2>&1 || true)"
  echo -e "  ${CYAN}${PATCH_MSG}${NC}"
  if grep -q "$PLUGIN_NAME" "$OPENCODE_CONFIG" 2>/dev/null; then
    ok "OpenCode 插件已 patch 注册"
    PLUGIN_REGISTERED=true
  else
    warn "无法自动注册，请手动添加"
    echo -e "  在 ${CYAN}${OPENCODE_CONFIG}${NC} 的 plugin 数组中添加:"
    echo -e "  ${YELLOW}\"${PLUGIN_NAME}\"${NC}"
  fi
elif [ -f "$OPENCODE_CONFIG" ] && grep -q "$PLUGIN_NAME" "$OPENCODE_CONFIG"; then
  ok "OpenCode 插件已注册"
  PLUGIN_REGISTERED=true
else
  warn "缺少 patch 脚本且无法自动注册: ${PATCH_OPENCODE_PY}"
  echo -e "  请在 ${CYAN}${OPENCODE_CONFIG}${NC} 的 plugin 数组中手动添加:"
  echo -e "  ${YELLOW}\"${PLUGIN_NAME}\"${NC}"
fi
fi

# =============================================================================
# 8. 启动服务验证
# =============================================================================
step "8/8 启动服务验证"

if [ "$SERVER_MODE" = true ]; then
  # ── 远程服务器模式：注册 systemd 服务 ──
  SERVICE_FILE="/etc/systemd/system/agent-tracker.service"

  if [ -f "$SERVICE_FILE" ]; then
    ok "systemd 服务已注册"
  else
    # 获取 bun 路径
    BUN_BIN="$(which bun)"

    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Runmark telemetry server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${SCRIPT_DIR}/packages/server
EnvironmentFile=${SCRIPT_DIR}/packages/server/.env
ExecStart=${BUN_BIN} src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    ok "systemd 服务已创建"
  fi

  systemctl daemon-reload
  systemctl enable agent-tracker
  systemctl restart agent-tracker

  sleep 2

  # 尝试健康检查
  HEALTH_URL="http://localhost:3456/health"
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    ok "服务健康检查通过: ${HEALTH_URL}"
  else
    warn "服务健康检查未通过"
    echo -e "  查看日志: ${CYAN}journalctl -u agent-tracker -f${NC}"
  fi
else
  # ── 本地开发模式：后台启动验证 ──
  HEALTH_OK=false

  # 后台启动服务
  (cd "${SCRIPT_DIR}/packages/server" && bun dev &)
  SERVER_PID=$!
  sleep 3

  # 尝试健康检查
  for i in 1 2 3; do
    if curl -sf http://localhost:3456/health >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    sleep 1
  done

  # 关闭后台服务
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [ "$HEALTH_OK" = true ]; then
    ok "服务健康检查通过: http://localhost:3456/health"
  else
    warn "服务健康检查未通过（服务可能需要更多启动时间）"
    echo -e "  稍后可手动测试: ${CYAN}curl http://localhost:3456/health${NC}"
  fi
fi

# =============================================================================
# 9. 输出总结
# =============================================================================
echo ""

if [ "$SERVER_MODE" = true ]; then
  DASHBOARD_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>')"
  DASHBOARD_URL="http://${DASHBOARD_HOST}:3456/"
  HELP_URL="http://${DASHBOARD_HOST}:3456/#/help"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${GREEN}  🎉 Runmark 服务端部署完成！${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${CYAN}Dashboard:${NC}   ${DASHBOARD_URL}"
  echo -e "  ${CYAN}帮助中心:${NC}   ${HELP_URL}"
  echo -e "  ${CYAN}API Key:${NC}     ${YELLOW}${GENERATED_API_KEY}${NC}"
  echo -e "               （同时是 Dashboard 登录密码）"
  echo ""
  echo -e "${BOLD}  下一步:${NC}"
  echo ""
  echo -e "  1. 浏览器打开 Dashboard，用上面的 API Key 登录"
  echo -e "  2. 进入 ${CYAN}帮助中心${NC}（${HELP_URL}）"
  echo -e "  3. 按「统一接入配置」完成 Cursor / OpenCode / Codex 客户端接入"
  echo ""
  echo -e "  ${YELLOW}客户端配置与插件安装请以帮助中心为准，不必在本机手写长流程。${NC}"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${GREEN}  🎉 Runmark 初始化完成！${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${CYAN}Dashboard:${NC}   http://localhost:3456/"
  echo -e "  ${CYAN}帮助中心:${NC}   http://localhost:3456/#/help"
  echo -e "  ${CYAN}API Key:${NC}     ${YELLOW}${GENERATED_API_KEY}${NC}"
  echo -e "  ${CYAN}客户端配置:${NC}   ${CLIENT_CONFIG}"
  echo -e "  ${CYAN}插件注册:${NC}     $([ "$PLUGIN_REGISTERED" = true ] && echo "${GREEN}已注册 ✓${NC}" || echo "${YELLOW}未注册 ⚠ 请打开帮助中心完成${NC}")"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  下一步:${NC}"
  echo ""
  echo -e "  1. 启动服务:  ${CYAN}cd packages/server && bun dev${NC}"
  echo -e "  2. 打开 Dashboard: ${CYAN}http://localhost:3456/${NC}"
  echo -e "  3. 进入帮助中心完成客户端接入: ${CYAN}http://localhost:3456/#/help${NC}"
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi
