#!/usr/bin/env bash
# Runmark — Grok Build CLI Hook 安装脚本
#
# 写入用户级 hook 文件：~/.grok/hooks/runmark-tracker.json
# 与 Orca / Asymptote 等其它 hook 文件共存（各自独立 JSON）。
#
# 用法：
#   npx @runmarks/grok-plugin
#   cd packages/plugin-grok && bash install.sh
#   bash install.sh --uninstall
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="0.1.4"
HOOK_NAME="runmark-tracker.json"
GROK_HOME="${GROK_HOME:-$HOME/.grok}"
HOOKS_DIR="${AGENT_TRACKER_GROK_HOOKS_DIR:-$GROK_HOME/hooks}"
INSTALL_ROOT="${AGENT_TRACKER_GROK_INSTALL_DIR:-$HOME/.config/agent-tracker/grok-plugin}"
DO_UNINSTALL=0

# 解析 hook 运行时绝对路径（bun → ~/.bun/bin/bun → node → nvm/fnm/volta/asdf）
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
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
  exec "$RUNTIME" "$SCRIPT_DIR/index.mjs" "$@"
fi

LOG="${RUNMARK_LOG_FILE:-${AGENT_TRACKER_LOG_FILE:-${HOME}/.config/runmark/plugin.log}}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
printf '{"ts":"%s","level":"error","component":"tracker-hook","message":"no bun/node runtime; telemetry disabled"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG" 2>/dev/null || true
# fail-open：读掉 stdin，输出 {}
cat >/dev/null 2>&1 || true
printf '%s\n' '{}'
exit 0
BODY
  } > "$out"
  chmod +x "$out"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      DO_UNINSTALL=1
      shift
      ;;
    -h|--help)
      cat <<EOF
Runmark Grok Build Plugin 安装  v${VERSION}

Usage:
  bash install.sh [--uninstall]

安装会：
  1. 构建 / 复制 dist/index.mjs 到 ${INSTALL_ROOT}
  2. 生成可执行 wrapper：${INSTALL_ROOT}/grok-tracker-hook
  3. 写入用户级 hook：${HOOKS_DIR}/${HOOK_NAME}
  4. 与 ~/.grok/hooks 下其它 JSON（如 orca）共存

卸载：
  bash install.sh --uninstall
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
echo " Runmark — Grok Build Plugin 安装"
echo " version: ${VERSION}"
echo "============================================"
echo ""

if [ "$DO_UNINSTALL" = "1" ]; then
  echo "[uninstall] 移除 hook 与安装目录 ..."
  rm -f "${HOOKS_DIR}/${HOOK_NAME}"
  rm -rf "${INSTALL_ROOT}"
  echo "OK: 已移除 ${HOOKS_DIR}/${HOOK_NAME}"
  echo "OK: 已移除 ${INSTALL_ROOT}"
  echo ""
  echo "请重启 Grok（或新开会话）使 hook 生效。"
  exit 0
fi

# 1. 准备 dist
echo "[1/4] 准备 dist/index.mjs ..."
if [ -f "$SCRIPT_DIR/src/index.ts" ]; then
  cd "$SCRIPT_DIR"
  if command -v bun >/dev/null 2>&1; then
    bun run build
  else
    echo "ERROR: 需要 Bun 构建源码（https://bun.sh）"
    exit 1
  fi
elif [ ! -f "$SCRIPT_DIR/dist/index.mjs" ]; then
  echo "ERROR: dist/index.mjs 不存在，请重新安装 npm 包或在源码仓库执行 bun run build"
  exit 1
else
  echo "  使用 npm 包内置 dist/index.mjs"
fi

if [ ! -f "$SCRIPT_DIR/dist/index.mjs" ]; then
  echo "ERROR: 构建后仍无 dist/index.mjs"
  exit 1
fi

# 2. 安装到固定目录（避免 npx 缓存路径失效）
echo "[2/4] 安装到 ${INSTALL_ROOT} ..."
mkdir -p "$INSTALL_ROOT"
cp "$SCRIPT_DIR/dist/index.mjs" "$INSTALL_ROOT/index.mjs"

BAKED_RUNTIME=""
if ! BAKED_RUNTIME="$(resolve_hook_runtime)"; then
  echo "ERROR: 未检测到 bun 或 node，插件装上后无法上报任何数据。" >&2
  echo "       请先安装其一再重试：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
echo "  hook runtime: $BAKED_RUNTIME"
write_hook_launcher "$INSTALL_ROOT/grok-tracker-hook" "$BAKED_RUNTIME"

HOOK_SCRIPT="$INSTALL_ROOT/grok-tracker-hook"

# 3. 生成 hooks JSON
echo "[3/4] 写入 ${HOOKS_DIR}/${HOOK_NAME} ..."
mkdir -p "$HOOKS_DIR"
TEMPLATE="$SCRIPT_DIR/hooks/hooks.template.json"
if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: 缺少 hooks template: $TEMPLATE"
  exit 1
fi

# 用 python 安全替换占位符，避免路径中特殊字符
python3 - "$TEMPLATE" "${HOOKS_DIR}/${HOOK_NAME}" "$HOOK_SCRIPT" <<'PY'
import json, sys
from pathlib import Path

template_path, out_path, hook_script = sys.argv[1], sys.argv[2], sys.argv[3]
raw = Path(template_path).read_text(encoding="utf-8")
raw = raw.replace("PLACEHOLDER_HOOK_SCRIPT", hook_script)
# 校验 JSON
data = json.loads(raw)
Path(out_path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"  wrote {out_path}")
print(f"  events: {', '.join(data.get('hooks', {}).keys())}")
PY

# 4. 探测 Grok
echo "[4/4] 探测 Grok CLI ..."
if command -v grok >/dev/null 2>&1; then
  echo "  grok: $(command -v grok)"
  grok --version 2>/dev/null | head -1 || true
else
  echo "  WARN: 未在 PATH 中找到 grok；hook 文件已写好，安装 Grok 后新会话会自动加载"
fi

echo ""
echo "============================================"
echo " 安装完成!"
echo "============================================"
echo ""
echo "Hook 文件:   ${HOOKS_DIR}/${HOOK_NAME}"
echo "Hook 脚本:   ${HOOK_SCRIPT}"
echo "安装目录:    ${INSTALL_ROOT}"
echo ""
echo "下一步："
echo "  1. 确认 Runmark Server: curl localhost:3456/health"
echo "  2. 配置 ~/.config/runmark/env（与其它客户端共用）"
echo "     endpoint=\"http://localhost:3456\""
echo "     apiKey=\"dev-key-change-me\""
echo "  3. 重启 Grok 或新开会话（用户级 hooks 无需 /hooks-trust）"
echo "  4. 可选：grok inspect --json | 查看 hooks 是否含 runmark"
echo ""
echo "验证："
echo "  echo '{\"sessionId\":\"test\",\"hookEventName\":\"UserPromptSubmit\",\"prompt\":\"hi\",\"cwd\":\"'\"\$PWD\"'\"}' \\"
echo "    | ${HOOK_SCRIPT} user-prompt"
echo ""
echo "卸载："
echo "  bash install.sh --uninstall"
echo "  # 或 npx @runmarks/grok-plugin --uninstall"
echo ""
