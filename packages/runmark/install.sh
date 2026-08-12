#!/usr/bin/env bash
# @runmarks/runmark — 统一客户端安装入口（品牌 npm 包）
#
# 一键安装 / 更新 / 卸载本机 Agent 客户端插件：
#   Cursor / OpenCode / Codex / Claude Code / CodeBuddy / WorkBuddy / Grok Build
#
# 用法：
#   npx @runmarks/runmark                         # 探测 + 交互勾选（已装优先预选 → 更新）
#   npx @runmarks/runmark --clients installed     # 只更新已装 Runmark 的客户端
#   npx @runmarks/runmark --clients detected      # 只装本机已发现的宿主
#   npx @runmarks/runmark --clients all
#   npx @runmarks/runmark --clients cursor,codex,workbuddy,grok
#   npx @runmarks/runmark --clients cursor --uninstall
#   bash packages/runmark/install.sh
#
set -euo pipefail

VERSION="0.1.8"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_OPENCODE_PY="${SCRIPT_DIR}/lib/patch_opencode_config.py"
REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/npm/}"
export NPM_CONFIG_REGISTRY="$REGISTRY"

CLIENTS_ARG=""
DO_UNINSTALL=0
DO_HELP=0
DO_YES=0
# 可选：钉死各子包版本；默认各自 latest
CURSOR_VER="latest"
OPENCODE_VER="latest"
CODEX_VER="latest"
CLAUDE_COMPAT_VER="latest"
GROK_VER="latest"

ALL_CLIENTS=(cursor opencode codex claude codebuddy workbuddy grok)
WORKBUDDY_APP_CLI="${WORKBUDDY_APP_CLI:-/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy}"

usage() {
  cat <<EOF
Runmark 客户端统一安装入口  v${VERSION}

Usage:
  npx @runmarks/runmark [options]
  npx @runmarks/runmark --clients <list> [options]
  bash install.sh [--clients <list>] [options]

默认（无 --clients 且在终端里）：
  探测本机宿主 + 是否已装 Runmark → 交互勾选
  （有已装则默认勾选已装并走更新；否则勾选已发现的宿主）

非交互环境请显式传 --clients，或 --yes。

Options:
  --clients <list>   逗号分隔 / all / installed / detected。可选：
                       cursor, opencode, codex, claude, codebuddy, workbuddy, grok
  --yes, -y          无交互：优先更新已装；若无已装则装探测到的宿主
  --uninstall        卸载所选客户端（OpenCode 会 patch 移除 plugin 条目）
  --cursor-version <v>         默认 latest
  --opencode-version <v>       默认 latest
  --codex-version <v>          默认 latest
  --claude-compat-version <v>  默认 latest（Claude/CodeBuddy/WorkBuddy 共用）
  --grok-version <v>           默认 latest
  -h, --help         显示帮助

Examples:
  # 交互安装 / 更新（推荐；已装用户再次运行会预选已装项）
  npx @runmarks/runmark

  # 只更新已装 Runmark 的客户端
  npx @runmarks/runmark --clients installed
  npx @runmarks/runmark --yes

  # 只装本机已发现的宿主
  npx @runmarks/runmark --clients detected

  # 一键装齐 / 按需
  npx @runmarks/runmark --clients all
  npx @runmarks/runmark --clients cursor,codex,workbuddy

  # 卸载 CodeBuddy
  npx @runmarks/runmark --clients codebuddy --uninstall

安装前请配置 ~/.config/agent-tracker/env（AGENT_TRACKER_ENDPOINT / API_KEY）。
装完后重启对应客户端（Claude 系可用 /reload-plugins）。
EOF
}

# 探测本机是否像装了某客户端（CLI / 配置目录 / macOS App）
client_detected() {
  local c="$1"
  case "$c" in
    cursor)
      [ -d "$HOME/.cursor" ] && return 0
      [ -d "/Applications/Cursor.app" ] && return 0
      command -v cursor >/dev/null 2>&1 && return 0
      return 1
      ;;
    opencode)
      command -v opencode >/dev/null 2>&1 && return 0
      [ -d "$HOME/.config/opencode" ] && return 0
      return 1
      ;;
    codex)
      command -v codex >/dev/null 2>&1 && return 0
      [ -d "$HOME/.codex" ] && return 0
      return 1
      ;;
    claude)
      command -v tclaude >/dev/null 2>&1 && return 0
      command -v claude >/dev/null 2>&1 && return 0
      [ -d "$HOME/.tclaude" ] && return 0
      [ -d "$HOME/.claude" ] && return 0
      return 1
      ;;
    codebuddy)
      command -v codebuddy >/dev/null 2>&1 && return 0
      [ -d "$HOME/.codebuddy" ] && return 0
      return 1
      ;;
    workbuddy)
      command -v workbuddy >/dev/null 2>&1 && return 0
      [ -d "$HOME/.workbuddy" ] && return 0
      [ -d "/Applications/WorkBuddy.app" ] && return 0
      [ -x "$WORKBUDDY_APP_CLI" ] && return 0
      return 1
      ;;
    grok)
      command -v grok >/dev/null 2>&1 && return 0
      [ -d "$HOME/.grok" ] && return 0
      [ -x "$HOME/.local/bin/grok" ] && return 0
      [ -x "$HOME/.grok/bin/grok" ] && return 0
      return 1
      ;;
  esac
  return 1
}

# 探测该客户端是否已接入 Runmark（再次运行时优先预选并走更新）
client_installed() {
  local c="$1"
  case "$c" in
    cursor)
      [ -f "$HOME/.cursor/hooks/agent-tracker/hook.mjs" ] && return 0
      [ -f "$HOME/.cursor/hooks/agent-tracker/run.sh" ] && return 0
      if [ -f "$HOME/.cursor/hooks.json" ] && grep -q 'agent-tracker' "$HOME/.cursor/hooks.json" 2>/dev/null; then
        return 0
      fi
      return 1
      ;;
    opencode)
      if [ -f "$HOME/.config/opencode/opencode.jsonc" ] \
        && grep -q 'agent-tracker-opencode-plugin' "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null; then
        return 0
      fi
      [ -d "$HOME/.config/opencode/node_modules/@runmarks/agent-tracker-opencode-plugin" ] && return 0
      return 1
      ;;
    codex)
      [ -d "$HOME/.codex/agent-tracker-marketplace/plugins/agent-tracker" ] && return 0
      # macOS bash 3.2 无 mapfile；用 ls 探测 cache 目录
ls -d "$HOME"/.codex/plugins/cache/agent-tracker/agent-tracker/*/ >/dev/null 2>&1 && return 0
      return 1
      ;;
    claude)
      python3 - <<'PY' 2>/dev/null && return 0
import json
from pathlib import Path
keys = ("runmark-tracker@runmark", "runmark@runmark", "runmark@tracker", "agent-tracker@agent-tracker")
for name in (".tclaude", ".claude"):
    p = Path.home() / name / "settings.json"
    if not p.exists():
        continue
    try:
        ep = (json.loads(p.read_text()) or {}).get("enabledPlugins") or {}
    except Exception:
        continue
    if any(ep.get(k) is True for k in keys):
        raise SystemExit(0)
raise SystemExit(1)
PY
      return 1
      ;;
    codebuddy)
      python3 - <<'PY' 2>/dev/null && return 0
import json
from pathlib import Path
keys = ("runmark-tracker@runmark", "runmark@runmark", "runmark@tracker", "agent-tracker@agent-tracker")
p = Path.home() / ".codebuddy" / "settings.json"
if not p.exists():
    raise SystemExit(1)
try:
    ep = (json.loads(p.read_text()) or {}).get("enabledPlugins") or {}
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if any(ep.get(k) is True for k in keys) else 1)
PY
      return 1
      ;;
    workbuddy)
      python3 - <<'PY' 2>/dev/null && return 0
import json
from pathlib import Path
keys = ("runmark-tracker@runmark", "runmark@runmark", "runmark@tracker", "agent-tracker@agent-tracker")
p = Path.home() / ".workbuddy" / "settings.json"
if not p.exists():
    raise SystemExit(1)
try:
    ep = (json.loads(p.read_text()) or {}).get("enabledPlugins") or {}
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if any(ep.get(k) is True for k in keys) else 1)
PY
      return 1
      ;;
    grok)
      [ -f "$HOME/.grok/hooks/runmark-tracker.json" ] && return 0
      [ -f "$HOME/.config/agent-tracker/grok-plugin/grok-tracker-hook" ] && return 0
      return 1
      ;;
  esac
  return 1
}

client_label() {
  case "$1" in
    cursor) echo "Cursor" ;;
    opencode) echo "OpenCode" ;;
    codex) echo "Codex" ;;
    claude) echo "Claude Code / TClaude" ;;
    codebuddy) echo "CodeBuddy" ;;
    workbuddy) echo "WorkBuddy" ;;
    grok) echo "Grok Build" ;;
    *) echo "$1" ;;
  esac
}

# 打印探测结果；写入 DETECTED / INSTALLED
scan_clients() {
  DETECTED=()
  INSTALLED=()
  echo "本机客户端探测："
  local c mark status
  for c in "${ALL_CLIENTS[@]}"; do
    local host=0 plugin=0
    client_detected "$c" && host=1
    client_installed "$c" && plugin=1
    if [ "$plugin" = "1" ]; then
      INSTALLED+=("$c")
      DETECTED+=("$c")
      mark="✓ 已装 Runmark"
    elif [ "$host" = "1" ]; then
      DETECTED+=("$c")
      mark="· 已发现宿主（未装 Runmark）"
    else
      mark="· 未发现"
    fi
    printf "  %-10s  %s\n" "$c" "$mark  ($(client_label "$c"))"
  done
  echo ""
  if [ "${#INSTALLED[@]}" -gt 0 ]; then
    echo "已装 Runmark: ${INSTALLED[*]}  → 再次运行将默认预选并走更新"
  fi
  if [ "${#DETECTED[@]}" -eq 0 ]; then
    echo "未探测到已知客户端。仍可手动勾选，或传 --clients cursor,..."
  else
    echo "已发现宿主: ${DETECTED[*]}"
  fi
  echo ""
}

# 默认预选：有已装则用已装；否则用已发现宿主
default_preselect() {
  if [ "${#INSTALLED[@]}" -gt 0 ]; then
    PRESELECT=("${INSTALLED[@]}")
    PRESELECT_MODE="installed"
  elif [ "${#DETECTED[@]}" -gt 0 ]; then
    PRESELECT=("${DETECTED[@]}")
    PRESELECT_MODE="detected"
  else
    PRESELECT=()
    PRESELECT_MODE="none"
  fi
}

array_contains() {
  local needle="$1"
  shift
  local x
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

# 交互勾选；初始勾选 = 已装优先，否则已发现
interactive_select() {
  local -a chosen=()
  local c i ans token
  default_preselect
  if [ "${#PRESELECT[@]}" -gt 0 ]; then
    chosen=("${PRESELECT[@]}")
  fi

  if [ "$PRESELECT_MODE" = "installed" ]; then
    echo "请选择要更新 / 安装的客户端（默认已勾选「已装 Runmark」）："
  else
    echo "请选择要安装的客户端（默认已勾选探测到的宿主）："
  fi
  echo "  输入数字切换勾选；可空格/逗号分隔多个"
  echo "  a=全选  i=仅已装  d=仅已发现宿主  n=全不选  Enter=确认  q=退出"
  echo ""

  while true; do
    i=1
    for c in "${ALL_CLIENTS[@]}"; do
      local box=" "
      if array_contains "$c" "${chosen[@]:-}"; then
        box="x"
      fi
      local hint=""
      if array_contains "$c" "${INSTALLED[@]:-}"; then
        hint=" [已装→更新]"
      elif array_contains "$c" "${DETECTED[@]:-}"; then
        hint=" [已发现]"
      fi
      printf "  %d) [%s] %-10s %s%s\n" "$i" "$box" "$c" "$(client_label "$c")" "$hint"
      i=$((i + 1))
    done
    echo ""
    printf "选择 [Enter 确认当前勾选]: "
    # 优先 /dev/tty；失败则回退 stdin（便于管道喂入测试）
    if [ -r /dev/tty ]; then
      if ! read -r ans </dev/tty; then
        if ! read -r ans; then
          echo "" >&2
          echo "ERROR: 无法读取终端输入" >&2
          exit 1
        fi
      fi
    else
      if ! read -r ans; then
        echo "" >&2
        echo "ERROR: 无法读取终端输入" >&2
        exit 1
      fi
    fi

    if [ -z "$ans" ]; then
      SELECTED=("${chosen[@]:-}")
      break
    fi
    case "$ans" in
      q|Q)
        echo "已取消"
        exit 0
        ;;
      a|A)
        chosen=("${ALL_CLIENTS[@]}")
        continue
        ;;
      i|I)
        chosen=("${INSTALLED[@]:-}")
        continue
        ;;
      d|D)
        chosen=("${DETECTED[@]:-}")
        continue
        ;;
      n|N)
        chosen=()
        continue
        ;;
    esac

    # 切换数字
    for token in ${ans//,/ }; do
      if [[ "$token" =~ ^[1-7]$ ]]; then
        c="${ALL_CLIENTS[$((token - 1))]}"
        if array_contains "$c" "${chosen[@]:-}"; then
          local -a next=()
          local x
          for x in "${chosen[@]}"; do
            [ "$x" = "$c" ] || next+=("$x")
          done
          chosen=("${next[@]:-}")
        else
          chosen+=("$c")
        fi
      else
        echo "  忽略无效输入: $token"
      fi
    done
    echo ""
  done
}

parse_clients_list() {
  local list="$1"
  SELECTED=()
  local raw c
  IFS=',' read -r -a RAW_CLIENTS <<< "$list"
  for raw in "${RAW_CLIENTS[@]}"; do
    c="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    [ -z "$c" ] && continue
    if [ "$c" = "all" ]; then
      SELECTED=("${ALL_CLIENTS[@]}")
      return 0
    fi
    if [ "$c" = "installed" ]; then
      SELECTED=("${INSTALLED[@]:-}")
      return 0
    fi
    if [ "$c" = "detected" ]; then
      SELECTED=("${DETECTED[@]:-}")
      return 0
    fi
    case "$c" in
      cursor|opencode|codex|claude|codebuddy|workbuddy|grok)
        SELECTED+=("$c")
        ;;
      claude-code|tclaude)
        SELECTED+=("claude")
        ;;
      grok-build|grokbuild|xai-grok)
        SELECTED+=("grok")
        ;;
      *)
        echo "ERROR: 未知客户端 '$c'。可选: ${ALL_CLIENTS[*]} all installed detected" >&2
        exit 1
        ;;
    esac
  done
}

dedupe_selected() {
  local -a deduped=()
  local c d skip
  for c in "${SELECTED[@]:-}"; do
    skip=0
    for d in "${deduped[@]:-}"; do
      [ "$d" = "$c" ] && skip=1 && break
    done
    [ "$skip" = "1" ] || deduped+=("$c")
  done
  SELECTED=("${deduped[@]:-}")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clients)
      CLIENTS_ARG="${2:-}"
      shift 2
      ;;
    --clients=*)
      CLIENTS_ARG="${1#*=}"
      shift
      ;;
    --uninstall)
      DO_UNINSTALL=1
      shift
      ;;
    --yes|-y)
      DO_YES=1
      shift
      ;;
    --cursor-version)
      CURSOR_VER="${2:-latest}"
      shift 2
      ;;
    --opencode-version)
      OPENCODE_VER="${2:-latest}"
      shift 2
      ;;
    --codex-version)
      CODEX_VER="${2:-latest}"
      shift 2
      ;;
    --claude-compat-version)
      CLAUDE_COMPAT_VER="${2:-latest}"
      shift 2
      ;;
    --grok-version)
      GROK_VER="${2:-latest}"
      shift 2
      ;;
    -h|--help)
      DO_HELP=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$DO_HELP" = "1" ]; then
  usage
  exit 0
fi

echo "============================================"
echo " Runmark — 统一客户端安装"
echo " entry: @runmarks/runmark@${VERSION}"
echo "============================================"
echo ""
scan_clients

SELECTED=()
if [ -n "$CLIENTS_ARG" ]; then
  parse_clients_list "$CLIENTS_ARG"
elif [ "$DO_YES" = "1" ]; then
  default_preselect
  SELECTED=("${PRESELECT[@]:-}")
elif [ -r /dev/tty ] && { [ -t 1 ] || [ -t 2 ]; }; then
  # 即使 stdin 被管道占用，也从 /dev/tty 做交互勾选
  interactive_select
else
  echo "ERROR: 非交互环境，请显式指定 --clients <list|all|installed|detected>，或加 --yes。" >&2
  echo "       例: npx @runmarks/runmark --clients installed" >&2
  exit 1
fi

dedupe_selected

if [ "${#SELECTED[@]}" -eq 0 ]; then
  echo "ERROR: 未选择任何客户端。可传 --clients all / installed / detected / cursor,..." >&2
  exit 1
fi

pkg_ref() {
  local name="$1"
  local ver="$2"
  if [ "$ver" = "latest" ] || [ -z "$ver" ]; then
    echo "${name}@latest"
  else
    echo "${name}@${ver}"
  fi
}

run_npx() {
  # 优先 bunx（部分环境 npx 对 bin 解析不稳），失败再 npx
  local pkg="$1"
  shift
  if command -v bunx >/dev/null 2>&1; then
    bunx --bun "$pkg" "$@"
  else
    npx --yes "$pkg" "$@"
  fi
}

check_env() {
  local env_file="${HOME}/.config/agent-tracker/env"
  if [ ! -f "$env_file" ]; then
    echo "WARN: $env_file 不存在。请先写入 AGENT_TRACKER_ENDPOINT / AGENT_TRACKER_API_KEY。"
    echo "      参考 Dashboard 帮助中心「统一接入配置」。"
  else
    echo "OK: 找到统一配置 $env_file"
  fi
}

# 按 hook 启动器同样的方式探测（含 ~/.bun/bin/bun），不能只查当前安装器进程。
check_runtime() {
  local has_bun=0 has_node=0
  if command -v bun >/dev/null 2>&1 || [ -x "${HOME}/.bun/bin/bun" ]; then
    has_bun=1
  fi
  if command -v node >/dev/null 2>&1; then
    has_node=1
  fi
  # nvm / fnm / volta / asdf：安装期 PATH 可能有，但宿主 GUI 未必有；启动器会烘焙绝对路径
  if [ "$has_node" = "0" ]; then
    if ls -1d "${HOME}/.nvm/versions/node"/v*/bin/node >/dev/null 2>&1 \
      || ls -1d "${HOME}/.local/share/fnm/node-versions"/*/installation/bin/node >/dev/null 2>&1 \
      || [ -x "${HOME}/.volta/bin/node" ] \
      || [ -x "${HOME}/.asdf/shims/node" ]; then
      has_node=1
    fi
  fi

  if [ "$has_bun" = "1" ]; then
    echo "OK: 检测到 bun（hook 运行时）"
    return 0
  fi
  if [ "$has_node" = "1" ]; then
    echo "WARN: 未检测到 bun，hook 将回退使用 node（已支持）。"
    echo "      建议安装 bun：curl -fsSL https://bun.sh/install | bash"
    return 0
  fi

  echo "ERROR: 未检测到 bun 或 node，插件装上后无法上报任何数据。" >&2
  echo "       请先安装其一再重试：curl -fsSL https://bun.sh/install | bash" >&2
  return 1
}

install_cursor() {
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-cursor-hooks" "$CURSOR_VER")"
  echo "→ Cursor: $ref init"
  if command -v bunx >/dev/null 2>&1; then
    bunx --bun "$ref" init
  else
    npx --yes -p "$ref" agent-tracker-cursor init
  fi
}

uninstall_cursor() {
  echo "→ Cursor: 卸载需手动删除 ~/.cursor/hooks/agent-tracker 并从 hooks.json 移除对应条目"
  echo "  （当前 cursor-hooks 包未提供 uninstall 子命令）"
}

# 写宿主配置必须 patch，禁止整文件覆写（尤其是 opencode.jsonc）
patch_opencode_jsonc() {
  local oc_cfg="$1"
  local plugin_spec="$2"
  if [ ! -f "$PATCH_OPENCODE_PY" ]; then
    echo "ERROR: 缺少 patch 脚本 $PATCH_OPENCODE_PY" >&2
    return 1
  fi
  python3 "$PATCH_OPENCODE_PY" "$oc_cfg" "$plugin_spec"
}

install_opencode() {
  local ref ver_pin
  ref="$(pkg_ref "@runmarks/agent-tracker-opencode-plugin" "$OPENCODE_VER")"
  if [ "$OPENCODE_VER" = "latest" ]; then
    ver_pin="$(npm view @runmarks/agent-tracker-opencode-plugin version --registry="$REGISTRY" 2>/dev/null || echo "")"
  else
    ver_pin="$OPENCODE_VER"
  fi
  local oc_cfg="${HOME}/.config/opencode/opencode.jsonc"
  local oc_dir="${HOME}/.config/opencode"
  mkdir -p "$oc_dir"

  if [ -z "$ver_pin" ]; then
    echo "WARN: 无法解析 opencode plugin 版本，跳过配置 patch；仍尝试 bun add $ref"
  else
    # 已有文件：文本级 patch；不存在：才创建最小骨架。绝不整文件覆写已有配置。
    patch_opencode_jsonc "$oc_cfg" "@runmarks/agent-tracker-opencode-plugin@${ver_pin}"
  fi

  if command -v bun >/dev/null 2>&1; then
    (
      cd "$oc_dir"
      bun remove @runmarks/agent-tracker-opencode-plugin >/dev/null 2>&1 || true
      bun add "$ref" --registry="$REGISTRY"
      python3 -c 'import json,pathlib; p=pathlib.Path("node_modules/@runmarks/agent-tracker-opencode-plugin/package.json"); print("installed", json.loads(p.read_text())["version"] if p.exists() else "missing")'
    )
  else
    echo "WARN: 未找到 bun，已尽量 patch opencode.jsonc；请自行在 ~/.config/opencode 安装 $ref"
  fi
}

uninstall_opencode() {
  local oc_dir="${HOME}/.config/opencode"
  local oc_cfg="${oc_dir}/opencode.jsonc"
  if [ -d "$oc_dir" ] && command -v bun >/dev/null 2>&1; then
    (cd "$oc_dir" && bun remove @runmarks/agent-tracker-opencode-plugin >/dev/null 2>&1 || true)
  fi
  if [ -f "$oc_cfg" ] && [ -f "$PATCH_OPENCODE_PY" ]; then
    python3 "$PATCH_OPENCODE_PY" "$oc_cfg" --remove
  else
    echo "→ OpenCode: 请从 ~/.config/opencode/opencode.jsonc 的 plugin 数组删除 agent-tracker-opencode-plugin"
  fi
}

install_codex() {
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-codex-plugin" "$CODEX_VER")"
  echo "→ Codex: $ref"
  run_npx "$ref"
}

uninstall_codex() {
  echo "→ Codex: 尝试 marketplace 卸载（若 CLI 支持）"
  if command -v codex >/dev/null 2>&1; then
    codex plugin remove agent-tracker@agent-tracker >/dev/null 2>&1 || \
      codex plugin uninstall agent-tracker >/dev/null 2>&1 || true
    codex plugin marketplace remove agent-tracker >/dev/null 2>&1 || true
    echo "OK: 已尝试移除 Codex agent-tracker plugin"
  else
    echo "WARN: 未找到 codex CLI；可手动删 ~/.codex/agent-tracker-marketplace"
  fi
}

install_claude_compat() {
  local runtime="$1"
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-claude-compat-plugin" "$CLAUDE_COMPAT_VER")"
  echo "→ ${runtime}: $ref --runtime $runtime"
  run_npx "$ref" --runtime "$runtime"
}

uninstall_claude_compat() {
  local runtime="$1"
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-claude-compat-plugin" "$CLAUDE_COMPAT_VER")"
  echo "→ ${runtime}: uninstall"
  run_npx "$ref" --uninstall --runtime "$runtime"
}

install_grok() {
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-grok-plugin" "$GROK_VER")"
  echo "→ Grok Build: $ref"
  run_npx "$ref"
}

uninstall_grok() {
  local ref
  ref="$(pkg_ref "@runmarks/agent-tracker-grok-plugin" "$GROK_VER")"
  echo "→ Grok Build: uninstall"
  run_npx "$ref" --uninstall
}

echo "--------------------------------------------"
echo " clients: ${SELECTED[*]}"
# 已装项走更新；新选项走安装（同一套幂等命令）
UPDATE_N=0
INSTALL_N=0
for c in "${SELECTED[@]}"; do
  if array_contains "$c" "${INSTALLED[@]:-}"; then
    UPDATE_N=$((UPDATE_N + 1))
  else
    INSTALL_N=$((INSTALL_N + 1))
  fi
done
if [ "$DO_UNINSTALL" = "1" ]; then
  echo " action:  uninstall"
else
  echo " action:  update=${UPDATE_N} install=${INSTALL_N}（已装走更新链路）"
fi
echo " registry: $REGISTRY"
echo "--------------------------------------------"
echo ""
check_env
check_runtime || exit 1
echo ""

FAILED=()
DONE=()

for c in "${SELECTED[@]}"; do
  if [ "$DO_UNINSTALL" = "1" ]; then
    echo "======== ${c} (uninstall) ========"
  elif array_contains "$c" "${INSTALLED[@]:-}"; then
    echo "======== ${c} (update) ========"
  else
    echo "======== ${c} (install) ========"
  fi
  set +e
  case "$c" in
    cursor)
      if [ "$DO_UNINSTALL" = "1" ]; then uninstall_cursor; else install_cursor; fi
      ;;
    opencode)
      if [ "$DO_UNINSTALL" = "1" ]; then uninstall_opencode; else install_opencode; fi
      ;;
    codex)
      if [ "$DO_UNINSTALL" = "1" ]; then uninstall_codex; else install_codex; fi
      ;;
    claude|codebuddy|workbuddy)
      if [ "$DO_UNINSTALL" = "1" ]; then uninstall_claude_compat "$c"; else install_claude_compat "$c"; fi
      ;;
    grok)
      if [ "$DO_UNINSTALL" = "1" ]; then uninstall_grok; else install_grok; fi
      ;;
  esac
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    DONE+=("$c")
  else
    FAILED+=("$c")
    echo "WARN: $c 失败 (exit=$status)，继续其余客户端"
  fi
  echo ""
done

echo "============================================"
echo " 完成"
echo "============================================"
echo "成功: ${DONE[*]:-（无）}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "失败: ${FAILED[*]}"
fi
echo ""
if [ "$DO_UNINSTALL" != "1" ]; then
  echo "下一步："
  echo "  1. 确认 Server: curl \"\${AGENT_TRACKER_ENDPOINT:-http://localhost:3456}/health\""
  echo "  2. 重启已安装的客户端（Claude 系可用 /reload-plugins）"
  echo "  3. Codex / Claude 系若提示：在 App 内信任 Runmark plugin hooks"
  echo "  4. Dashboard 会话页确认 agent=cursor|opencode|codex|claude|codebuddy|workbuddy|grok"
  echo "  5. 自检：跑一次会话后看 ~/.config/agent-tracker/plugin.log；若有 \"no bun/node runtime\" 说明宿主 PATH 无运行时"
fi

[ "${#FAILED[@]}" -eq 0 ]
