import { readFileSync, writeFileSync, renameSync, accessSync, constants, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FileLogger } from "@agent-tracker/shared";

// ============================================================================
// Manifest schema (schemaVersion 1)
// ============================================================================

export interface UpdateManifest {
  schemaVersion: number;
  version: string;
  publishedAt: string;
  notes: string;
  artifact: {
    url: string;
    sha256: string;
    size?: number;
  };
}

// ============================================================================
// Update state file schema
// ============================================================================

export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "installing"
  | "backing_up"
  | "restarting"
  | "health_check"
  | "completed"
  | "failed"
  | "rolling_back"
  | "rolled_back";

export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

const DEFAULT_STATE: UpdateState = { phase: "idle" };

// ============================================================================
// Semver parsing & comparison
// ============================================================================

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseSemver(v: string): Semver | null {
  const m = v.trim().match(SEMVER_RE);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** 比较两个 prerelease 标识符：数值优先按数字比较，否则字典序 */
function comparePrereleaseId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    return parseInt(a, 10) - parseInt(b, 10);
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}

/**
 * 语义版本比较。
 * 返回: <0 当 a < b, 0 当 a === b, >0 当 a > b
 */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa && !sb) return 0;
  if (!sa) return -1;
  if (!sb) return 1;

  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;

  // prerelease: no prerelease > prerelease
  if (sa.prerelease.length === 0 && sb.prerelease.length === 0) return 0;
  if (sa.prerelease.length === 0) return 1;
  if (sb.prerelease.length === 0) return -1;

  const maxLen = Math.max(sa.prerelease.length, sb.prerelease.length);
  for (let i = 0; i < maxLen; i++) {
    const pa = sa.prerelease[i];
    const pb = sb.prerelease[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const d = comparePrereleaseId(pa, pb);
    if (d !== 0) return d;
  }
  return 0;
}

// ============================================================================
// URL validation (strict, no username/password)
// ============================================================================

const MAX_URL_LENGTH = 2048;

function isValidUpdateUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // 拒绝携带凭据的 URL
  if (parsed.username || parsed.password) return false;
  return true;
}

// ============================================================================
// Manifest validation
// ============================================================================

export interface ManifestValidationError {
  field: string;
  message: string;
}

/** notes 上限 64 KB */
const MAX_NOTES_LENGTH = 65536;

export function validateManifest(data: unknown): { manifest: UpdateManifest } | { errors: ManifestValidationError[] } {
  const errors: ManifestValidationError[] = [];

  if (!data || typeof data !== "object") {
    return { errors: [{ field: "root", message: "Manifest must be a JSON object" }] };
  }
  const m = data as Record<string, unknown>;

  // schemaVersion
  if (m.schemaVersion !== 1) {
    errors.push({ field: "schemaVersion", message: "schemaVersion must be 1" });
  }

  // version
  if (typeof m.version !== "string" || !parseSemver(m.version)) {
    errors.push({ field: "version", message: "version must be a valid semver (x.y.z or x.y.z-prerelease)" });
  }

  // publishedAt
  if (typeof m.publishedAt !== "string" || isNaN(Date.parse(m.publishedAt as string))) {
    errors.push({ field: "publishedAt", message: "publishedAt must be a valid ISO date string" });
  }

  // notes
  if (typeof m.notes !== "string" || (m.notes as string).length > MAX_NOTES_LENGTH) {
    errors.push({ field: "notes", message: `notes must be a string up to ${MAX_NOTES_LENGTH} characters` });
  }

  // artifact
  if (!m.artifact || typeof m.artifact !== "object") {
    errors.push({ field: "artifact", message: "artifact must be an object" });
    return { errors };
  }
  const a = m.artifact as Record<string, unknown>;

  // artifact.url — 严格 new URL 验证
  if (typeof a.url !== "string" || !isValidUpdateUrl(a.url)) {
    errors.push({ field: "artifact.url", message: "artifact.url must be a valid http/https URL without credentials" });
  }

  // artifact.sha256
  if (typeof a.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) {
    errors.push({ field: "artifact.sha256", message: "artifact.sha256 must be a 64-character hex string" });
  }

  // artifact.size (optional)
  if (a.size !== undefined && (typeof a.size !== "number" || a.size < 0 || !Number.isSafeInteger(a.size))) {
    errors.push({ field: "artifact.size", message: "artifact.size must be a non-negative integer" });
  }

  if (errors.length > 0) return { errors };

  return {
    manifest: {
      schemaVersion: m.schemaVersion as number,
      version: m.version as string,
      publishedAt: m.publishedAt as string,
      notes: m.notes as string,
      artifact: {
        url: a.url as string,
        sha256: a.sha256 as string,
        size: typeof a.size === "number" ? a.size : undefined,
      },
    },
  };
}

// ============================================================================
// State file management (node:fs sync, atomic write via temp + renameSync)
// ============================================================================

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** 原子写：先写同目录临时文件，再 renameSync；失败时清理 tmp */
function defaultWriteFile(path: string, content: string): void {
  const tmpPath = `${path}.tmp.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);
  } catch (err: any) {
    // 清理临时文件（best-effort）
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function defaultFileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultFileExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readUpdateState(
  statePath: string,
  readFile: (path: string) => string | null = defaultReadFile,
): UpdateState {
  try {
    const raw = readFile(statePath);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;
    const phase = parsed.phase;
    if (typeof phase !== "string" || !isValidPhase(phase)) return DEFAULT_STATE;
    return {
      phase: phase as UpdatePhase,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

const VALID_PHASES: Set<string> = new Set([
  "idle",
  "downloading",
  "verifying",
  "installing",
  "backing_up",
  "restarting",
  "health_check",
  "completed",
  "failed",
  "rolling_back",
  "rolled_back",
]);

function isValidPhase(phase: string): boolean {
  return VALID_PHASES.has(phase);
}

function writeUpdateState(
  statePath: string,
  state: UpdateState,
  writeFile: (path: string, content: string) => void = defaultWriteFile,
): void {
  writeFile(statePath, JSON.stringify(state, null, 2));
}

// ============================================================================
// In-flight update guard (file-based)
// ============================================================================

const ACTIVE_PHASES: Set<UpdatePhase> = new Set([
  "downloading",
  "verifying",
  "installing",
  "backing_up",
  "restarting",
  "health_check",
  "rolling_back",
]);

// ============================================================================
// In-process single-flight guard
// ============================================================================

let updateInFlight = false;

function acquireUpdateLock(): boolean {
  if (updateInFlight) return false;
  updateInFlight = true;
  return true;
}

function releaseUpdateLock(): void {
  updateInFlight = false;
}

// ============================================================================
// Fetch helpers (injectable)
// ============================================================================

type FetchFn = (url: string, options?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (...args) => fetch(...args);

// ============================================================================
// Manifest fetching
// ============================================================================

export interface ManifestCheckResult {
  enabled: boolean;
  currentVersion: string;
  available: boolean;
  latest?: {
    version: string;
    publishedAt: string;
    notes: string;
    artifactUrl: string;
    sha256: string;
    size?: number;
  };
  status: "idle" | "updating" | "completed" | "failed" | "rolled_back";
  currentPhase?: UpdatePhase;
  currentPhaseVersion?: string;
  currentPhaseError?: string;
  /** 配置类错误 */
  configError?: string;
}

const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
/** 请求体上限 1 MB */
const MAX_RESPONSE_BODY_BYTES = 1_048_576;

async function fetchManifest(
  url: string,
  log: FileLogger,
  fetchFn: FetchFn = defaultFetch,
): Promise<{ manifest: UpdateManifest; error?: undefined } | { manifest?: undefined; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err?.name === "AbortError" ? "Manifest fetch timed out" : `Manifest fetch failed: ${err?.message ?? String(err)}`;
    log.error("[update] fetchManifest error", { error: msg });
    return { error: msg };
  } finally {
    clearTimeout(timer);
  }

  // Content-Length 预检
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > MAX_RESPONSE_BODY_BYTES) {
      return { error: "Manifest response body too large (Content-Length exceeds 1 MB)" };
    }
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err: any) {
    return { error: `Failed to read manifest response: ${err?.message ?? String(err)}` };
  }

  // 实际文本长度检查
  if (text.length > MAX_RESPONSE_BODY_BYTES) {
    return { error: "Manifest response body too large (exceeds 1 MB)" };
  }

  if (!response.ok) {
    return { error: `Manifest fetch returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Manifest response is not valid JSON" };
  }

  const validation = validateManifest(parsed);
  if ("errors" in validation) {
    const detail = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    log.error("[update] manifest validation failed", { errors: validation.errors });
    return { error: `Invalid manifest: ${detail}` };
  }

  return { manifest: validation.manifest };
}

// ============================================================================
// Check for updates
// ============================================================================

export function checkForUpdates(
  enabled: boolean,
  currentVersion: string,
  manifestUrl: string,
  statePath: string,
  log: FileLogger,
  fetchFn?: FetchFn,
  readFile?: (path: string) => string | null,
): Promise<ManifestCheckResult> {
  // 安全默认：disabled 时只返回基本字段
  if (!enabled) {
    return Promise.resolve({
      enabled: false,
      currentVersion,
      available: false,
      status: "idle",
    });
  }

  // enabled=true 但 manifestUrl 为空：返回配置错误
  if (!manifestUrl || !manifestUrl.trim()) {
    return Promise.resolve({
      enabled: true,
      currentVersion,
      available: false,
      status: "idle",
      configError: "Update is enabled but AGENT_TRACKER_UPDATE_MANIFEST_URL is not configured",
    });
  }

  const state = readUpdateState(statePath, readFile);

  // 根据本地状态文件决定当前状态
  let status: ManifestCheckResult["status"] = "idle";
  if (state.phase === "completed") status = "completed";
  else if (state.phase === "failed") status = "failed";
  else if (state.phase === "rolled_back") status = "rolled_back";
  else if (ACTIVE_PHASES.has(state.phase)) status = "updating";

  return fetchManifest(manifestUrl, log, fetchFn).then((result) => {
    if (result.error) {
      log.error("[update] checkForUpdates manifest fetch error", { error: result.error });
      return {
        enabled: true,
        currentVersion,
        available: false,
        status,
        currentPhase: state.phase,
        currentPhaseVersion: state.version,
        currentPhaseError: result.error,
      };
    }

    const m = result.manifest!;
    const cmp = compareVersions(m.version, currentVersion);
    const available = cmp > 0;

    return {
      enabled: true,
      currentVersion,
      available,
      latest: {
        version: m.version,
        publishedAt: m.publishedAt,
        notes: m.notes,
        artifactUrl: m.artifact.url,
        sha256: m.artifact.sha256,
        size: m.artifact.size,
      },
      status,
      currentPhase: state.phase,
      currentPhaseVersion: state.version,
      currentPhaseError: state.error,
    };
  });
}

// ============================================================================
// Get status (read-only, no network)
// ============================================================================

export function getUpdateStatus(
  enabled: boolean,
  currentVersion: string,
  statePath: string,
  readFile?: (path: string) => string | null,
): {
  enabled: boolean;
  currentVersion: string;
  phase: UpdatePhase;
  version?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
} {
  const state = readUpdateState(statePath, readFile);
  return {
    enabled,
    currentVersion,
    phase: state.phase,
    version: state.version,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error,
  };
}

// ============================================================================
// Spawn helpers (injectable)
// ============================================================================

export interface SpawnResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
  /** 为 true 时表示超时而非子进程异常退出 */
  timedOut?: boolean;
}

type SpawnFn = (command: string, args: string[], options?: { timeout?: number }) => Promise<SpawnResult>;

/** stdout/stderr 输出长度上限 */
const MAX_SPAWN_OUTPUT_LENGTH = 4096;

const defaultSpawn: SpawnFn = async (command, args, options) => {
  const timeoutMs = options?.timeout ?? 10_000;
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    // 超时
    if (timedOut) {
      return {
        success: false,
        exitCode: null,
        timedOut: true,
        error: `systemd-run timed out after ${timeoutMs}ms`,
      };
    }

    // 读取输出（带长度上限）
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const stdoutTrim = stdout.length > MAX_SPAWN_OUTPUT_LENGTH ? stdout.slice(0, MAX_SPAWN_OUTPUT_LENGTH) + "…" : stdout;
    const stderrTrim = stderr.length > MAX_SPAWN_OUTPUT_LENGTH ? stderr.slice(0, MAX_SPAWN_OUTPUT_LENGTH) + "…" : stderr;

    return {
      success: exitCode === 0,
      exitCode,
      error: exitCode !== 0 ? (stderrTrim || stdoutTrim || `Exit code ${exitCode}`) : undefined,
    };
  } catch (err: any) {
    return { success: false, exitCode: null, error: err?.message ?? String(err) };
  }
};

// ============================================================================
// Generate safe unit name from semver + timestamp + random suffix
// ============================================================================

function generateUnitName(version: string): string {
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `runmark-update-${safeVersion}-${ts}-${rand}`;
}

// ============================================================================
// Trigger update
// ============================================================================

export interface TriggerUpdateParams {
  /** 用户请求的目标版本 */
  targetVersion: string;
  /** 是否启用更新 */
  enabled: boolean;
  /** 当前服务版本 */
  currentVersion: string;
  /** manifest URL */
  manifestUrl: string;
  /** 更新脚本路径 */
  updateScript: string;
  /** 状态文件路径 */
  statePath: string;
  /** 日志 */
  log: FileLogger;
  /** injectable fetch */
  fetchFn?: FetchFn;
  /** injectable spawn */
  spawnFn?: SpawnFn;
  /** injectable file read */
  readFile?: (path: string) => string | null;
  /** injectable file write */
  writeFile?: (path: string, content: string) => void;
  /** 文件存在检查 */
  fileExists?: (path: string) => boolean;
  /** 文件可执行检查 */
  fileExecutable?: (path: string) => boolean;
  /** injectable platform (for testing non-Linux paths) */
  platform?: typeof process.platform;
}

export async function triggerUpdate(params: TriggerUpdateParams): Promise<
  | { ok: true; phase: UpdatePhase; version: string; message: string }
  | { ok: false; error: string; code: number }
> {
  const {
    targetVersion,
    enabled,
    currentVersion,
    manifestUrl,
    updateScript,
    statePath,
    log,
    fetchFn = defaultFetch,
    spawnFn = defaultSpawn,
    readFile = defaultReadFile,
    writeFile = defaultWriteFile,
    fileExists = defaultFileExists,
    fileExecutable = defaultFileExecutable,
    platform = process.platform,
  } = params;

  if (!enabled) {
    return { ok: false, error: "Update is not enabled (AGENT_TRACKER_UPDATE_ENABLED)", code: 400 };
  }

  // 验证 manifestUrl 配置
  if (!manifestUrl || !manifestUrl.trim()) {
    return { ok: false, error: "Update is enabled but AGENT_TRACKER_UPDATE_MANIFEST_URL is not configured", code: 400 };
  }
  if (!isValidUpdateUrl(manifestUrl)) {
    return { ok: false, error: "Configured manifest URL must be a valid http/https URL without credentials", code: 400 };
  }

  // 进程级单飞锁：防止并发 POST 同时在 fetch await 期间越过状态检查
  if (!acquireUpdateLock()) {
    return { ok: false, error: "Update is already in progress (in-process lock)", code: 409 };
  }

  try {
    // 并发保护：读本地状态（文件级锁由 updater 自身 flock 保证第二层）
    const currentState = readUpdateState(statePath, readFile);
    if (ACTIVE_PHASES.has(currentState.phase)) {
      return {
        ok: false,
        error: `Update is already in progress (phase: ${currentState.phase})`,
        code: 409,
      };
    }

    // Linux only
    if (platform !== "linux") {
      return { ok: false, error: "Update scheduling is only supported on Linux", code: 400 };
    }

    // 验证目标版本格式
    const parsed = parseSemver(targetVersion);
    if (!parsed) {
      return { ok: false, error: `Invalid target version format: ${targetVersion}`, code: 400 };
    }

    // 重新抓 manifest 防 TOCTOU
    const manifestResult = await fetchManifest(manifestUrl, log, fetchFn);
    if (manifestResult.error) {
      return { ok: false, error: `Manifest fetch failed: ${manifestResult.error}`, code: 502 };
    }
    const manifest = manifestResult.manifest!;

    // 版本必须匹配
    if (manifest.version !== targetVersion) {
      return {
        ok: false,
        error: `Manifest version (${manifest.version}) does not match requested version (${targetVersion})`,
        code: 409,
      };
    }

    // 确认目标版本 > 当前版本
    if (compareVersions(targetVersion, currentVersion) <= 0) {
      return {
        ok: false,
        error: `Target version ${targetVersion} is not newer than current version ${currentVersion}`,
        code: 400,
      };
    }

    // 检查更新脚本存在
    if (!fileExists(updateScript)) {
      return {
        ok: false,
        error: `Update script not found: ${updateScript}`,
        code: 500,
      };
    }

    // 检查更新脚本可执行 (X_OK)
    if (!fileExecutable(updateScript)) {
      return {
        ok: false,
        error: `Update script is not executable: ${updateScript}`,
        code: 500,
      };
    }

    // 原子写状态：downloading（保证调度前状态已落盘）
    const updateState: UpdateState = {
      phase: "downloading",
      version: targetVersion,
      startedAt: new Date().toISOString(),
    };
    try {
      writeUpdateState(statePath, updateState, writeFile);
    } catch (err: any) {
      log.error("[update] failed to write initial state", { error: err?.message ?? String(err) });
      return {
        ok: false,
        error: `Failed to write update state: ${err?.message ?? String(err)}`,
        code: 500,
      };
    }

    // 生成安全的 unit 名
    const unitName = generateUnitName(targetVersion);

    // systemd-run 作为 system transient service
    // --collect: 退出后自动清理 transient unit
    // --no-block: 不等待 unit 启动完成，仅确认调度成功
    const spawnResult = await spawnFn("systemd-run", [
      "--collect",
      `--unit=${unitName}`,
      "--property=Type=oneshot",
      "--no-block",
      updateScript,
      "--manifest-url", manifestUrl,
      "--expected-version", targetVersion,
      "--state-file", statePath,
    ]);

    // 调度失败：写 failed 状态（best-effort，失败只记日志不改变上游错误）
    if (!spawnResult.success) {
      const errorState: UpdateState = {
        phase: "failed",
        version: targetVersion,
        startedAt: updateState.startedAt,
        completedAt: new Date().toISOString(),
        error: spawnResult.error,
      };
      try {
        writeUpdateState(statePath, errorState, writeFile);
      } catch (err: any) {
        log.error("[update] failed to write error state", { error: err?.message ?? String(err) });
      }
      const logError = spawnResult.timedOut
        ? "systemd-run timed out"
        : `systemd-run exited with code ${spawnResult.exitCode}`;
      log.error("[update] systemd-run failed", {
        error: logError,
        exitCode: spawnResult.exitCode,
        timedOut: spawnResult.timedOut,
      });
      return {
        ok: false,
        error: spawnResult.timedOut
          ? `systemd-run timed out: ${spawnResult.error}`
          : `systemd-run failed: ${spawnResult.error}`,
        code: 500,
      };
    }

    log.info("[update] systemd-run dispatched", {
      version: targetVersion,
      unit: unitName,
      exitCode: spawnResult.exitCode,
    });

    return {
      ok: true,
      phase: "downloading",
      version: targetVersion,
      message: `Update to ${targetVersion} has been scheduled. The updater script will manage the lifecycle.`,
    };
  } finally {
    // 确保所有路径释放进程锁
    releaseUpdateLock();
  }
}
