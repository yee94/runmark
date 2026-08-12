#!/usr/bin/env bash
# Runmark — Claude Code / CodeBuddy / WorkBuddy Plugin 安装脚本
#
# 通过官方 plugin marketplace 一键安装 / 升级 / 卸载。
# npx：npx @runmarks/claude-compat-plugin [--runtime all|claude|codebuddy|workbuddy]
#
# 用法：
#   cd packages/plugin-claude-compat && bash install.sh
#   bash install.sh --runtime codebuddy
#   bash install.sh --runtime all
#   bash install.sh --uninstall --runtime codebuddy
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="0.2.19"
RUNTIME_ARG="all"
DO_UNINSTALL=0
# 归属：plugin@marketplace → runmark-tracker@runmark
# 旧版 runmark@tracker / runmark@runmark / agent-tracker 安装时会顺带卸掉
MARKETPLACE_NAME="runmark"
PLUGIN_NAME="runmark-tracker"
PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}"
LEGACY_MARKETPLACE_NAME="agent-tracker"
LEGACY_PLUGIN_NAME="agent-tracker"
MARKETPLACE_DIR="${AGENT_TRACKER_CLAUDE_COMPAT_MARKETPLACE_DIR:-$HOME/.config/agent-tracker/claude-compat-marketplace}"

# 解析 hook 运行时绝对路径（bun → ~/.bun/bin/bun → node → nvm/fnm/volta/asdf）
# 安装期烘焙进启动器，避免宿主 GUI 启动时 PATH 不含登录 shell 的 node。
resolve_hook_runtime() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    echo "${HOME}/.bun/bin/bun"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate=""
  if [ -d "${HOME}/.nvm/versions/node" ]; then
    candidate="$(ls -1d "${HOME}/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  fi
  if [ -d "${HOME}/.local/share/fnm/node-versions" ]; then
    candidate="$(ls -1d "${HOME}/.local/share/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  fi
  if [ -x "${HOME}/.volta/bin/node" ]; then
    echo "${HOME}/.volta/bin/node"
    return 0
  fi
  if [ -x "${HOME}/.asdf/shims/node" ]; then
    echo "${HOME}/.asdf/shims/node"
    return 0
  fi
  return 1
}

write_hook_launcher() {
  local out="$1"
  local baked="$2"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
# 前台只入队并拉起真正 detached 的单飞 worker，然后立刻 exit。
# 宿主若等的是 hook 进程 exit，不能在本进程里 sleep / Debounce；也不能只靠 print {}。
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# CodeBuddy 优先展开 CODEBUDDY_PLUGIN_ROOT；Claude / TClaude 用 CLAUDE_PLUGIN_ROOT。
# hooks.json 使用 ${CLAUDE_PLUGIN_ROOT}（三端兼容）。
HEADER
    printf 'BAKED_RUNTIME=%q\n' "$baked"
    cat <<'BODY'

resolve_runtime() {
  if [ -n "${BAKED_RUNTIME}" ] && [ -x "${BAKED_RUNTIME}" ]; then
    echo "${BAKED_RUNTIME}"
    return 0
  fi
  command -v bun >/dev/null 2>&1 && { command -v bun; return 0; }
  [ -x "${HOME}/.bun/bin/bun" ] && { echo "${HOME}/.bun/bin/bun"; return 0; }
  command -v node >/dev/null 2>&1 && { command -v node; return 0; }
  local candidate=""
  if [ -d "${HOME}/.nvm/versions/node" ]; then
    candidate="$(ls -1d "${HOME}/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  fi
  if [ -d "${HOME}/.local/share/fnm/node-versions" ]; then
    candidate="$(ls -1d "${HOME}/.local/share/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  fi
  [ -x "${HOME}/.volta/bin/node" ] && { echo "${HOME}/.volta/bin/node"; return 0; }
  [ -x "${HOME}/.asdf/shims/node" ] && { echo "${HOME}/.asdf/shims/node"; return 0; }
  return 1
}

if RUNTIME="$(resolve_runtime)"; then
  # bun / node 均可直接执行 .mjs；无需 `bun run` 分支
  exec "$RUNTIME" "$SCRIPT_DIR/index.mjs" "$@"
fi

# fail-open 保留，但必须留痕，避免「装了却静默不上报」
LOG="${AGENT_TRACKER_LOG_FILE:-${HOME}/.config/agent-tracker/plugin.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
printf '{"ts":"%s","level":"error","component":"tracker-hook","message":"no bun/node runtime; telemetry disabled"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG" 2>/dev/null || true
printf '%s\n' '{}'
exit 0
BODY
  } > "$out"
  chmod +x "$out"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)
      RUNTIME_ARG="${2:-all}"
      shift 2
      ;;
    --runtime=*)
      RUNTIME_ARG="${1#*=}"
      shift
      ;;
    --uninstall)
      DO_UNINSTALL=1
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: bash install.sh [--runtime all|claude|codebuddy|workbuddy] [--uninstall]

  --runtime   目标产品，默认 all（本机有 CLI 的都会装）
  --uninstall 卸载 plugin + 移除 marketplace 注册
EOF
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

echo "============================================"
echo " Runmark — Claude / CodeBuddy / WorkBuddy Plugin"
echo " version: $VERSION"
echo "============================================"
echo ""

runtimes=()
case "$RUNTIME_ARG" in
  all)
    runtimes=(claude codebuddy workbuddy)
    ;;
  claude|codebuddy|workbuddy)
    runtimes=("$RUNTIME_ARG")
    ;;
  *)
    echo "ERROR: --runtime 必须是 all|claude|codebuddy|workbuddy" >&2
    exit 1
    ;;
esac

# WorkBuddy Desktop 内嵌 CLI（二进制名仍是 codebuddy，靠 product.json + CONFIG_DIR 切到 ~/.workbuddy）
WORKBUDDY_APP_CLI="${WORKBUDDY_APP_CLI:-/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy}"
WORKBUDDY_PRODUCT_JSON="${WORKBUDDY_PRODUCT_JSON:-/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json}"

# 打印可执行的 CLI 调用前缀（stdout 一行）；失败返回非零
resolve_cli() {
  local runtime="$1"
  case "$runtime" in
    codebuddy)
      if command -v codebuddy >/dev/null 2>&1; then
        echo "codebuddy"
        return 0
      fi
      ;;
    workbuddy)
      if command -v workbuddy >/dev/null 2>&1; then
        echo "workbuddy"
        return 0
      fi
      # Desktop App 内嵌 CLI：必须同时注入 product.json 与 CONFIG_DIR，否则会写到 ~/.codebuddy
      if [ -x "$WORKBUDDY_APP_CLI" ] && [ -f "$WORKBUDDY_PRODUCT_JSON" ]; then
        echo "env ACC_PRODUCT_CONFIG_PATH=$WORKBUDDY_PRODUCT_JSON CODEBUDDY_CONFIG_DIR=$HOME/.workbuddy $WORKBUDDY_APP_CLI"
        return 0
      fi
      ;;
    claude)
      # 本机已装 tclaude 时优先 tclaude；否则用上游 claude
      if command -v tclaude >/dev/null 2>&1; then
        echo "tclaude"
        return 0
      fi
      if command -v claude >/dev/null 2>&1; then
        echo "claude"
        return 0
      fi
      ;;
  esac
  return 1
}

# 执行 resolve_cli 返回的命令行（可能含 env 前缀）
run_cli() {
  # shellcheck disable=SC2086
  eval "$@"
}

# settings.json 路径（用于安装后校验 enabledPlugins）
settings_path_for() {
  case "$1" in
    claude)
      # tclaude 写 ~/.tclaude；上游 claude 写 ~/.claude
      if command -v tclaude >/dev/null 2>&1; then
        echo "$HOME/.tclaude/settings.json"
      else
        echo "$HOME/.claude/settings.json"
      fi
      ;;
    codebuddy) echo "$HOME/.codebuddy/settings.json" ;;
    workbuddy) echo "$HOME/.workbuddy/settings.json" ;;
  esac
}

# 确认 enabledPlugins 已合并进 runmark（不覆盖其它插件；顺带清掉旧 agent-tracker 开关）
ensure_enabled_plugin() {
  local runtime="$1"
  local settings_path
  settings_path="$(settings_path_for "$runtime")"
  [ -f "$settings_path" ] || return 0
  python3 - "$settings_path" "$PLUGIN_REF" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
ref = sys.argv[2]
try:
    data = json.loads(path.read_text() or "{}")
except Exception:
    raise SystemExit(0)
if not isinstance(data, dict):
    raise SystemExit(0)

enabled = data.get("enabledPlugins")
if not isinstance(enabled, dict):
    enabled = {}
    data["enabledPlugins"] = enabled

changed = False
# 清掉旧品牌 / 旧归属开关
for legacy in (
    "agent-tracker@agent-tracker",
    "agent-tracker",
    "runmark@runmark",
    "runmark@tracker",
):
    if legacy in enabled:
        enabled.pop(legacy, None)
        changed = True

if enabled.get(ref) is not True:
    enabled[ref] = True
    changed = True

if not changed:
    print(f"  ok enabledPlugins[{ref}]=true → {path}")
    raise SystemExit(0)

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print(f"  merged enabledPlugins[{ref}]=true → {path}")
PY
}

# 卸掉旧品牌 / 旧归属（若存在）
uninstall_legacy() {
  local cli="$1"
  # agent-tracker@agent-tracker
  run_cli "$cli" plugin uninstall "$LEGACY_PLUGIN_NAME" >/dev/null 2>&1 || \
    run_cli "$cli" plugin uninstall "${LEGACY_PLUGIN_NAME}@${LEGACY_MARKETPLACE_NAME}" >/dev/null 2>&1 || true
  run_cli "$cli" plugin marketplace remove "$LEGACY_MARKETPLACE_NAME" >/dev/null 2>&1 || true
  # runmark@runmark / runmark@tracker（旧 plugin 名 runmark）
  run_cli "$cli" plugin uninstall "runmark@runmark" >/dev/null 2>&1 || true
  run_cli "$cli" plugin uninstall "runmark@tracker" >/dev/null 2>&1 || true
  run_cli "$cli" plugin uninstall "runmark" >/dev/null 2>&1 || true
  run_cli "$cli" plugin marketplace remove "tracker" >/dev/null 2>&1 || true
}

uninstall_runtime() {
  local runtime="$1"
  local cli
  if ! cli="$(resolve_cli "$runtime")"; then
    echo "  ⚠️  未找到 $runtime CLI，跳过卸载"
    return 0
  fi
  echo "  [$runtime] plugin uninstall $PLUGIN_REF ..."
  run_cli "$cli" plugin uninstall "$PLUGIN_NAME" >/dev/null 2>&1 || \
    run_cli "$cli" plugin uninstall "$PLUGIN_REF" >/dev/null 2>&1 || true
  run_cli "$cli" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  uninstall_legacy "$cli"
}

# 幂等安装：先卸旧版再装新版，marketplace 指向最新本地目录
install_runtime() {
  local runtime="$1"
  local cli
  if ! cli="$(resolve_cli "$runtime")"; then
    echo "  ⚠️  未找到 $runtime CLI，跳过安装（marketplace 已准备好，可稍后手动安装）"
    return 0
  fi

  # 从旧品牌 agent-tracker 迁移到 runmark
  uninstall_legacy "$cli"

  echo "  [$runtime] 注册 marketplace → $MARKETPLACE_DIR"
  # 升级时先 remove 再 add，避免旧 path / 缓存残留
  run_cli "$cli" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  if ! run_cli "$cli" plugin marketplace add "$MARKETPLACE_DIR" -n "$MARKETPLACE_NAME" 2>/dev/null; then
    run_cli "$cli" plugin marketplace add "$MARKETPLACE_DIR"
  fi

  echo "  [$runtime] 安装 / 升级插件 $PLUGIN_REF ..."
  # 已装过则先卸，保证 hooks/dist 切到新 marketplace 内容
  run_cli "$cli" plugin uninstall "$PLUGIN_NAME" >/dev/null 2>&1 || \
    run_cli "$cli" plugin uninstall "$PLUGIN_REF" >/dev/null 2>&1 || true
  if ! run_cli "$cli" plugin install "$PLUGIN_REF" -s user; then
    echo "  ⚠️  plugin install 返回非零，尝试 enable ..."
  fi
  # 部分 CLI 装完可能是 disabled；再 enable 一次
  run_cli "$cli" plugin enable "$PLUGIN_REF" >/dev/null 2>&1 || \
    run_cli "$cli" plugin enable "$PLUGIN_NAME" >/dev/null 2>&1 || true

  ensure_enabled_plugin "$runtime"
}

if [ "$DO_UNINSTALL" = "1" ]; then
  echo "[uninstall] 卸载 plugin + 移除 marketplace ..."
  for runtime in "${runtimes[@]}"; do
    uninstall_runtime "$runtime"
  done
  echo ""
  echo "完成。如需删除本地 marketplace 目录："
  echo "  rm -rf \"$MARKETPLACE_DIR\""
  exit 0
fi

# 1. 构建
echo "[1/3] 准备 dist/index.mjs ..."
if [ -f "$SCRIPT_DIR/src/index.ts" ]; then
  cd "$SCRIPT_DIR"
  bun run build
elif [ ! -f "$SCRIPT_DIR/dist/index.mjs" ]; then
  echo "ERROR: dist/index.mjs 不存在，请重新安装 npm 包或在源码仓库执行 bun run build"
  exit 1
else
  echo "  使用 npm 包内置 dist/index.mjs"
fi

# 2. 准备 marketplace 工作目录（整目录替换，保证 npx 升级拿到新 hooks/dist）
echo "[2/3] 准备 marketplace → $MARKETPLACE_DIR ..."
SOURCE_MARKETPLACE_DIR="$SCRIPT_DIR/marketplace"
rm -rf "$MARKETPLACE_DIR"
mkdir -p "$(dirname "$MARKETPLACE_DIR")"
cp -R "$SOURCE_MARKETPLACE_DIR" "$MARKETPLACE_DIR"
PLUGIN_DIR="$MARKETPLACE_DIR/plugins/$PLUGIN_NAME"

mkdir -p "$PLUGIN_DIR/dist" "$PLUGIN_DIR/hooks"
cp "$SCRIPT_DIR/dist/index.mjs" "$PLUGIN_DIR/dist/index.mjs"
# hooks.json 已在 marketplace 源码中；确保存在
if [ ! -f "$PLUGIN_DIR/hooks/hooks.json" ] && [ -f "$SOURCE_MARKETPLACE_DIR/plugins/$PLUGIN_NAME/hooks/hooks.json" ]; then
  cp "$SOURCE_MARKETPLACE_DIR/plugins/$PLUGIN_NAME/hooks/hooks.json" "$PLUGIN_DIR/hooks/hooks.json"
fi

BAKED_RUNTIME=""
if ! BAKED_RUNTIME="$(resolve_hook_runtime)"; then
  echo "ERROR: 未检测到 bun 或 node，插件装上后无法上报任何数据。" >&2
  echo "       请先安装其一再重试：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
echo "  hook runtime: $BAKED_RUNTIME"
write_hook_launcher "$PLUGIN_DIR/dist/claude-compat-tracker-hook" "$BAKED_RUNTIME"

# 同步兼容 manifest（CodeBuddy / WorkBuddy 优先读自家目录）
for manifest_dir in .claude-plugin .codebuddy-plugin .workbuddy-plugin; do
  mkdir -p "$PLUGIN_DIR/$manifest_dir"
  if [ -f "$SOURCE_MARKETPLACE_DIR/plugins/$PLUGIN_NAME/$manifest_dir/plugin.json" ]; then
    cp "$SOURCE_MARKETPLACE_DIR/plugins/$PLUGIN_NAME/$manifest_dir/plugin.json" \
      "$PLUGIN_DIR/$manifest_dir/plugin.json"
  fi
done
# marketplace 根 manifest：同时放 .claude-plugin / .codebuddy-plugin / .workbuddy-plugin
mkdir -p "$MARKETPLACE_DIR/.claude-plugin" "$MARKETPLACE_DIR/.codebuddy-plugin" "$MARKETPLACE_DIR/.workbuddy-plugin"
cp "$SOURCE_MARKETPLACE_DIR/.claude-plugin/marketplace.json" "$MARKETPLACE_DIR/.claude-plugin/marketplace.json"
cp "$SOURCE_MARKETPLACE_DIR/.claude-plugin/marketplace.json" "$MARKETPLACE_DIR/.codebuddy-plugin/marketplace.json"
cp "$SOURCE_MARKETPLACE_DIR/.claude-plugin/marketplace.json" "$MARKETPLACE_DIR/.workbuddy-plugin/marketplace.json"

# 3. 按 runtime 注册 marketplace 并安装（幂等，可重复 npx）
echo "[3/3] 注册 marketplace 并安装插件 ..."
installed=()
skipped=()
for runtime in "${runtimes[@]}"; do
  if resolve_cli "$runtime" >/dev/null 2>&1; then
    install_runtime "$runtime"
    installed+=("$runtime")
  else
    echo "  ⚠️  跳过 $runtime（未找到 CLI）"
    skipped+=("$runtime")
  fi
done

HOOK_SCRIPT="$PLUGIN_DIR/dist/claude-compat-tracker-hook"
echo ""
echo "============================================"
echo " 安装完成!"
echo "============================================"
echo ""
echo "Marketplace: $MARKETPLACE_DIR"
echo "Hook 脚本:   $HOOK_SCRIPT"
if [ "${#installed[@]}" -gt 0 ]; then
  echo "已安装: ${installed[*]}"
else
  echo "已安装: （无）"
fi
if [ "${#skipped[@]}" -gt 0 ]; then
  echo "已跳过: ${skipped[*]}"
fi
echo ""
echo "卸载："
echo "  npx @runmarks/claude-compat-plugin --uninstall --runtime codebuddy"
echo "  # 或：codebuddy plugin uninstall runmark-tracker"
echo ""
echo "下一步："
echo "  1. 确认 Server: curl localhost:3456/health"
echo "  2. 配置 ~/.config/agent-tracker/env（与其它客户端共用）"
echo "  3. 重启对应客户端（或 /reload-plugins）"
echo "  4. 如有提示，在客户端信任 plugin hooks"
echo ""
echo "验证："
echo "  echo '{\"session_id\":\"test\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":\"$HOME/.codebuddy\"}' \\"
echo "    | $HOOK_SCRIPT session-start"
echo ""
