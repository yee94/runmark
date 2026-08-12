#!/usr/bin/env bash
# Runmark — Codex Plugin 安装脚本
#
# 通过 Codex marketplace 机制安装本地插件。
#
# 用法：
#   cd packages/plugin-codex && bash install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || true)"
VERSION="0.2.5"
MARKETPLACE_NAME="agent-tracker"
PLUGIN_NAME="agent-tracker"
CODEX_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}"

echo "============================================"
echo " Runmark — Codex Plugin 安装"
echo "============================================"
echo ""

# 检查 Codex CLI 是否可用
if [ ! -f "$CODEX_BIN" ]; then
  echo "⚠️  未找到 Codex CLI，尝试使用 PATH 中的 codex ..."
  CODEX_BIN="codex"
fi

# 1. 准备构建产物
echo "[1/5] 准备 dist/index.mjs ..."
if [ -f "$SCRIPT_DIR/src/index.ts" ]; then
  cd "$SCRIPT_DIR"
  bun run build
elif [ ! -f "$SCRIPT_DIR/dist/index.mjs" ]; then
  echo "ERROR: dist/index.mjs 不存在，请重新安装 npm 包或在源码仓库执行 bun run build"
  exit 1
else
  echo "  使用 npm 包内置 dist/index.mjs"
fi

# 2. 复制 marketplace 到 Codex 本地工作目录
echo "[2/5] 准备 Codex marketplace 工作目录 ..."
SOURCE_MARKETPLACE_DIR="$SCRIPT_DIR/marketplace"
MARKETPLACE_DIR="${AGENT_TRACKER_CODEX_MARKETPLACE_DIR:-$HOME/.codex/agent-tracker-marketplace}"
rm -rf "$MARKETPLACE_DIR"
mkdir -p "$(dirname "$MARKETPLACE_DIR")"
cp -R "$SOURCE_MARKETPLACE_DIR" "$MARKETPLACE_DIR"
PLUGIN_DIR="$MARKETPLACE_DIR/plugins/$PLUGIN_NAME"

echo "  marketplace: $MARKETPLACE_DIR"

mkdir -p "$PLUGIN_DIR/dist" "$PLUGIN_DIR/hooks"
cp "$SCRIPT_DIR/dist/index.mjs" "$PLUGIN_DIR/dist/"
# 生成 hook wrapper
cat > "$PLUGIN_DIR/dist/codex-tracker-hook" << 'HOOKEOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun run "$SCRIPT_DIR/index.mjs" "$@"
HOOKEOF
chmod +x "$PLUGIN_DIR/dist/codex-tracker-hook"

# 3. 生成 hooks.json（替换占位符为绝对路径）
echo "[3/5] 生成 hooks.json → $PLUGIN_DIR/hooks/hooks.json"
HOOK_SCRIPT="$PLUGIN_DIR/dist/codex-tracker-hook"
sed "s|PLACEHOLDER_HOOK_SCRIPT|${HOOK_SCRIPT}|g" \
  "$PLUGIN_DIR/hooks/hooks.template.json" \
  > "$PLUGIN_DIR/hooks/hooks.json.tmp" && \
  mv "$PLUGIN_DIR/hooks/hooks.json.tmp" "$PLUGIN_DIR/hooks/hooks.json"

# 4. 注册 marketplace（如果未注册则添加）
echo "[4/5] 注册 marketplace '$MARKETPLACE_NAME' ..."
"$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
"$CODEX_BIN" plugin marketplace add "$MARKETPLACE_DIR"
echo "  marketplace '$MARKETPLACE_NAME' 注册成功"

# 5. 安装插件
echo "[5/5] 从 marketplace 安装插件 '$PLUGIN_NAME' ..."
"$CODEX_BIN" plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME" 2>&1 || {
  echo "  ⚠️  plugin add 返回非零，但可能已成功（检查 Codex App）"
}

echo ""
echo "============================================"
echo " 安装完成!"
echo "============================================"
echo ""
echo "Marketplace 目录: $MARKETPLACE_DIR"
echo ""
echo "下一步："
echo "  1. 确认 Runmark Server 运行中: curl localhost:3456/health"
echo "  2. 在 Codex App 的 Settings → Plugins 中检查 'Runmark' 是否出现"
echo "  3. 在 Codex 中使用 /hooks 审查并信任此插件的 hook"
echo "  4. 配置 ~/.config/agent-tracker/env（与 OpenCode 插件共用）"
echo "     endpoint=\"http://localhost:3456\""
echo "     apiKey=\"dev-key-change-me\""
echo ""
echo "验证 hook 是否工作:"
echo "  echo '{\"session_id\":\"test\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}' | $HOOK_SCRIPT session-start"
echo ""
