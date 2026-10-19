#!/usr/bin/env bash
# Runmark Server Auto-Update Script
# 部署于 /opt/runmark-updater/update.sh（root 所有）
#
# 用法: update.sh --manifest-url <url> --expected-version <ver> [--state-file <path>]
#
# Phase: downloading -> verifying -> installing -> backing_up -> restarting -> health_check -> completed
#        停止服务后的失败进入 rolling_back -> rolled_back
#
# 安全: Git 工作区保护 — APP_ROOT 含 .git 直接 failed 退出（避免误操作仓库）
set -euo pipefail

# ---- helpers ----
redact_secrets() { sed -E 's/(api[_-]?[Kk]ey[=:" ]+)[^[:space:]"]+/\1[REDACTED]/gi' | sed -E 's/([Tt]oken[=:" ]+)[^[:space:]"]+/\1[REDACTED]/gi'; }
sanitize_url() { local u="$1"; echo "${u%%\?*}" | sed 's|://[^@]*@|://[REDACTED]@|g'; }
log() { local l="$1"; shift; echo "[$(date -u +%FT%TZ)] [${l}] $*" | redact_secrets | tee -a "$LOG_FILE" >&2; }

write_state() {
  local phase="${1:-}" ver="${2:-}" err="${3:-}" tmp="${STATE_FILE}.tmp.$$" completed="null"
  if [ "$phase" = "completed" ] || [ "$phase" = "rolled_back" ] || [ "$phase" = "failed" ]; then completed="\"$(date -u +%FT%TZ)\""; fi
  STATE_PHASE="$phase" STATE_VERSION="$ver" STATE_STARTED="$UPDATE_STARTED_AT" STATE_COMPLETED="$completed" STATE_ERROR="$err" STATE_TMP="$tmp" \
  "$BUN_BIN" -e 'const fs=require("fs"),s={phase:process.env.STATE_PHASE||null,version:process.env.STATE_VERSION||null,startedAt:process.env.STATE_STARTED||null,completedAt:(v=>{try{return JSON.parse(v)}catch{return null}})(process.env.STATE_COMPLETED||"null"),error:(v=>{if(!v)return null;try{return JSON.parse(v)}catch{return v}})(process.env.STATE_ERROR||"")};try{fs.writeFileSync(process.env.STATE_TMP,JSON.stringify(s,null,2),"utf-8")}catch(e){process.exit(1)}' 2>/dev/null || { rm -f "$tmp"; return 1; }
  if ! mv "$tmp" "$STATE_FILE" 2>/dev/null; then rm -f "$tmp"; return 1; fi
}

cleanup_staging() { rm -rf "$STAGING_DIR" 2>/dev/null || true; }

install_staging_dependencies() {
  local lock_version bun_version
  [ -s bun.lock ] || { log ERROR "Release is missing bun.lock; refusing unlocked install"; return 1; }
  lock_version=$(sed -n 's/.*"lockfileVersion"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' bun.lock | head -1)
  case "$lock_version" in
    1) "$BUN_BIN" install --production --frozen-lockfile ;;
    2)
      if "$BUN_BIN" -e 'const [a,b]=process.versions.bun.split(".").map(Number);process.exit(a>1||(a===1&&b>=4)?0:1)'; then
        "$BUN_BIN" install --production --frozen-lockfile
      else
        bun_version="${BUN_COMPAT_VERSION:-1.4.0}"
        [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log ERROR "Invalid BUN_COMPAT_VERSION"; return 1; }
        log INFO "Installing lockfile v2 with bun@${bun_version}"
        "$BUN_BIN" x --bun "bun@${bun_version}" install --production --frozen-lockfile
      fi ;;
    *) log ERROR "Unsupported lockfile version: ${lock_version:-missing}"; return 1 ;;
  esac
}

reflink_database() {
  local snapshot="$1" was_active=false suffix
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    was_active=true
    SERVICE_WAS_STOPPED=true
    systemctl stop "$SERVICE_NAME" || return 1
  fi
  systemctl is-active --quiet "$SERVICE_NAME" && return 1
  # 停服后克隆主库及 WAL；不复制共享内存索引，由 SQLite 重建。
  cp --reflink=always --preserve=mode "$DB_FILE" "$snapshot" || return 1
  for suffix in -wal; do
    if [ -f "${DB_FILE}${suffix}" ]; then
      cp --reflink=always --preserve=mode "${DB_FILE}${suffix}" "${snapshot}${suffix}" || return 1
    fi
  done
  if [ "$was_active" = true ]; then
    systemctl start "$SERVICE_NAME" || return 1
    SERVICE_WAS_STOPPED=false
  fi
}

resolve_db_path() {
  local env_file="$APP_ROOT/.env" db_path="packages/server/data/agent-tracker.db"
  if [ -f "$env_file" ]; then local val; val=$(grep -m1 '^AGENT_TRACKER_DB_PATH=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d ' \r'); [ -n "$val" ] && db_path="$val"; fi
  [ "${db_path:0:1}" != "/" ] && echo "$APP_ROOT/$db_path" || echo "$db_path"
}

snapshot_database() {
  local db_dir snapshot integrity probe mode
  DB_FILE=$(resolve_db_path); db_dir=$(dirname "$DB_FILE")
  [ -d "$db_dir" ] || { log ERROR "DB dir missing"; return 1; }
  [ -s "$DB_FILE" ] || { log ERROR "DB file missing or empty"; return 1; }
  command -v sqlite3 >/dev/null 2>&1 || { log ERROR "sqlite3 is required for consistent DB backups"; return 1; }

  mkdir -p "$BACKUP_PATH/data"
  snapshot="$BACKUP_PATH/data/$(basename "$DB_FILE")"
  log INFO "Creating consistent DB snapshot"
  mode="${AGENT_TRACKER_BACKUP_MODE:-auto}"
  case "$mode" in auto|sqlite|reflink) ;; *) log ERROR "Invalid backup mode: $mode"; return 1 ;; esac
  probe="$BACKUP_PATH/data/.reflink-probe"
  if [ "$mode" != sqlite ] && cp --reflink=always "$DB_FILE" "$probe" 2>/dev/null; then
    rm -f "$probe"
    log INFO "Creating copy-on-write snapshot (brief service stop)"
    reflink_database "$snapshot" || { log ERROR "Reflink snapshot failed"; return 1; }
  else
    rm -f "$probe"
    [ "$mode" != reflink ] || { log ERROR "Filesystem does not support reflink"; return 1; }
    log INFO "Using portable SQLite online backup"
    sqlite3 "$DB_FILE" ".backup '$snapshot'" 2>>"$LOG_FILE" || { log ERROR "SQLite snapshot failed"; return 1; }
  fi
  [ -s "$snapshot" ] || { log ERROR "SQLite snapshot is empty"; return 1; }
  integrity=$(sqlite3 -readonly "$snapshot" "PRAGMA integrity_check;" 2>>"$LOG_FILE" || true)
  [ "$integrity" = "ok" ] || { log ERROR "SQLite snapshot integrity check failed"; return 1; }
  DB_SNAPSHOT_SESSIONS=$(sqlite3 -readonly "$snapshot" "SELECT COUNT(*) FROM sessions;" 2>>"$LOG_FILE" || true)
  DB_SNAPSHOT_TURNS=$(sqlite3 -readonly "$snapshot" "SELECT COUNT(*) FROM turns;" 2>>"$LOG_FILE" || true)
  [[ "$DB_SNAPSHOT_SESSIONS" =~ ^[0-9]+$ && "$DB_SNAPSHOT_TURNS" =~ ^[0-9]+$ ]] || { log ERROR "SQLite snapshot record count failed"; return 1; }
  log INFO "DB snapshot complete: ${snapshot}"
}

verify_database_after_update() {
  local integrity sessions turns
  integrity=$(sqlite3 -readonly "$DB_FILE" "PRAGMA integrity_check;" 2>>"$LOG_FILE" || true)
  [ "$integrity" = "ok" ] || { log ERROR "Updated DB integrity check failed"; return 1; }
  sessions=$(sqlite3 -readonly "$DB_FILE" "SELECT COUNT(*) FROM sessions;" 2>>"$LOG_FILE" || true)
  turns=$(sqlite3 -readonly "$DB_FILE" "SELECT COUNT(*) FROM turns;" 2>>"$LOG_FILE" || true)
  [[ "$sessions" =~ ^[0-9]+$ && "$turns" =~ ^[0-9]+$ ]] || { log ERROR "Updated DB record count failed"; return 1; }
  [ "$sessions" -ge "$DB_SNAPSHOT_SESSIONS" ] || { log ERROR "Updated DB session count decreased"; return 1; }
  [ "$turns" -ge "$DB_SNAPSHOT_TURNS" ] || { log ERROR "Updated DB turn count decreased"; return 1; }
  log INFO "Updated DB verified: sessions=${sessions}, turns=${turns}"
}

# ---- rollback ----
perform_rollback() {
  if [ "${CURRENT_PHASE:-}" = "rolling_back" ] || [ "${CURRENT_PHASE:-}" = "rolled_back" ]; then return 0; fi
  CURRENT_PHASE="rolling_back"; log WARN "=== ROLLBACK ==="; write_state "rolling_back" "$EXPECTED_VERSION" "Rolling back from ${EXPECTED_VERSION}"
  local rollback_ok=true
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true; sleep 2

  if [ -n "${BACKUP_PATH:-}" ] && [ -d "$BACKUP_PATH/code" ]; then
    log INFO "Restoring code"
    rsync -a --checksum --delete --exclude '.env' --exclude '.env.local' --exclude 'packages/server/data/' --exclude '.git' --exclude '*.log' "$BACKUP_PATH/code/" "$APP_ROOT/" 2>/dev/null || rollback_ok=false
  else log ERROR "No code backup"; rollback_ok=false; fi

  local db_file; db_file=$(resolve_db_path)
  # 先删除目标 DB/wal/shm（即使备份中无也清掉），再从备份恢复存在的
  rm -f "$db_file" "${db_file}-wal" "${db_file}-shm" 2>/dev/null || true
  if [ -n "${BACKUP_PATH:-}" ] && [ -d "$BACKUP_PATH/data" ]; then
    local backup_db="$BACKUP_PATH/data/$(basename "$db_file")"
    if [ -f "$backup_db" ]; then cp "$backup_db" "$db_file" 2>/dev/null || rollback_ok=false; else log ERROR "DB main backup missing"; rollback_ok=false; fi
    for s in "-wal" "-shm"; do local bk="$BACKUP_PATH/data/$(basename "$db_file")${s}"; [ -f "$bk" ] && { cp "$bk" "${db_file}${s}" 2>/dev/null || rollback_ok=false; }; done
  else log ERROR "No DB backup"; rollback_ok=false; fi

  systemctl start "$SERVICE_NAME" 2>/dev/null || rollback_ok=false; sleep 3
  systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || rollback_ok=false

  local port="3456" health_ok=false
  if [ -f "$APP_ROOT/.env" ]; then local ep; ep=$(grep -m1 '^AGENT_TRACKER_PORT=' "$APP_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d ' \r'); [ -n "$ep" ] && echo "$ep" | grep -qE '^[0-9]+$' && port="$ep"; fi
  local i; for i in $(seq 1 10); do
    local resp; resp=$(curl -sS --max-time 5 "http://localhost:${port}/health" 2>/dev/null || true)
    [ -n "$resp" ] && { local st; st=$(echo "$resp" | "$BUN_BIN" -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).status||'')}catch(e){process.stdout.write('')}" 2>/dev/null || echo ""); [ "$st" = "ok" ] && { health_ok=true; break; }; }; sleep 2
  done
  [ "$health_ok" != "true" ] && rollback_ok=false

  if [ "$rollback_ok" = "true" ]; then CURRENT_PHASE="rolled_back"; write_state "rolled_back" "$EXPECTED_VERSION" "Rolled back from ${EXPECTED_VERSION}" || log ERROR "state write failed"; log ERROR "=== ROLLBACK COMPLETE ==="; return 0
  else write_state "failed" "$EXPECTED_VERSION" "Rollback failed" || true; log ERROR "=== ROLLBACK FAILED ==="; return 1; fi
}

# ---- traps ----
on_exit() { local ec=$?; trap - EXIT INT TERM; [ "${ROLLBACK_NEEDED:-false}" = "true" ] && perform_rollback; if [ "${SERVICE_WAS_STOPPED:-false}" = "true" ] && [ "${ROLLBACK_NEEDED:-false}" != "true" ] && [ "${CURRENT_PHASE:-}" != "completed" ] && [ "${CURRENT_PHASE:-}" != "rolling_back" ] && [ "${CURRENT_PHASE:-}" != "rolled_back" ]; then log WARN "Restarting original service"; systemctl start "$SERVICE_NAME" 2>/dev/null || true; fi; exec 200>&- 2>/dev/null || true; cleanup_staging; exit "$ec"; }
on_signal() { log ERROR "Signal received"; CURRENT_PHASE="failed"; exit 1; }

# ---- config ----
MANIFEST_URL=""; EXPECTED_VERSION=""; STATE_FILE=""
APP_ROOT="${APP_ROOT:-/opt/agent-tracker}"; SERVICE_NAME="${SERVICE_NAME:-agent-tracker}"
UPDATER_ROOT="${UPDATER_ROOT:-/opt/runmark-updater}"
STAGING_DIR="${UPDATER_ROOT}/staging"; BACKUP_DIR="${UPDATER_ROOT}/backups"; LOG_FILE="${UPDATER_ROOT}/update.log"; LOCK_FILE="${UPDATER_ROOT}/update.lock"
MAX_DOWNLOAD_SIZE=$((200*1024*1024)); MAX_MANIFEST_SIZE=$((64*1024)); KEEP_BACKUPS=5
HEALTH_TIMEOUT="${AGENT_TRACKER_UPDATE_HEALTH_TIMEOUT:-30}"; HEALTH_POLL_INTERVAL="${AGENT_TRACKER_UPDATE_HEALTH_POLL_INTERVAL:-2}"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"

while [ $# -gt 0 ]; do case "$1" in
  --manifest-url) MANIFEST_URL="$2"; shift 2 ;; --expected-version) EXPECTED_VERSION="$2"; shift 2 ;;
  --state-file) STATE_FILE="$2"; shift 2 ;; --app-root) APP_ROOT="$2"; shift 2 ;; --service-name) SERVICE_NAME="$2"; shift 2 ;;
  --help|-h) echo "Usage: $0 --manifest-url <url> --expected-version <ver> [options]"; exit 0 ;; *) log ERROR "Unknown: $1"; exit 1 ;;
esac; done

[ -z "$MANIFEST_URL" ] && { log ERROR "Missing --manifest-url"; exit 1; }
[ -z "$EXPECTED_VERSION" ] && { log ERROR "Missing --expected-version"; exit 1; }
echo "$EXPECTED_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || { log ERROR "Invalid semver: ${EXPECTED_VERSION}"; exit 1; }
[ -z "$STATE_FILE" ] && STATE_FILE="${UPDATER_ROOT}/update-state.json"
mkdir -p "$(dirname "$STATE_FILE")" "$UPDATER_ROOT" "$BACKUP_DIR" "$(dirname "$LOG_FILE")"
chmod 755 "$(dirname "$STATE_FILE")" "$UPDATER_ROOT" "$BACKUP_DIR" 2>/dev/null || true

# ---- runtime state ----
ROLLBACK_NEEDED=false; SERVICE_WAS_STOPPED=false; CURRENT_PHASE="downloading"; UPDATE_STARTED_AT=""; BACKUP_PATH=""; CURRENT_VERSION=""; DB_FILE=""; DB_SNAPSHOT_SESSIONS=""; DB_SNAPSHOT_TURNS=""

# ---- Git worktree protection ----
if [ -d "$APP_ROOT/.git" ] || [ -f "$APP_ROOT/.git" ]; then
  log ERROR "APP_ROOT contains .git — refusing to operate on a git worktree/production checkout. Use /opt/agent-tracker deployed copy."
  write_state "failed" "$EXPECTED_VERSION" "APP_ROOT is a git repository"
  exit 1
fi

# ---- 1. flock (fail-closed) ----
exec 200>"$LOCK_FILE"
if ! command -v flock >/dev/null 2>&1; then log ERROR "flock not available — production requires lock"; write_state "failed" "$EXPECTED_VERSION" "flock missing"; exit 1; fi
flock -n 200 || { log ERROR "Lock held: ${LOCK_FILE}"; exit 1; }

trap 'on_exit' EXIT; trap 'on_signal' INT TERM
UPDATE_STARTED_AT="$(date -u +%FT%TZ)"; log INFO "Update: expected=${EXPECTED_VERSION}"; write_state "downloading" "$EXPECTED_VERSION"

# ---- 2. version check ----
[ -f "$APP_ROOT/packages/server/package.json" ] && CURRENT_VERSION=$("$BUN_BIN" -e "try{process.stdout.write(require('${APP_ROOT}/packages/server/package.json').version||'')}catch(e){process.stdout.write('')}" 2>/dev/null || echo "")
[ "$CURRENT_VERSION" = "$EXPECTED_VERSION" ] && { log INFO "Already ${EXPECTED_VERSION}"; write_state "completed" "$EXPECTED_VERSION"; exit 0; }
log INFO "Current: ${CURRENT_VERSION:-unknown} -> ${EXPECTED_VERSION}"

# ---- 3. download manifest ----
mkdir -p "$STAGING_DIR"; TMP_MANIFEST="${STAGING_DIR}/_manifest.$$.json"
HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_MANIFEST" --max-time 30 --max-filesize "$MAX_MANIFEST_SIZE" "$MANIFEST_URL" 2>/dev/null || echo "000")
[ "$HTTP_CODE" != "200" ] && { log ERROR "Manifest HTTP ${HTTP_CODE}"; write_state "failed" "$EXPECTED_VERSION" "Manifest HTTP ${HTTP_CODE}"; exit 1; }
MANIFEST_SIZE=$(wc -c < "$TMP_MANIFEST" 2>/dev/null | tr -d ' ')
[ "$MANIFEST_SIZE" -gt "$MAX_MANIFEST_SIZE" ] && { log ERROR "Manifest too large"; write_state "failed" "$EXPECTED_VERSION" "Manifest too large"; exit 1; }

# ---- 4. verify manifest ----
write_state "verifying" "$EXPECTED_VERSION"
MANIFEST_VALIDATED=$("$BUN_BIN" -e "const fs=require('fs'),raw=fs.readFileSync('${TMP_MANIFEST}','utf-8');let m;try{m=JSON.parse(raw)}catch(e){process.exit(1)};if(m.schemaVersion!==1||!m.version||!m.artifact||!m.artifact.url||!m.artifact.sha256||typeof m.artifact.size!=='number')process.exit(1);if(!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\$/.test(m.version))process.exit(1);if(m.version!=='${EXPECTED_VERSION}')process.exit(1);if(!/^[a-f0-9]{64}\$/.test(m.artifact.sha256))process.exit(1);if(!Number.isSafeInteger(m.artifact.size)||m.artifact.size<=0||m.artifact.size>${MAX_DOWNLOAD_SIZE})process.exit(1);let u;try{u=new URL(m.artifact.url)}catch(e){process.exit(1)};if(u.protocol!=='http:'&&u.protocol!=='https:')process.exit(1);if(u.username||u.password)process.exit(1);process.stdout.write(JSON.stringify(m));" 2>&1) || { log ERROR "Manifest validation failed"; write_state "failed" "$EXPECTED_VERSION" "Manifest validation failed"; exit 1; }

ARTIFACT_URL=$("$BUN_BIN" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).artifact.url)" <<< "$MANIFEST_VALIDATED")
ARTIFACT_SHA256=$("$BUN_BIN" -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).artifact.sha256)" <<< "$MANIFEST_VALIDATED")
ARTIFACT_SIZE=$("$BUN_BIN" -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).artifact.size))" <<< "$MANIFEST_VALIDATED")
log INFO "Manifest valid: artifact=$(sanitize_url "$ARTIFACT_URL") size=${ARTIFACT_SIZE}"; rm -f "$TMP_MANIFEST"

# ---- 5. download artifact ----
TMP_ARCHIVE="$UPDATER_ROOT/_archive.$$.tar.gz"; rm -f "$TMP_ARCHIVE"
HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMP_ARCHIVE" --max-time 120 --max-filesize "$MAX_DOWNLOAD_SIZE" "$ARTIFACT_URL" 2>/dev/null || echo "000")
[ "$HTTP_CODE" != "200" ] && { log ERROR "Artifact HTTP ${HTTP_CODE}"; write_state "failed" "$EXPECTED_VERSION" "Artifact HTTP ${HTTP_CODE}"; exit 1; }
DOWNLOAD_SIZE=$(wc -c < "$TMP_ARCHIVE" 2>/dev/null | tr -d ' ')
[ "$DOWNLOAD_SIZE" -ne "$ARTIFACT_SIZE" ] && { log ERROR "Size mismatch: ${DOWNLOAD_SIZE} != ${ARTIFACT_SIZE}"; write_state "failed" "$EXPECTED_VERSION" "Size mismatch"; exit 1; }
COMPUTED_SHA256=""; command -v sha256sum >/dev/null 2>&1 && COMPUTED_SHA256=$(sha256sum "$TMP_ARCHIVE" | awk '{print $1}')
[ -z "$COMPUTED_SHA256" ] && COMPUTED_SHA256=$(shasum -a 256 "$TMP_ARCHIVE" 2>/dev/null | awk '{print $1}')
[ "$COMPUTED_SHA256" != "$ARTIFACT_SHA256" ] && { log ERROR "SHA256 mismatch"; write_state "failed" "$EXPECTED_VERSION" "SHA256 mismatch"; exit 1; }
log INFO "Artifact verified: ${DOWNLOAD_SIZE} bytes"

# ---- 6. staging extract + install ----
write_state "installing" "$EXPECTED_VERSION"
TAR_LIST=$(tar -tzf "$TMP_ARCHIVE")
while IFS= read -r entry; do
  bad=false; [ "${entry:0:1}" = "/" ] && bad=true
  OLDIFS=$IFS; IFS='/'; set -- $entry; IFS=$OLDIFS; for p; do [ "$p" = ".." ] && bad=true; done
  [ "$bad" = "true" ] && { log ERROR "Dangerous tar entry: ${entry}"; rm -f "$TMP_ARCHIVE"; write_state "failed" "$EXPECTED_VERSION" "Dangerous tar entry"; exit 1; }
done <<< "$TAR_LIST"
tar -tvf "$TMP_ARCHIVE" 2>/dev/null | grep -qE '^[lh]' && { log ERROR "Archive contains links"; rm -f "$TMP_ARCHIVE"; write_state "failed" "$EXPECTED_VERSION" "Archive contains links"; exit 1; }
cleanup_staging; mkdir -p "$STAGING_DIR"; tar -xzf "$TMP_ARCHIVE" -C "$STAGING_DIR"; rm -f "$TMP_ARCHIVE"
STAGING_APP=""; for d in "$STAGING_DIR"/*; do [ -d "$d" ] && [ -f "$d/package.json" ] && { STAGING_APP="$d"; break; }; done
[ -z "$STAGING_APP" ] && { log ERROR "No app in archive"; write_state "failed" "$EXPECTED_VERSION" "No app in archive"; exit 1; }
log INFO "Installing deps in staging"; cd "$STAGING_APP"
install_staging_dependencies 2>&1 | redact_secrets >> "$LOG_FILE" || { log ERROR "bun install failed (see update.log for lockfile/runtime details)"; write_state "failed" "$EXPECTED_VERSION" "bun install failed (see update.log for lockfile/runtime details)"; exit 1; }
log INFO "Staging ready"

# ---- 7. backup code (pre-stop) ----
write_state "backing_up" "$EXPECTED_VERSION"
BACKUP_TIMESTAMP="$(date +%Y%m%d_%H%M%S)"; BACKUP_PATH="$BACKUP_DIR/backup-${BACKUP_TIMESTAMP}"; mkdir -p "$BACKUP_PATH"
log INFO "Backing up code (pre-stop)"
[ ! -d "$APP_ROOT" ] && { log ERROR "APP_ROOT missing: ${APP_ROOT}"; write_state "failed" "$EXPECTED_VERSION" "APP_ROOT missing"; exit 1; }
mkdir -p "$BACKUP_PATH/code"; rsync -a --exclude '.env' --exclude '.env.local' --exclude 'packages/server/data/' --exclude '.git' --exclude '*.log' "$APP_ROOT/" "$BACKUP_PATH/code/" 2>/dev/null || { log ERROR "Code backup failed"; write_state "failed" "$EXPECTED_VERSION" "Code backup failed"; exit 1; }
snapshot_database || { write_state "failed" "$EXPECTED_VERSION" "DB snapshot failed"; exit 1; }

# ---- 8. stop service ----
log INFO "Stopping ${SERVICE_NAME}"
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl stop "$SERVICE_NAME"; sleep 2
  systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null && { log ERROR "Stop failed"; write_state "failed" "$EXPECTED_VERSION" "Stop failed"; systemctl start "$SERVICE_NAME" 2>/dev/null || true; exit 1; }
  SERVICE_WAS_STOPPED=true
fi
log INFO "Service stopped"

# ---- 9. deploy ----
ROLLBACK_NEEDED=true; log INFO "Deploying"
rsync -a --checksum --delete --exclude '.env' --exclude '.env.local' --exclude 'packages/server/data/' --exclude '.git' --exclude '*.log' "$STAGING_APP/" "$APP_ROOT/" 2>&1 | redact_secrets >> "$LOG_FILE" || { log ERROR "rsync deploy failed"; write_state "failed" "$EXPECTED_VERSION" "rsync failed"; exit 1; }
log INFO "Deploy done"

# ---- 10. start + health ----
write_state "restarting" "$EXPECTED_VERSION"; log INFO "Starting ${SERVICE_NAME}"; systemctl start "$SERVICE_NAME"; sleep 2
systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || { log ERROR "Service did not start"; exit 1; }
PORT="3456"; [ -f "$APP_ROOT/.env" ] && { ep=$(grep -m1 '^AGENT_TRACKER_PORT=' "$APP_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d ' \r'); [ -n "$ep" ] && echo "$ep" | grep -qE '^[0-9]+$' && PORT="$ep"; }
write_state "health_check" "$EXPECTED_VERSION"; log INFO "Health check :${PORT}"
HEALTH_OK=false; i=1; max=$((HEALTH_TIMEOUT / HEALTH_POLL_INTERVAL)); [ "$max" -lt 1 ] && max=1
while [ $i -le $max ]; do
  systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || log WARN "Service inactive"
  RESPONSE=$(curl -sS --max-time 5 "http://localhost:${PORT}/health" 2>/dev/null || echo "")
  if [ -n "$RESPONSE" ]; then
    RESP_VERSION=$("$BUN_BIN" -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).version||'')}catch(e){process.stdout.write('')}" <<< "$RESPONSE" 2>/dev/null || echo "")
    [ "$RESP_VERSION" = "$EXPECTED_VERSION" ] && { log INFO "Health OK: ${RESP_VERSION}"; HEALTH_OK=true; break; }; log INFO "Version mismatch: ${RESP_VERSION:-none}"
  else log INFO "Waiting..."; fi
  i=$((i+1)); sleep "$HEALTH_POLL_INTERVAL"
done
[ "$HEALTH_OK" != "true" ] && { log ERROR "Health check failed"; exit 1; }
verify_database_after_update || { log ERROR "Updated DB verification failed"; exit 1; }

# ---- 11. completed ----
CURRENT_PHASE="completed"; ROLLBACK_NEEDED=false; write_state "completed" "$EXPECTED_VERSION"
log INFO "Update done: ${CURRENT_VERSION:-none} -> ${EXPECTED_VERSION}"
BACKUP_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -type d -name 'backup-*' | wc -l | tr -d ' ')
[ "$BACKUP_COUNT" -gt "$KEEP_BACKUPS" ] && find "$BACKUP_DIR" -maxdepth 1 -type d -name 'backup-*' | sort | head -n $((BACKUP_COUNT - KEEP_BACKUPS)) | while read -r old; do log INFO "Removing old backup: $(basename "$old")"; rm -rf "$old"; done
cleanup_staging; exit 0
