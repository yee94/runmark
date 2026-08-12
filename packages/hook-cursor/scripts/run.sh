#!/usr/bin/env bash
# Runmark 遥测 Hook 包装器 — 绝不影响 Cursor 主流程（fail-open）
set +e
set +u

DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT="$(cat)"

emit_continue() {
  printf '%s\n' '{"continue":true}'
}

is_before_submit_prompt() {
  case "$INPUT" in
    *beforeSubmitPrompt*) return 0 ;;
    *) return 1 ;;
  esac
}

is_session_end() {
  case "$INPUT" in
    *sessionEnd*) return 0 ;;
    *) return 1 ;;
  esac
}

NODE=""
for cmd in node bun; do
  if command -v "$cmd" >/dev/null 2>&1; then
    NODE="$cmd"
    break
  fi
done

if [ -z "$NODE" ]; then
  if is_before_submit_prompt; then
    emit_continue
  fi
  exit 0
fi

if is_session_end; then
  (printf '%s' "$INPUT" | "$NODE" "$DIR/hook.mjs" >/dev/null 2>&1) &
  exit 0
fi

printf '%s' "$INPUT" | "$NODE" "$DIR/hook.mjs" 2>/dev/null
STATUS=$?

# beforeSubmitPrompt 是门禁事件：node 失败或无输出时仍必须放行
if is_before_submit_prompt && [ "$STATUS" -ne 0 ]; then
  emit_continue
fi

exit 0
