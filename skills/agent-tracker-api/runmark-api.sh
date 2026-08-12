#!/usr/bin/env bash
# Runmark API — 静默加载鉴权、提供简洁 curl 包装
# 用法（Agent / 终端）: source skills/agent-tracker-api/runmark-api.sh
# 之后直接调用: runmark_get /v1/sessions?limit=10 | jq .
#               runmark_post /v1/cursor/sync -d '{}'
#
# 设计原则：
#  1. 自动加载 ~/.config/agent-tracker/env，无需 Agent 手动 export
#  2. 环境变量优先级：进程 env > ~/.config/agent-tracker/env > 默认值
#  3. 尽最大努力（best-effort），env 文件缺失不报错，走 localhost fallback
#  4. Cursor Agent / 非交互 shell 的 PATH 可能不含 /usr/bin，需兜底解析 curl/jq

_runmark_ensure_path() {
  local _std="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
  case ":${PATH}:" in
    *:/usr/bin:*) ;;
    *) export PATH="${_std}:${PATH:-}" ;;
  esac
}

_runmark_resolve_bin() {
  local var_name="$1"
  local cmd_name="$2"
  local fallback="$3"
  local resolved=""

  # 支持 bash (${!var}) 与 zsh (source 时) 两种读取方式
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    resolved="${(P)var_name:-}"
  else
    resolved="${!var_name:-}"
  fi

  if [[ -n "$resolved" ]] && [[ -x "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi
  if command -v "$cmd_name" >/dev/null 2>&1; then
    command -v "$cmd_name"
    return 0
  fi
  if [[ -n "$fallback" ]] && [[ -x "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  echo "runmark-api: ${cmd_name} not found (PATH=${PATH})" >&2
  return 1
}

_runmark_init() {
  _runmark_ensure_path

  # 静默加载 env 文件（如果已通过 shell 环境设置则跳过）
  local env_file="${HOME}/.config/agent-tracker/env"
  if [[ -z "${AGENT_TRACKER_ENDPOINT:-}" ]] && [[ -f "$env_file" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
  fi

  _RM_CURL="$(_runmark_resolve_bin RUNMARK_CURL curl /usr/bin/curl)" || return 1
  _RM_JQ="$(_runmark_resolve_bin RUNMARK_JQ jq /usr/bin/jq)" || return 1
  _RM_ENDPOINT="${AGENT_TRACKER_ENDPOINT:-http://localhost:3456}"
  _RM_API_KEY="${AGENT_TRACKER_API_KEY:-}"
}

# 核心 curl 封装
_runmark_req() {
  local method="$1"
  local path="$2"
  shift 2
  local auth_args=()
  # API Key 优先走 Header；同时支持 AGENT_TRACKER_PUBLIC_DASHBOARD 免鉴权场景
  if [[ -n "${_RM_API_KEY:-}" ]]; then
    auth_args=(-H "X-API-Key: ${_RM_API_KEY}")
  fi
  "$_RM_CURL" -sS "${auth_args[@]}" -X "$method" "${_RM_ENDPOINT}${path}" "$@"
}

# 公开 API：GET / POST / PUT / DELETE
runmark_get()  { _runmark_req GET "$@"; }
runmark_post() { _runmark_req POST "$@"; }
runmark_put()  { _runmark_req PUT "$@"; }
runmark_delete() { _runmark_req DELETE "$@"; }

# 健康检查快捷方式
runmark_health() { runmark_get /health | "$_RM_JQ" .; }

# 初始化（source 时自动执行）
_runmark_init
