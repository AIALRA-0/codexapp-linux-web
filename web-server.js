#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const host = process.env.CODEXAPP_WEB_HOST || "127.0.0.1";
const port = Number(process.env.CODEXAPP_WEB_PORT || 12910);
const appServerPort = Number(process.env.CODEXAPP_APP_SERVER_PORT || 12911);
const webviewDir = path.resolve(process.env.CODEXAPP_WEBVIEW_DIR || path.join(process.cwd(), "webview"));
const codexCli = process.env.CODEXAPP_CODEX_CLI || "codex";
const home = process.env.HOME || os.homedir();
const codexHome = process.env.CODEX_HOME || process.env.CODEXAPP_CODEX_HOME || path.join(home, ".codex");
const stateDir = path.resolve(process.env.CODEXAPP_STATE_DIR || path.join(process.cwd(), "state"));
const browserUploadsRoot = path.join(stateDir, "browser-uploads");
const browserWorkspaceRoot = path.join(stateDir, "browser-workspaces");
const persistedAtomStatePath = path.join(stateDir, "persisted-atoms.json");
const hostStatePath = path.join(stateDir, "host-state.json");
const remoteControlDesiredPath = path.join(stateDir, "remote-control-desired.json");
const debugBridge = process.env.CODEXAPP_DEBUG_BRIDGE === "1";
const bridgePath = "/codexapp-bridge";
const bridgeScriptPath = "/codexapp-web-bridge.js";
const bridgeScriptVersion = process.env.CODEXAPP_BRIDGE_SCRIPT_VERSION || String(Date.now());
const assetPatchVersion = process.env.CODEXAPP_ASSET_PATCH_VERSION || (() => {
  try {
    const stat = fs.statSync(__filename);
    return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return bridgeScriptVersion;
  }
})();
const HOST_METHOD_NOT_HANDLED = Symbol("host-method-not-handled");
const codexPackageJsonPath = process.env.CODEXAPP_CODEX_PACKAGE_JSON || null;
const clientName = process.env.CODEXAPP_CLIENT_NAME || "codex-app-web-gateway";
const appDisplayName = process.env.CODEXAPP_DISPLAY_NAME || "Codex App Web Gateway";
const patchUpdateRequiredGate = process.env.CODEXAPP_PATCH_UPDATE_REQUIRED_GATE !== "0";
const accountProviderBaseUrl = normalizeOptionalUrl(process.env.CODEXAPP_ACCOUNT_PROVIDER_URL);
const accountProviderToken = process.env.CODEXAPP_ACCOUNT_PROVIDER_TOKEN || "";
const autoAccountSwitchEnabled = parseBoolean(process.env.CODEXAPP_AUTO_ACCOUNT_SWITCH, false) && !!accountProviderBaseUrl;
const accountProviderTimeoutMs = numberFromEnv("CODEXAPP_ACCOUNT_PROVIDER_TIMEOUT_MS", 15000, 1000, 120000);
const accountSwitchSettleMs = numberFromEnv("CODEXAPP_ACCOUNT_SWITCH_SETTLE_MS", 1500, 0, 60000);
const accountSwitchMinIntervalMs = numberFromEnv("CODEXAPP_ACCOUNT_SWITCH_MIN_INTERVAL_MS", 15000, 1000, 300000);
const accountSwitchForceReload = parseBoolean(process.env.CODEXAPP_ACCOUNT_SWITCH_FORCE_RELOAD, false);
const accountSwitchRestartDelayMs = numberFromEnv("CODEXAPP_ACCOUNT_SWITCH_RESTART_DELAY_MS", 2500, 0, 30000);
const allowDangerFullAccess = parseBoolean(process.env.CODEXAPP_ALLOW_DANGER_FULL_ACCESS, false);
const configuredAppServerSandboxMode = normalizeOptionalSandboxMode(
  process.env.CODEXAPP_APP_SERVER_SANDBOX_MODE,
  "workspace-write"
);
const appServerSandboxModeOverride = configuredAppServerSandboxMode === "danger-full-access" && !allowDangerFullAccess
  ? "workspace-write"
  : configuredAppServerSandboxMode;
const managedSandboxFallbackMode = appServerSandboxModeOverride || "workspace-write";
const configuredDefaultPermissions = process.env.CODEXAPP_APP_SERVER_DEFAULT_PERMISSIONS || ":workspace";
const appServerDefaultPermissionsOverride = allowDangerFullAccess
  ? null
  : (isDangerFullAccessValue(configuredDefaultPermissions) ? ":workspace" : configuredDefaultPermissions);
const managedHostedAgentMode = process.env.CODEXAPP_SAFE_HOSTED_AGENT_MODE || "custom";
const managedPersistedPermissionsEnabled = parseBoolean(process.env.CODEXAPP_ENFORCE_SAFE_PERSISTED_PERMISSIONS, true);
const managedAppServerCmdNeedles = [
  `--listen ws://127.0.0.1:${appServerPort}`,
  `app-server --listen ws://127.0.0.1:${appServerPort}`,
  `app-server --remote-control --listen ws://127.0.0.1:${appServerPort}`,
];
const externalAppServer = parseBoolean(process.env.CODEXAPP_EXTERNAL_APP_SERVER, false);
const bridgeOrphanRetentionMs = numberFromEnv("CODEXAPP_BRIDGE_ORPHAN_RETENTION_MS", 12 * 60 * 60 * 1000, 30000, 24 * 60 * 60 * 1000);
const bridgeBrowserQueueLimit = numberFromEnv("CODEXAPP_BRIDGE_BROWSER_QUEUE_LIMIT", 2000, 0, 10000);
const bridgeBrowserReplayLimit = numberFromEnv("CODEXAPP_BRIDGE_BROWSER_REPLAY_LIMIT", 5000, 100, 50000);
const bridgeHeartbeatIntervalMs = numberFromEnv("CODEXAPP_BRIDGE_HEARTBEAT_INTERVAL_MS", 15000, 5000, 120000);
const remoteControlKeepaliveIntervalMs = numberFromEnv("CODEXAPP_REMOTE_CONTROL_KEEPALIVE_INTERVAL_MS", 10000, 2000, 120000);
const bridgeBrowserStaleMs = numberFromEnv(
  "CODEXAPP_BRIDGE_BROWSER_STALE_MS",
  Math.max(45000, bridgeHeartbeatIntervalMs * 3),
  15000,
  300000,
);
const startupPrewarmEnabled = parseBoolean(process.env.CODEXAPP_STARTUP_PREWARM, true);
const startupThreadListPrewarmEnabled = parseBoolean(process.env.CODEXAPP_STARTUP_THREAD_LIST_PREWARM, false);
const deviceAuthStartTimeoutMs = numberFromEnv("CODEXAPP_DEVICE_AUTH_START_TIMEOUT_MS", 10000, 1000, 60000);
const deviceAuthSessionTtlMs = numberFromEnv("CODEXAPP_DEVICE_AUTH_SESSION_TTL_MS", 15 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const patchedJavaScriptCacheMaxEntries = numberFromEnv("CODEXAPP_PATCHED_JS_CACHE_MAX_ENTRIES", 2048, 0, 5000);
const patchedJavaScriptPrewarmEnabled = parseBoolean(process.env.CODEXAPP_PATCHED_JS_PREWARM, false);
const patchedJavaScriptPrewarmBatchSize = numberFromEnv("CODEXAPP_PATCHED_JS_PREWARM_BATCH_SIZE", 32, 1, 256);
const staticCompressionEnabled = parseBoolean(process.env.CODEXAPP_STATIC_COMPRESSION, true);
const staticCompressionMinBytes = numberFromEnv("CODEXAPP_STATIC_COMPRESSION_MIN_BYTES", 1024, 0, 1024 * 1024);
const staticCompressionCacheMaxEntries = numberFromEnv("CODEXAPP_STATIC_COMPRESSION_CACHE_MAX_ENTRIES", 2048, 0, 5000);
const sqliteBusyTimeoutMs = numberFromEnv("CODEXAPP_SQLITE_BUSY_TIMEOUT_MS", 5000, 0, 60000);
const terminalSnapshotMaxBytes = numberFromEnv("CODEXAPP_TERMINAL_SNAPSHOT_MAX_BYTES", 120000, 4000, 1000000);
const codexStateDbPath = process.env.CODEXAPP_CODEX_STATE_DB || path.join(codexHome, "state_5.sqlite");
const fastThreadListEnabled = parseBoolean(process.env.CODEXAPP_FAST_THREAD_LIST, true);
const threadTurnsCacheEnabled = parseBoolean(process.env.CODEXAPP_THREAD_TURNS_CACHE, true);
const threadListFirstPageMinLimit = numberFromEnv("CODEXAPP_THREAD_LIST_FIRST_PAGE_MIN_LIMIT", 20, 5, 5000);
const threadListFirstPageMaxLimit = numberFromEnv("CODEXAPP_THREAD_LIST_FIRST_PAGE_MAX_LIMIT", 25, 5, 5000);
const threadListLoadedPriorityLimit = numberFromEnv("CODEXAPP_THREAD_LIST_LOADED_PRIORITY_LIMIT", 20, 0, 200);
const threadTurnsCacheMaxEntries = numberFromEnv("CODEXAPP_THREAD_TURNS_CACHE_MAX_ENTRIES", 200, 10, 2000);
const generatedImageRolloutCacheMaxEntries = numberFromEnv("CODEXAPP_GENERATED_IMAGE_ROLLOUT_CACHE_MAX_ENTRIES", 100, 10, 1000);
const generatedImageInlineMaxBytes = numberFromEnv("CODEXAPP_GENERATED_IMAGE_INLINE_MAX_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024);
const threadLoadedListTimeoutMs = numberFromEnv("CODEXAPP_THREAD_LOADED_LIST_TIMEOUT_MS", 800, 100, 5000);
const threadTurnsPrewarmCount = numberFromEnv("CODEXAPP_THREAD_TURNS_PREWARM_COUNT", 0, 0, 25);
const completeThreadTurnsEnabled = parseBoolean(process.env.CODEXAPP_COMPLETE_THREAD_TURNS, true);
const completeThreadTurnsPageLimit = numberFromEnv("CODEXAPP_THREAD_TURNS_COMPLETE_PAGE_LIMIT", 100, 10, 100);
const completeThreadTurnsMaxTurns = numberFromEnv("CODEXAPP_THREAD_TURNS_COMPLETE_MAX_TURNS", 2000, 100, 10000);
const completeThreadTurnsMaxPages = numberFromEnv("CODEXAPP_THREAD_TURNS_COMPLETE_MAX_PAGES", 100, 1, 500);
const largeThreadFastPathEnabled = parseBoolean(process.env.CODEXAPP_LARGE_THREAD_FAST_PATH, true);
const largeThreadFastPathMinBytes = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_MIN_BYTES", 50 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024);
const largeThreadFastPathChunkBytes = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_CHUNK_BYTES", 1024 * 1024, 128 * 1024, 128 * 1024 * 1024);
const largeThreadFastPathInitialChunkBytes = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_INITIAL_CHUNK_BYTES", 512 * 1024, 128 * 1024, 512 * 1024 * 1024);
const largeThreadFastPathMaxScanBytes = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_MAX_SCAN_BYTES", 4 * 1024 * 1024, 128 * 1024, 128 * 1024 * 1024);
const largeThreadFastPathMaxTurns = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_MAX_TURNS", 8, 1, 5000);
const largeThreadFastPathInitialMaxTurns = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_INITIAL_MAX_TURNS", 8, 1, 5000);
const largeThreadFastPathMaxItemTextBytes = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_MAX_ITEM_TEXT_BYTES", 4096, 1024, 1024 * 1024);
const largeThreadFastPathMaxItemsPerTurn = numberFromEnv("CODEXAPP_LARGE_THREAD_FAST_PATH_MAX_ITEMS_PER_TURN", 8, 2, 100);
const largeThreadStaleInProgressMs = numberFromEnv("CODEXAPP_LARGE_THREAD_STALE_IN_PROGRESS_MS", 2 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const largeThreadFastPathCursorPrefix = "codexapp-large-rollout:";
const largeThreadAppResumeTimeoutMs = numberFromEnv("CODEXAPP_LARGE_THREAD_APP_RESUME_TIMEOUT_MS", 120000, 10000, 600000);
const largeThreadSubmitResumeTimeoutMs = numberFromEnv("CODEXAPP_LARGE_THREAD_SUBMIT_RESUME_TIMEOUT_MS", 8000, 1000, 60000);
const largeThreadPrewarmOnResumeEnabled = parseBoolean(process.env.CODEXAPP_LARGE_THREAD_PREWARM_ON_RESUME, false);
const historyWindowMaxTurns = numberFromEnv("CODEXAPP_HISTORY_WINDOW_MAX_TURNS", 8, 4, 100);
const historyWindowCacheMaxTurns = numberFromEnv("CODEXAPP_HISTORY_WINDOW_CACHE_MAX_TURNS", 32, historyWindowMaxTurns, 500);
const threadTurnsWindowDefaultLimit = numberFromEnv("CODEXAPP_THREAD_TURNS_WINDOW_LIMIT", historyWindowMaxTurns, 4, 100);
const activeTurnWatchdogPageLimit = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_PAGE_LIMIT", Math.max(8, threadTurnsWindowDefaultLimit), 4, 100);
const promptHistorySteerRecoveryEnabled = parseBoolean(process.env.CODEXAPP_PROMPT_HISTORY_STEER_RECOVERY, true);
const promptHistorySteerRecoveryImmediateDelayMs = numberFromEnv("CODEXAPP_PROMPT_HISTORY_STEER_RECOVERY_IMMEDIATE_DELAY_MS", 50, 0, 5000);
const promptHistorySteerRecoveryDelayMs = numberFromEnv("CODEXAPP_PROMPT_HISTORY_STEER_RECOVERY_DELAY_MS", 2000, 250, 15000);
const turnInputSubmissionTtlMs = numberFromEnv("CODEXAPP_TURN_INPUT_SUBMISSION_TTL_MS", 30000, 1000, 300000);
const turnInputCoalesceTtlMs = numberFromEnv("CODEXAPP_TURN_INPUT_COALESCE_TTL_MS", 10 * 60 * 1000, 1000, 30 * 60 * 1000);
const browserTurnSubmitLockMs = numberFromEnv("CODEXAPP_BROWSER_TURN_SUBMIT_LOCK_MS", 10 * 60 * 1000, 1000, 30 * 60 * 1000);
const activeTurnWatchdogEnabled = parseBoolean(process.env.CODEXAPP_ACTIVE_TURN_WATCHDOG, true);
const activeTurnWatchdogFastIntervalMs = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_FAST_MS", 1500, 500, 30000);
const activeTurnWatchdogSlowAfterMs = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_SLOW_AFTER_MS", 30000, 5000, 300000);
const activeTurnWatchdogSlowIntervalMs = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_SLOW_MS", 3000, 1000, 60000);
const activeTurnWatchdogMaxDurationMs = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_MAX_DURATION_MS", 20 * 60 * 1000, 60000, 2 * 60 * 60 * 1000);
const activeTurnWatchdogDoneConfirmations = numberFromEnv("CODEXAPP_ACTIVE_TURN_WATCHDOG_DONE_CONFIRMATIONS", 2, 1, 5);
const ephemeralThreadMemoryTtlMs = numberFromEnv("CODEXAPP_EPHEMERAL_THREAD_MEMORY_TTL_MS", 30 * 60 * 1000, 60000, 24 * 60 * 60 * 1000);
const promptHistoryThreadEligibilityTtlMs = numberFromEnv(
  "CODEXAPP_PROMPT_HISTORY_THREAD_ELIGIBILITY_TTL_MS",
  30 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"],
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function debugLog(...args) {
  if (debugBridge) log("[bridge]", ...args);
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeOptionalSandboxMode(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  if (!normalized || ["0", "false", "none", "off", "disabled"].includes(normalized.toLowerCase())) {
    return null;
  }
  if (["read-only", "workspace-write", "danger-full-access"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readProcText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function procUid(pid) {
  const match = readProcText(`/proc/${pid}/status`).match(/^Uid:\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findManagedAppServerPids(excludePids = []) {
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }

  const exclude = new Set(excludePids.map(Number).filter(Number.isFinite));
  exclude.add(process.pid);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const pids = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (exclude.has(pid)) continue;
    if (currentUid !== null && procUid(pid) !== currentUid) continue;
    const cmdline = readProcText(`/proc/${pid}/cmdline`).replace(/\0/g, " ").trim();
    if (managedAppServerCmdNeedles.some((needle) => cmdline.includes(needle))) pids.push(pid);
  }

  return pids;
}

async function stopManagedAppServerPids(reason, excludePids = []) {
  const pids = findManagedAppServerPids(excludePids);
  if (pids.length === 0) return;

  log("stopping existing codex app-server processes", { reason, pids });
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pids.some(pidAlive)) {
    await delay(100);
  }

  for (const pid of pids) {
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

function sanitizeBridgeClientId(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[A-Za-z0-9._:-]{8,160}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function normalizeOptionalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readJsonObjectFile(filePath, fallback = {}) {
  const value = readJsonFile(filePath, fallback);
  return isPlainObject(value) ? value : fallback;
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "w", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    try {
      const dirFd = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
    return jsonFileSignature(filePath);
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

let persistedAtomState = readJsonObjectFile(persistedAtomStatePath, {});
let persistedAtomStateSignature = jsonFileSignature(persistedAtomStatePath);
let hostState = readJsonObjectFile(hostStatePath, {});
let hostStateSignature = jsonFileSignature(hostStatePath);

function codexPackageJsonCandidates() {
  return uniqueStrings([
    codexPackageJsonPath,
    "/usr/lib/node_modules/@openai/codex/package.json",
    "/usr/local/lib/node_modules/@openai/codex/package.json",
    (() => {
      try {
        return path.join(execFileSync("npm", ["root", "-g"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        }).trim(), "@openai", "codex", "package.json");
      } catch {
        return null;
      }
    })(),
  ]);
}

function readCodexPackageVersion() {
  for (const candidate of codexPackageJsonCandidates()) {
    const version = readJsonFile(candidate, {})?.version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  return null;
}

const codexUiVersion = process.env.CODEXAPP_APP_VERSION
  || readCodexPackageVersion()
  || "0.131.0";

function reloadPersistedAtomStateIfChanged() {
  const signature = jsonFileSignature(persistedAtomStatePath);
  if (signature === persistedAtomStateSignature) return;
  const latest = readJsonObjectFile(persistedAtomStatePath, null);
  if (!isPlainObject(latest)) return;
  persistedAtomState = latest;
  persistedAtomStateSignature = signature;
}

function reloadHostStateIfChanged() {
  const signature = jsonFileSignature(hostStatePath);
  if (signature === hostStateSignature) return;
  const latest = readJsonObjectFile(hostStatePath, null);
  if (!isPlainObject(latest)) return;
  hostState = latest;
  hostStateSignature = signature;
}

function savePersistedAtomState() {
  persistedAtomStateSignature = writeJsonFile(persistedAtomStatePath, persistedAtomState);
}

function saveHostState() {
  hostStateSignature = writeJsonFile(hostStatePath, hostState);
}

function normalizeManagedPermissionAtomValue(key, value) {
  if (!managedPersistedPermissionsEnabled) return { value, changed: false };
  let next = value;
  if (key === "composer-permission-mode-visibility") {
    next = isPlainObject(value)
      ? { ...value, "guardian-approvals": true, "full-access": true }
      : { "guardian-approvals": true, "full-access": true };
  }
  return { value: next, changed: JSON.stringify(next) !== JSON.stringify(value) };
}

function ensureManagedPersistedPermissionState(reason = "runtime") {
  if (!managedPersistedPermissionsEnabled) return { changed: false, enabled: false, reason };
  let changed = false;
  const ensureAtom = (key, fallback) => {
    const current = Object.prototype.hasOwnProperty.call(persistedAtomState, key)
      ? persistedAtomState[key]
      : fallback;
    const normalized = normalizeManagedPermissionAtomValue(key, current);
    if (normalized.changed || !Object.prototype.hasOwnProperty.call(persistedAtomState, key)) {
      persistedAtomState[key] = normalized.value;
      changed = true;
    }
  };
  ensureAtom("composer-permission-mode-visibility", { "guardian-approvals": true, "full-access": true });
  if (changed) savePersistedAtomState();
  return { changed, enabled: true, reason };
}

ensureManagedPersistedPermissionState("startup");

function defaultHostStateValue(key) {
  const defaults = {
    "git-always-force-push": false,
    "git-create-pull-request-as-draft": true,
    "git-pull-request-merge-method": "merge",
    "git-branch-prefix": "codex/",
    "git-commit-instructions": "",
    "git-pr-instructions": "",
    "sidebar-custom-sections": [],
    "sidebar-chat-thread-order": null,
    "sidebar-project-thread-orders": {},
    "sidebar-thread-metadata": {},
    "thread-project-assignments": {},
    "thread-writable-roots": {},
    "thread-workspace-root-hints": {},
    "projectless-thread-ids": [],
    "pinned-thread-ids": [],
    "pinned-project-ids": [],
    "project-order": [],
    "local-projects": {},
    "project-writable-roots": {},
    "project-appearances": {},
    "project-files": {},
    "connection-group-order": [],
    "remote-projects": [],
    "remote-cwds-by-host-and-workspace": {},
    "active-remote-project-id": null,
    "selected-remote-host-id": "local",
    "added-remote-control-env-ids": [],
    "codex-mobile-has-connected-device": false,
    "local_app_server_feature_enablement": { remote_control: false },
    "statsig_default_enable_features": { guardian_approval: true },
    "remote_control_desired_enabled": false,
    "remote_control_connections_state": {
      available: true,
      accessRequired: false,
      authRequired: false,
      clientAuthorized: false,
    },
    "remote_control_connections": [],
    "remote-project-connection-backfill-completed": false,
    "remote-connection-auto-connect-by-host-id": {},
    "remote-connection-analytics-id-by-host-id": {},
    "ambient-suggestions-enabled": true,
    "ia-waiting-on-user-followup-seconds": 1800,
    "hotkey-window-projectless-default-enabled": false,
    "worktree-auto-cleanup-enabled": true,
    "worktree-keep-count": 15,
    "electron-saved-workspace-roots": [],
    "electron-workspace-root-labels": {},
    "active-workspace-roots": [],
    "open-in-target-preferences": {},
    "queued-follow-ups": [],
    "browser-annotation-screenshots-mode": "always",
    "reduced-motion-preference": "system",
    "notifications-turn-mode": "unfocused",
    "notifications-permissions-enabled": true,
    "notifications-questions-enabled": true,
  };
  return Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined;
}

function readHostState(key) {
  reloadHostStateIfChanged();
  return Object.prototype.hasOwnProperty.call(hostState, key) ? hostState[key] : defaultHostStateValue(key);
}

function writeHostState(key, value) {
  reloadHostStateIfChanged();
  if (value === undefined) {
    delete hostState[key];
  } else {
    hostState[key] = value;
  }
  saveHostState();
}

function normalizeSharedObjectSetValue(key, value) {
  if (key === "statsig_default_enable_features" && isPlainObject(value)) {
    return { ...value, guardian_approval: true };
  }
  return value;
}

function readHostSettings() {
  const settings = readHostState("settings");
  return isPlainObject(settings) ? settings : {};
}

function settingKeyName(key) {
  return typeof key === "string" && key.length > 0 ? key : null;
}

function readHostSetting(key) {
  const name = settingKeyName(key);
  if (!name) return undefined;
  return readHostSettings()[name];
}

function writeHostSetting(key, value) {
  const name = settingKeyName(key);
  if (!name) return { success: false };
  const next = { ...readHostSettings() };
  if (value === undefined) {
    delete next[name];
  } else {
    next[name] = value;
  }
  writeHostState("settings", next);
  return { success: true };
}

function appServerConnectionState(params = {}) {
  const hostId = typeof params.hostId === "string" ? params.hostId : null;
  if (!hostId || hostId === "local") {
    return { state: "connected", error: null };
  }
  const connections = [
    ...(Array.isArray(readHostState("remote_control_connections")) ? readHostState("remote_control_connections") : []),
    ...readRemoteSshConnections(),
  ];
  const connection = connections.find((item) => item?.hostId === hostId || item?.envId === hostId);
  return {
    state: connection?.state || (connection?.online ? "connected" : "disconnected"),
    error: connection?.error || null,
  };
}

function openInTargetsResponse(params = {}) {
  const preferences = isPlainObject(readHostState("open-in-target-preferences"))
    ? readHostState("open-in-target-preferences")
    : {};
  const key = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : "default";
  const preferredTarget = typeof preferences[key] === "string"
    ? preferences[key]
    : (typeof preferences.default === "string" ? preferences.default : null);
  return {
    targets: [],
    availableTargets: [],
    preferredTarget,
    mode: "local",
    hasLoadedTargets: true,
  };
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.length > 0))];
}

function readCodexCommandKeymapState() {
  const bindings = readHostState("codex-command-keymap-bindings");
  return {
    bindings: Array.isArray(bindings)
      ? bindings.filter((binding) => binding && typeof binding.command === "string")
      : [],
  };
}

function writeCodexCommandKeybinding(params = {}) {
  const command = typeof params.commandId === "string"
    ? params.commandId
    : (typeof params.command === "string" ? params.command : null);
  if (!command) return readCodexCommandKeymapState();

  const current = readCodexCommandKeymapState().bindings.filter((binding) => binding.command !== command);
  const key = params.key ?? params.keybinding ?? params.hotkey ?? params.binding?.key ?? null;
  if (typeof key === "string" && key.trim().length > 0) {
    current.push({ command, key: key.trim() });
  }
  writeHostState("codex-command-keymap-bindings", current);
  return { bindings: current };
}

function resolveReadableFilePath(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  const raw = input.trim();
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
        path.join(webviewDir, raw),
        path.join(codexHome, raw),
        path.join(home, raw),
      ];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }
  return null;
}

function fileMetadataFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) {
    return { exists: false, isFile: false, isDirectory: false, sizeBytes: null };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.isFile() ? stat.size : null,
    mtimeMs: stat.mtimeMs,
  };
}

function fileBinaryFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) return { contentsBase64: null, mimeType: null, sizeBytes: null };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { contentsBase64: null, mimeType: null, sizeBytes: null };
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = (MIME_TYPES.get(ext) || "application/octet-stream").split(";")[0];
  return {
    contentsBase64: fs.readFileSync(filePath).toString("base64"),
    mimeType,
    sizeBytes: stat.size,
  };
}

function fileTextFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) return { contents: null };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { contents: null };
  return { contents: fs.readFileSync(filePath, "utf8") };
}

function gitOriginForDir(dir) {
  if (typeof dir !== "string" || dir.trim().length === 0) {
    return { dir, root: null, originUrl: null };
  }
  try {
    const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    let originUrl = null;
    try {
      originUrl = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim() || null;
    } catch {}
    return { dir, root, originUrl };
  } catch {
    return { dir, root: null, originUrl: null };
  }
}

function slugifyDirectoryName(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "chat";
}

function projectlessWorkspaceRoot() {
  return path.join(home, "Documents", "Codex");
}

function sanitizePathSegment(value, fallback = "item") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "");
  return (cleaned || fallback).slice(0, 160);
}

function sanitizeRelativeUploadPath(value, fallback = "file") {
  const raw = String(value || fallback || "file")
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "");
  const parts = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part, index) => sanitizePathSegment(part, index === 0 ? "folder" : "file"))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("/") : sanitizePathSegment(fallback, "file");
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueUploadRelativePath(root, relativePath, used) {
  const parsed = path.posix.parse(relativePath.replace(/\\/g, "/"));
  const dir = parsed.dir;
  const ext = parsed.ext;
  const base = parsed.name || "file";
  let candidate = relativePath;
  let suffix = 2;
  while (used.has(candidate) || fs.existsSync(path.join(root, candidate))) {
    candidate = path.posix.join(dir, `${base}-${suffix}${ext}`);
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function browserUploadGroupId(value) {
  const raw = typeof value === "string" ? value : "";
  if (/^[A-Za-z0-9._:-]{6,120}$/.test(raw)) return raw.replace(/[:]/g, "-");
  return crypto.randomUUID();
}

function browserUploadRootFor(params = {}) {
  const groupId = browserUploadGroupId(params.groupId);
  const datePrefix = new Date().toISOString().slice(0, 10);
  if (params.purpose === "workspace") {
    const label = slugifyDirectoryName(params.label || params.projectName || "workspace");
    return path.join(browserWorkspaceRoot, `${datePrefix}-${label}-${groupId.slice(0, 8)}`);
  }
  return path.join(browserUploadsRoot, datePrefix, groupId);
}

function writeBrowserUploadedFiles(params = {}) {
  const files = Array.isArray(params.files) ? params.files : [];
  const root = browserUploadRootFor(params);
  fs.mkdirSync(root, { recursive: true });
  const used = new Set();
  const written = [];

  for (const file of files) {
    if (!isPlainObject(file)) continue;
    const name = sanitizePathSegment(file.name || file.filename || "file", "file");
    const relativePath = uniqueUploadRelativePath(
      root,
      sanitizeRelativeUploadPath(file.relativePath || file.webkitRelativePath || name, name),
      used,
    );
    const targetPath = path.resolve(root, relativePath);
    if (!pathIsInside(root, targetPath)) throw new Error("Invalid upload path");
    const contentsBase64 = typeof file.contentsBase64 === "string" ? file.contentsBase64 : "";
    const buffer = Buffer.from(contentsBase64, "base64");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, targetPath);
    written.push({
      label: name,
      path: targetPath,
      fsPath: targetPath,
      sizeBytes: buffer.length,
      mimeType: typeof file.type === "string" && file.type.length > 0 ? file.type : null,
    });
  }

  return { success: true, root, files: written };
}

function createManagedWorkspaceRoot(params = {}) {
  const projectName = params.projectName || params.name || params.defaultProjectName || "New project";
  const datePrefix = new Date().toISOString().slice(0, 10);
  const baseName = `${datePrefix}-${slugifyDirectoryName(projectName)}`;
  fs.mkdirSync(browserWorkspaceRoot, { recursive: true });
  let root = path.join(browserWorkspaceRoot, baseName);
  let suffix = 2;
  while (fs.existsSync(root)) {
    root = path.join(browserWorkspaceRoot, `${baseName}-${suffix}`);
    suffix += 1;
  }
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    label: String(projectName || "").trim() || path.basename(root),
  };
}

function workspaceRootLabel(root, label = null) {
  const trimmed = typeof label === "string" ? label.trim() : "";
  return trimmed || path.basename(root) || root;
}

function registerWorkspaceRoot(root, options = {}) {
  const normalized = typeof root === "string" && root.length > 0 ? path.resolve(root) : null;
  if (!normalized) return { success: false, error: "missing root" };
  if (options.create !== false) fs.mkdirSync(normalized, { recursive: true });
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) return { success: false, error: "root is not a directory" };
  const label = workspaceRootLabel(normalized, options.label);
  addWorkspaceRootOption(normalized, label, options.setActive === true);
  if (options.picked) {
    broadcastBridgeMessage({ type: "workspace-root-option-picked", root: normalized, label });
  }
  if (options.added !== false) {
    broadcastBridgeMessage({ type: "workspace-root-option-added", root: normalized, label });
  }
  if (options.onboardingResult) {
    broadcastBridgeMessage({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
      root: normalized,
      label,
    });
  }
  return {
    success: true,
    root: normalized,
    label,
    roots: uniqueStrings(readHostState("electron-saved-workspace-roots")),
    labels: readHostState("electron-workspace-root-labels") || {},
  };
}

function updateWorkspaceRootOptions(roots, labels = null) {
  const normalizedRoots = uniqueStrings(roots).map((root) => path.resolve(root));
  writeHostState("electron-saved-workspace-roots", normalizedRoots);
  if (isPlainObject(labels)) {
    const nextLabels = {};
    for (const root of normalizedRoots) {
      const label = labels[root] || labels[path.resolve(root)];
      if (typeof label === "string" && label.trim().length > 0) nextLabels[root] = label.trim();
    }
    writeHostState("electron-workspace-root-labels", nextLabels);
  }
  const activeRoots = uniqueStrings(readHostState("active-workspace-roots")).filter((root) => normalizedRoots.includes(path.resolve(root)));
  writeHostState("active-workspace-roots", activeRoots);
  broadcastBridgeMessage({ type: "workspace-root-options-updated" });
  broadcastBridgeMessage({ type: "active-workspace-roots-updated" });
  return {
    success: true,
    roots: normalizedRoots,
    labels: readHostState("electron-workspace-root-labels") || {},
  };
}

function renameWorkspaceRootOption(root, label) {
  const normalized = typeof root === "string" && root.length > 0 ? path.resolve(root) : null;
  if (!normalized) return { success: false };
  const labels = { ...(readHostState("electron-workspace-root-labels") || {}) };
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (trimmed) labels[normalized] = trimmed;
  else delete labels[normalized];
  writeHostState("electron-workspace-root-labels", labels);
  broadcastBridgeMessage({ type: "workspace-root-options-updated" });
  return { success: true, root: normalized, label: trimmed || null };
}

function addProjectWritableRoot(params = {}) {
  const projectId = typeof params.projectId === "string" && params.projectId.length > 0 ? params.projectId : null;
  const root = typeof params.root === "string" && params.root.length > 0 ? path.resolve(params.root) : null;
  if (!projectId || !root) return { success: false };
  const current = isPlainObject(readHostState("project-writable-roots")) ? readHostState("project-writable-roots") : {};
  const existing = Array.isArray(current[projectId]) ? current[projectId] : [];
  const entry = {
    kind: "local",
    path: root,
    ...(typeof params.label === "string" && params.label.trim().length > 0 ? { label: params.label.trim() } : {}),
  };
  const nextEntries = [
    ...existing.filter((item) => item?.path !== root),
    entry,
  ];
  const next = { ...current, [projectId]: nextEntries };
  writeHostState("project-writable-roots", next);
  broadcastBridgeMessage({ type: "global-state-updated", keys: ["project-writable-roots"] });
  return { success: true, projectWritableRoots: next };
}

function clearProjectWritableRoots(params = {}) {
  const projectId = typeof params.projectId === "string" && params.projectId.length > 0 ? params.projectId : null;
  const root = typeof params.root === "string" && params.root.length > 0 ? path.resolve(params.root) : null;
  const current = isPlainObject(readHostState("project-writable-roots")) ? readHostState("project-writable-roots") : {};
  let next = { ...current };
  if (projectId) {
    if (root) {
      const entries = Array.isArray(next[projectId]) ? next[projectId].filter((item) => item?.path !== root) : [];
      if (entries.length > 0) next[projectId] = entries;
      else delete next[projectId];
    } else {
      delete next[projectId];
    }
  } else if (root) {
    next = Object.fromEntries(Object.entries(next).flatMap(([key, entries]) => {
      const filtered = Array.isArray(entries) ? entries.filter((item) => item?.path !== root) : [];
      return filtered.length > 0 ? [[key, filtered]] : [];
    }));
  } else {
    next = {};
  }
  writeHostState("project-writable-roots", next);
  broadcastBridgeMessage({ type: "global-state-updated", keys: ["project-writable-roots"] });
  return { success: true, projectWritableRoots: next };
}

function createProjectlessWorkspace(params = {}) {
  const workspaceRoot = projectlessWorkspaceRoot();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const requestedName = params.directoryName || params.prompt || "chat";
  const baseName = `${datePrefix}-${slugifyDirectoryName(requestedName)}`;
  fs.mkdirSync(workspaceRoot, { recursive: true });

  let cwd = path.join(workspaceRoot, baseName);
  let suffix = 2;
  while (fs.existsSync(cwd)) {
    cwd = path.join(workspaceRoot, `${baseName}-${suffix}`);
    suffix += 1;
  }
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, outputDirectory: cwd, workspaceRoot };
}

function generateThreadTitle(prompt) {
  const title = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return title || null;
}

function existingPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.filter((item) => {
    if (typeof item !== "string" || item.trim().length === 0) return false;
    try {
      return fs.existsSync(item);
    } catch {
      return false;
    }
  });
}

function sqliteRows(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const output = execFileSync("sqlite3", ["-cmd", `.timeout ${sqliteBusyTimeoutMs}`, "-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: Math.max(10000, sqliteBusyTimeoutMs + 5000),
    }).trim();
    return output ? JSON.parse(output) : [];
  } catch (error) {
    log("sqlite query failed", dbPath, error.message || String(error));
    return [];
  }
}

function sqliteRun(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return false;
  try {
    execFileSync("sqlite3", ["-cmd", `.timeout ${sqliteBusyTimeoutMs}`, dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: Math.max(10000, sqliteBusyTimeoutMs + 5000),
    });
    return true;
  } catch (error) {
    log("sqlite exec failed", dbPath, error.message || String(error));
    return false;
  }
}

function threadRecord(threadId) {
  if (typeof threadId !== "string" || threadId.trim().length === 0) return null;
  const escaped = threadId.replaceAll("'", "''");
  const rows = sqliteRows(codexStateDbPath, `
    SELECT
      id,
      cwd,
      rollout_path,
      title,
      created_at,
      created_at_ms,
      updated_at,
      updated_at_ms,
      source,
      model_provider,
      cli_version,
      first_user_message,
      agent_nickname,
      agent_role,
      git_sha,
      git_branch,
      git_origin_url,
      thread_source,
      preview,
      sandbox_policy,
      approval_mode,
      model,
      reasoning_effort
    FROM threads
    WHERE id = '${escaped}'
    LIMIT 1
  `);
  return rows[0] || null;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fullAccessDbSandboxPolicyJson() {
  return JSON.stringify({ type: "disabled" });
}

function dbSandboxPolicyIsFullAccess(value) {
  if (isDangerFullAccessValue(value)) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return isDangerFullAccessValue(value.type) || value.type === "disabled";
  }
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = JSON.parse(value);
    return isDangerFullAccessValue(parsed?.type) || parsed?.type === "disabled";
  } catch {
    return false;
  }
}

function selectedLocalFullAccessEnabled() {
  return selectedLocalAgentMode() === "full-access";
}

function persistFullAccessThreadPolicy(threadId, reason = "selected-full-access") {
  if (typeof threadId !== "string" || threadId.length === 0) return false;
  const policy = fullAccessDbSandboxPolicyJson();
  const ok = sqliteRun(codexStateDbPath, `
    UPDATE threads
    SET sandbox_policy = ${sqlString(policy)},
        approval_mode = 'never'
    WHERE id = ${sqlString(threadId)}
      AND (sandbox_policy IS NULL OR sandbox_policy != ${sqlString(policy)} OR approval_mode != 'never')
  `);
  if (ok) debugLog("persisted full-access thread policy", { threadId, reason });
  return ok;
}

function threadIdFromParams(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return typeof params.threadId === "string" && params.threadId.length > 0
    ? params.threadId
    : (typeof params.conversationId === "string" && params.conversationId.length > 0 ? params.conversationId : null);
}

function persistSelectedPermissionModeForParams(method, params = {}) {
  if (!selectedLocalFullAccessEnabled()) return false;
  const normalized = String(method || "");
  if (!["thread/read", "thread/resume", "thread/settings/update", "turn/start", "turn/steer"].includes(normalized)) {
    return false;
  }
  const threadId = threadIdFromParams(params);
  return threadId ? persistFullAccessThreadPolicy(threadId, normalized) : false;
}

function truncateUiText(value, maxChars) {
  if (value == null) return value;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeReasoningEffort(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return ["minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : null;
}

function normalizeThreadSettingsUpdate(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return { threadId: null, threadSettings: {} };
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const threadSettings = isPlainObject(params.threadSettings) ? { ...params.threadSettings } : {};
  if (typeof params.model === "string" && params.model.length > 0) threadSettings.model = params.model;
  if (typeof params.modelProvider === "string" && params.modelProvider.length > 0) threadSettings.modelProvider = params.modelProvider;
  const effort = normalizeReasoningEffort(
    params.effort
      ?? params.reasoningEffort
      ?? params.reasoning_effort
      ?? threadSettings.effort
      ?? threadSettings.reasoningEffort
      ?? threadSettings.reasoning_effort
  );
  if (effort) {
    threadSettings.reasoningEffort = effort;
    delete threadSettings.reasoning_effort;
  }
  return { threadId, threadSettings };
}

function largeThreadSettingsUpdateFastPathResponse(params = {}) {
  const { threadId, threadSettings } = normalizeThreadSettingsUpdate(params);
  if (!threadId || !largeThreadFastPathInfo(threadId)) return null;

  const assignments = [];
  if (typeof threadSettings.model === "string" && threadSettings.model.length > 0) {
    assignments.push(`model = ${sqlString(threadSettings.model)}`);
  }
  if (typeof threadSettings.modelProvider === "string" && threadSettings.modelProvider.length > 0) {
    assignments.push(`model_provider = ${sqlString(threadSettings.modelProvider)}`);
  }
  const effort = normalizeReasoningEffort(threadSettings.reasoningEffort);
  if (effort) {
    assignments.push(`reasoning_effort = ${sqlString(effort)}`);
  }
  const wantsFullAccess = selectedLocalFullAccessEnabled()
    || dbSandboxPolicyIsFullAccess(threadSettings.sandboxPolicy)
    || dbSandboxPolicyIsFullAccess(threadSettings.sandbox)
    || isDangerFullAccessValue(threadSettings.sandboxMode)
    || isDangerFullAccessValue(params.sandbox)
    || isDangerFullAccessValue(params.sandboxMode);
  if (wantsFullAccess) {
    assignments.push(`sandbox_policy = ${sqlString(fullAccessDbSandboxPolicyJson())}`);
    assignments.push("approval_mode = 'never'");
  }

  if (assignments.length > 0) {
    const nowMs = Date.now();
    assignments.push(`updated_at = ${Math.floor(nowMs / 1000)}`);
    assignments.push(`updated_at_ms = ${nowMs}`);
    sqliteRun(codexStateDbPath, `UPDATE threads SET ${assignments.join(", ")} WHERE id = ${sqlString(threadId)}`);
  }

  const record = threadRecord(threadId) || {};
  return {
    success: true,
    threadId,
    model: record.model || threadSettings.model || null,
    modelProvider: record.model_provider || threadSettings.modelProvider || null,
    reasoningEffort: record.reasoning_effort || effort || null,
  };
}

function isoFromEpochMilliseconds(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function epochSecondsFromRow(row, key) {
  if (!row || typeof row !== "object") return 0;
  const milliseconds = Number(row[`${key}_ms`]);
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds / 1000;
  const seconds = Number(row[key]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function threadListSources(params = {}) {
  const requested = Array.isArray(params.sourceKinds)
    ? params.sourceKinds.filter((item) => typeof item === "string")
    : [];
  return requested.length > 0 ? uniqueStrings(requested) : null;
}

function threadListRowToThread(row, loadedThreadIds = new Set()) {
  const gitInfo = row.git_sha || row.git_branch || row.git_origin_url
    ? {
        sha: row.git_sha || null,
        branch: row.git_branch || null,
        originUrl: row.git_origin_url || null,
      }
    : null;
  return {
    id: row.id,
    sessionId: row.id,
    forkedFromId: null,
    preview: truncateUiText(row.preview || row.first_user_message || "", 500),
    ephemeral: false,
    modelProvider: row.model_provider || null,
    createdAt: epochSecondsFromRow(row, "created_at") || (Number(row.created_ms) / 1000) || 0,
    updatedAt: epochSecondsFromRow(row, "updated_at") || (Number(row.updated_ms) / 1000) || 0,
    status: { type: loadedThreadIds.has(row.id) ? "idle" : "notLoaded" },
    path: row.rollout_path,
    cwd: row.cwd,
    cliVersion: row.cli_version || null,
    source: row.source,
    threadSource: row.thread_source || null,
    agentNickname: row.agent_nickname || null,
    agentRole: row.agent_role || null,
    gitInfo,
    name: truncateUiText(row.title || null, 160),
    turns: [],
  };
}

function fastThreadListFromDb(params = {}, loadedThreadIds = new Set()) {
  if (!fastThreadListEnabled || !fs.existsSync(codexStateDbPath)) return null;
  if (params.archived === true) return null;
  const sources = threadListSources(params);

  const sortKey = params.sortKey === "created_at" ? "created_at" : "updated_at";
  const createdMillisExpr = "COALESCE(created_at_ms, created_at * 1000)";
  const updatedMillisExpr = "COALESCE(updated_at_ms, updated_at * 1000)";
  const millisExpr = sortKey === "created_at" ? createdMillisExpr : updatedMillisExpr;
  const defaultLimit = Math.max(1, Math.min(threadListFirstPageMinLimit, 1000));
  const requestedLimit = Math.max(1, Math.min(Number.parseInt(String(params.limit || defaultLimit), 10) || defaultLimit, 1000));
  const firstPageLowerLimit = Math.min(threadListFirstPageMinLimit, threadListFirstPageMaxLimit);
  const firstPageUpperLimit = Math.max(threadListFirstPageMinLimit, threadListFirstPageMaxLimit);
  const limit = params.cursor
    ? requestedLimit
    : Math.max(firstPageLowerLimit, Math.min(requestedLimit, firstPageUpperLimit));
  const archived = 0;
  const where = [
    `archived = ${archived}`,
  ];
  if (sources && sources.length > 0) {
    where.push(`source IN (${sources.map(sqlString).join(", ")})`);
  }

  if (Array.isArray(params.modelProviders) && params.modelProviders.length > 0) {
    const providers = params.modelProviders
      .filter((item) => typeof item === "string" && item.length > 0)
      .map(sqlString);
    if (providers.length > 0) where.push(`model_provider IN (${providers.join(", ")})`);
  }

  const cursorMs = Date.parse(String(params.cursor || ""));
  if (Number.isFinite(cursorMs)) where.push(`${millisExpr} < ${cursorMs}`);

  const rows = sqliteRows(codexStateDbPath, `
    SELECT
      id,
      rollout_path,
      created_at,
      created_at_ms,
      updated_at,
      updated_at_ms,
      source,
      model_provider,
      cwd,
      title,
      cli_version,
      first_user_message,
      agent_nickname,
      agent_role,
      git_sha,
      git_branch,
      git_origin_url,
      thread_source,
      preview,
      ${createdMillisExpr} AS created_ms,
      ${updatedMillisExpr} AS updated_ms,
      ${millisExpr} AS sort_ms
    FROM threads
    WHERE ${where.join(" AND ")}
    ORDER BY ${millisExpr} DESC, id DESC
    LIMIT ${limit + 1}
  `);
  if (!Array.isArray(rows)) return null;

  const pageRows = rows.slice(0, limit);
  let loadedPriorityRows = [];
  if (!params.cursor && threadListLoadedPriorityLimit > 0 && loadedThreadIds instanceof Set && loadedThreadIds.size > 0) {
    const loadedIds = Array.from(loadedThreadIds)
      .filter((id) => typeof id === "string" && id.length > 0)
      .slice(0, threadListLoadedPriorityLimit * 4)
      .map(sqlString);
    if (loadedIds.length > 0) {
      loadedPriorityRows = sqliteRows(codexStateDbPath, `
        SELECT
          id,
          rollout_path,
          created_at,
          created_at_ms,
          updated_at,
          updated_at_ms,
          source,
          model_provider,
          cwd,
          title,
          cli_version,
          first_user_message,
          agent_nickname,
          agent_role,
          git_sha,
          git_branch,
          git_origin_url,
          thread_source,
          preview,
          ${createdMillisExpr} AS created_ms,
          ${updatedMillisExpr} AS updated_ms,
          ${millisExpr} AS sort_ms
        FROM threads
        WHERE ${where.join(" AND ")} AND id IN (${loadedIds.join(", ")})
        ORDER BY ${millisExpr} DESC, id DESC
        LIMIT ${threadListLoadedPriorityLimit}
      `);
    }
  }
  const mergedRows = [];
  const seenThreadIds = new Set();
  for (const row of [...loadedPriorityRows, ...pageRows]) {
    if (!row?.id || seenThreadIds.has(row.id)) continue;
    seenThreadIds.add(row.id);
    mergedRows.push(row);
  }
  const data = mergedRows.map((row) => threadListRowToThread(row, loadedThreadIds));
  const cursorBasis = pageRows.length > 0 ? pageRows : mergedRows;

  return {
    data,
    nextCursor: rows.length > limit ? isoFromEpochMilliseconds(pageRows[pageRows.length - 1]?.sort_ms) : null,
    backwardsCursor: isoFromEpochMilliseconds(cursorBasis[0]?.sort_ms),
  };
}

function canonicalizeThreadListProjectCwds(result) {
  if (!result || !Array.isArray(result.data)) return result;
  const assignments = readHostState("thread-project-assignments") || {};
  let changed = false;
  const data = result.data.map((thread) => {
    if (!thread || typeof thread !== "object") return thread;
    const threadId = typeof thread.id === "string" ? thread.id : (typeof thread.sessionId === "string" ? thread.sessionId : null);
    const assignedRoot = threadId ? assignments[threadId] : null;
    if (typeof assignedRoot !== "string" || assignedRoot.length === 0 || thread.cwd === assignedRoot) return thread;
    changed = true;
    return { ...thread, cwd: assignedRoot };
  });
  return changed ? { ...result, data } : result;
}

function canonicalizeThreadReadResult(result) {
  const thread = result?.thread;
  if (!thread || typeof thread !== "object") return result;
  const threadId = typeof thread.id === "string"
    ? thread.id
    : (typeof thread.sessionId === "string" ? thread.sessionId : null);
  if (!threadId) return result;

  const record = threadRecord(threadId);
  if (!record) return result;

  const assignments = readHostState("thread-project-assignments") || {};
  const assignedRoot = typeof assignments[threadId] === "string" && assignments[threadId].length > 0
    ? assignments[threadId]
    : null;
  const createdAt = epochSecondsFromRow(record, "created_at");
  const updatedAt = epochSecondsFromRow(record, "updated_at");
  const nextThread = {
    ...thread,
    ...(record.rollout_path ? { path: record.rollout_path } : {}),
    ...(record.cwd || assignedRoot ? { cwd: assignedRoot || record.cwd } : {}),
    ...(createdAt > 0 ? { createdAt } : {}),
    ...(updatedAt > 0 ? { updatedAt } : {}),
    ...(!thread.name && record.title ? { name: record.title } : {}),
  };
  if (Array.isArray(nextThread.turns)) {
    nextThread.turns = normalizeThreadTurnsResult({ data: nextThread.turns }, { threadId }).data;
  }
  return { ...result, thread: nextThread };
}

const threadTurnsCache = new Map();
const threadTurnsInflightPrewarm = new Map();
const generatedImageRolloutCache = new Map();

function hasVisibleTurnItems(turn) {
  return Array.isArray(turn?.items) && turn.items.length > 0;
}

function rolloutInfoForThread(threadId) {
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  const record = threadRecord(threadId);
  if (!record?.rollout_path) return null;
  const rolloutPath = path.resolve(record.rollout_path);
  const sessionsRoot = path.resolve(codexHome, "sessions");
  const sessionsRootWithSeparator = sessionsRoot.endsWith(path.sep) ? sessionsRoot : `${sessionsRoot}${path.sep}`;
  if (rolloutPath !== sessionsRoot && !rolloutPath.startsWith(sessionsRootWithSeparator)) return null;
  const signature = threadTurnsCacheFileSignature(rolloutPath);
  if (!signature) return null;
  return { threadId, rolloutPath, signature };
}

function largeThreadFastPathInfo(threadId) {
  if (!largeThreadFastPathEnabled) return null;
  const info = rolloutInfoForThread(threadId);
  if (!info) return null;
  const size = Number(String(info.signature).split(":")[0]);
  if (!Number.isFinite(size) || size < largeThreadFastPathMinBytes) return null;
  return { ...info, size };
}

function largeThreadCursorEndOffset(cursor, size) {
  if (cursor == null) return size;
  if (typeof cursor !== "string" || !cursor.startsWith(largeThreadFastPathCursorPrefix)) return null;
  const offset = Number.parseInt(cursor.slice(largeThreadFastPathCursorPrefix.length), 10);
  if (!Number.isFinite(offset) || offset <= 0) return null;
  return Math.min(offset, size);
}

function readLargeRolloutChunk(rolloutPath, endOffset, chunkBytes = largeThreadFastPathChunkBytes) {
  const end = Math.max(0, Number(endOffset) || 0);
  const requestedBytes = Number.isFinite(Number(chunkBytes)) && Number(chunkBytes) > 0
    ? Number(chunkBytes)
    : largeThreadFastPathChunkBytes;
  const start = Math.max(0, end - requestedBytes);
  const length = Math.max(0, end - start);
  if (length === 0) return { start, end, lines: [] };
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(rolloutPath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf8");
  let lineBaseOffset = start;
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) {
      lineBaseOffset += Buffer.byteLength(text.slice(0, firstNewline + 1), "utf8");
      text = text.slice(firstNewline + 1);
    } else {
      text = "";
    }
  }
  const entries = [];
  let relativeOffset = 0;
  for (const rawLine of text.split("\n")) {
    const lineOffset = lineBaseOffset + relativeOffset;
    relativeOffset += Buffer.byteLength(rawLine, "utf8") + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line) entries.push({ line, offset: lineOffset });
  }
  return { start, end, lines: entries.map((entry) => entry.line), entries };
}

function epochSecondsFromRolloutTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
}

function truncateLargeThreadText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= largeThreadFastPathMaxItemTextBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  const tail = bytes.subarray(Math.max(0, bytes.length - largeThreadFastPathMaxItemTextBytes)).toString("utf8");
  return `[truncated earlier large thread item]\n\n${tail}`;
}

function textFromRolloutContent(content, maxChars = largeThreadFastPathMaxItemTextBytes * 2) {
  if (typeof content === "string") return content.length > maxChars ? content.slice(0, maxChars) : content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  let remaining = Math.max(0, Number(maxChars) || 0);
  const append = (text) => {
    if (typeof text !== "string" || text.length === 0 || remaining <= 0) return;
    const next = text.length > remaining ? text.slice(0, remaining) : text;
    parts.push(next);
    remaining -= next.length;
  };
  for (const part of content) {
    if (remaining <= 0) break;
    if (typeof part === "string") {
      append(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      append(part.text);
    } else if (typeof part.message === "string") {
      append(part.message);
    } else if (Array.isArray(part.content)) {
      append(textFromRolloutContent(part.content, remaining));
    }
  }
  return parts.join("\n");
}

function largeThreadItemId(turn) {
  return `item-${Array.isArray(turn.items) ? turn.items.length + 1 : 1}`;
}

function makeLargeThreadUserItem(turn, payload) {
  const text = truncateLargeThreadText(payload.message ?? textFromRolloutContent(payload.content));
  if (!text.trim()) return null;
  return {
    type: "userMessage",
    id: largeThreadItemId(turn),
    clientId: typeof payload.client_id === "string" ? payload.client_id : null,
    content: [{ type: "text", text, text_elements: Array.isArray(payload.text_elements) ? payload.text_elements : [] }],
  };
}

function makeLargeThreadAgentItem(turn, payload, fallbackPhase = "commentary") {
  const text = truncateLargeThreadText(payload.message ?? textFromRolloutContent(payload.content));
  if (!text.trim()) return null;
  return {
    type: "agentMessage",
    id: largeThreadItemId(turn),
    text,
    phase: typeof payload.phase === "string" ? payload.phase : fallbackPhase,
    memoryCitation: payload.memory_citation ?? null,
  };
}

function pushLargeThreadItem(turn, item) {
  if (!turn || !item) return;
  if (item.type === "agentMessage") {
    const previous = turn.items[turn.items.length - 1];
    if (previous?.type === "agentMessage"
      && previous.phase === item.phase
      && previous.memoryCitation == null
      && item.memoryCitation == null) {
      const mergedText = `${previous.text || ""}\n\n${item.text || ""}`;
      if (Buffer.byteLength(mergedText, "utf8") <= largeThreadFastPathMaxItemTextBytes) {
        previous.text = mergedText;
        return;
      }
    }
  }
  turn.items.push(item);
}

function compactLargeThreadTurnItems(turn) {
  if (!turn || !Array.isArray(turn.items) || turn.items.length <= largeThreadFastPathMaxItemsPerTurn) return;
  const originalItems = turn.items;
  const firstUser = originalItems.find((item) => item?.type === "userMessage") || null;
  const tailBudget = firstUser ? Math.max(0, largeThreadFastPathMaxItemsPerTurn - 2) : Math.max(1, largeThreadFastPathMaxItemsPerTurn - 1);
  const tail = originalItems.slice(-tailBudget);
  const kept = [];
  if (firstUser && !tail.includes(firstUser)) kept.push(firstUser);
  const truncatedCount = Math.max(0, originalItems.length - tail.length - kept.length);
  if (truncatedCount > 0) {
    kept.push({
      type: "agentMessage",
      id: `large-thread-truncated-${originalItems.length}`,
      text: `[truncated ${truncatedCount} older large thread items]`,
      phase: "commentary",
      memoryCitation: null,
    });
  }
  kept.push(...tail);
  turn.items = kept.slice(-largeThreadFastPathMaxItemsPerTurn);
  if (firstUser && !turn.items.includes(firstUser)) {
    turn.items = [firstUser, ...turn.items.slice(-(largeThreadFastPathMaxItemsPerTurn - 1))];
  }
}

function largeThreadHasAgentMessage(turn, text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!turn || !normalized) return false;
  return turn.items.some((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim() === normalized);
}

function largeThreadSetTurnOffset(turn, offset) {
  const numeric = Number(offset);
  if (!turn || !Number.isFinite(numeric) || numeric < 0) return;
  const current = Number(turn._rolloutStartOffset);
  if (Number.isFinite(current) && current <= numeric) return;
  Object.defineProperty(turn, "_rolloutStartOffset", {
    value: numeric,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function largeThreadSetTurnLastEventAt(turn, timestampSeconds) {
  const numeric = Number(timestampSeconds);
  if (!turn || !Number.isFinite(numeric) || numeric <= 0) return;
  const current = Number(turn._rolloutLastEventAt);
  if (Number.isFinite(current) && current >= numeric) return;
  Object.defineProperty(turn, "_rolloutLastEventAt", {
    value: numeric,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function markLargeThreadStaleInProgress(turn) {
  if (!turn || turn.status !== "inProgress" || largeThreadStaleInProgressMs <= 0) return;
  const lastEventAt = Number(turn._rolloutLastEventAt || turn.completedAt || turn.startedAt);
  if (!Number.isFinite(lastEventAt) || lastEventAt <= 0) return;
  const staleMs = Date.now() - (lastEventAt * 1000);
  if (staleMs < largeThreadStaleInProgressMs) return;
  turn.status = "interrupted";
  turn.completedAt = lastEventAt;
  if (turn.startedAt && !turn.durationMs) {
    turn.durationMs = Math.max(0, Math.round((lastEventAt - turn.startedAt) * 1000));
  }
}

function largeThreadTurnStartOffset(turn) {
  const offset = Number(turn?._rolloutStartOffset);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

function parseLargeRolloutTurns(lines, chunkStart) {
  const turns = [];
  let current = null;
  let syntheticIndex = 0;

  const finishCurrent = () => {
    if (!current) return;
    markLargeThreadStaleInProgress(current);
    compactLargeThreadTurnItems(current);
    if (current.items.length > 0) turns.push(current);
    current = null;
  };

  const ensureTurn = (turnId, timestampSeconds = 0, startOffset = null) => {
    if (turnId && current && current.id !== turnId && current.items.length > 0) finishCurrent();
    if (!current) {
      syntheticIndex += 1;
      const startedAt = timestampSeconds || 0;
      current = {
        id: turnId || `large-${chunkStart}-${syntheticIndex}`,
        turnId: turnId || null,
        params: { cwd: null },
        items: [],
        itemsView: "summary",
        status: "inProgress",
        error: null,
        startedAt,
        completedAt: null,
        durationMs: null,
      };
      largeThreadSetTurnOffset(current, startOffset);
    }
    largeThreadSetTurnOffset(current, startOffset);
    if (turnId && String(current.id).startsWith("large-")) current.id = turnId;
    if (turnId && !current.turnId) current.turnId = turnId;
    if (timestampSeconds && !current.startedAt) current.startedAt = timestampSeconds;
    largeThreadSetTurnLastEventAt(current, timestampSeconds);
    return current;
  };

  for (const entry of lines) {
    const line = typeof entry === "string" ? entry : entry?.line;
    if (typeof line !== "string" || line.length === 0) continue;
    const lineOffset = typeof entry === "string" ? null : entry?.offset;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = epochSecondsFromRolloutTimestamp(event.timestamp);
    if (current && timestamp) largeThreadSetTurnLastEventAt(current, timestamp);
    if (event?.type === "response_item") continue;
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const type = payload.type || event.type;
    if (type === "task_started") {
      finishCurrent();
      current = ensureTurn(payload.turn_id, Number(payload.started_at) || timestamp, lineOffset);
      continue;
    }
    if (type === "turn_context") {
      current = ensureTurn(payload.turn_id, timestamp, lineOffset);
      continue;
    }
    if (type === "user_message") {
      const turn = ensureTurn(null, timestamp, lineOffset);
      pushLargeThreadItem(turn, makeLargeThreadUserItem(turn, payload));
      continue;
    }
    if (type === "message") {
      const turn = ensureTurn(null, timestamp, lineOffset);
      if (payload.role === "user") {
        pushLargeThreadItem(turn, makeLargeThreadUserItem(turn, payload));
      } else if (payload.role === "assistant") {
        pushLargeThreadItem(turn, makeLargeThreadAgentItem(turn, payload));
      }
      continue;
    }
    if (type === "agent_message") {
      const turn = ensureTurn(null, timestamp, lineOffset);
      pushLargeThreadItem(turn, makeLargeThreadAgentItem(turn, payload));
      continue;
    }
    if (type === "task_complete") {
      const turn = ensureTurn(payload.turn_id, timestamp, lineOffset);
      if (payload.last_agent_message && !largeThreadHasAgentMessage(turn, payload.last_agent_message)) {
        pushLargeThreadItem(turn, makeLargeThreadAgentItem(turn, {
          message: payload.last_agent_message,
          phase: "final_answer",
          memory_citation: null,
        }, "final_answer"));
      }
      turn.status = "completed";
      turn.completedAt = Number(payload.completed_at) || timestamp || null;
      turn.durationMs = Number(payload.duration_ms) || null;
      finishCurrent();
      continue;
    }
    if (type === "turn_aborted") {
      const turn = ensureTurn(payload.turn_id, timestamp, lineOffset);
      turn.status = "interrupted";
      turn.completedAt = Number(payload.completed_at) || timestamp || null;
      turn.durationMs = Number(payload.duration_ms) || null;
      finishCurrent();
    }
  }
  finishCurrent();

  for (let index = 0; index < turns.length - 1; index += 1) {
    if (turns[index].status === "inProgress") turns[index].status = "completed";
  }
  return turns;
}

function largeThreadRequestedTurnLimit(params = {}, fallback) {
  const candidate = Number.parseInt(String(params.limit ?? params.initialTurnsPage?.limit ?? ""), 10);
  if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
  const configured = Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : historyWindowMaxTurns;
  return Math.max(1, Math.min(configured, candidate));
}

function largeThreadTurnsFastPathPage(params = {}) {
  if (!params || typeof params.threadId !== "string" || params.threadId.length === 0) return null;
  const info = largeThreadFastPathInfo(params.threadId);
  if (!info) return null;
  const endOffset = largeThreadCursorEndOffset(params.cursor, info.size);
  if (endOffset == null) return null;
  const isInitialPage = params.cursor == null;
  const chunkBytes = isInitialPage ? largeThreadFastPathInitialChunkBytes : largeThreadFastPathChunkBytes;
  const configuredMaxTurns = isInitialPage ? largeThreadFastPathInitialMaxTurns : largeThreadFastPathMaxTurns;
  const maxTurns = largeThreadRequestedTurnLimit(params, configuredMaxTurns);
  const maxScanBytes = Math.max(chunkBytes, largeThreadFastPathMaxScanBytes);
  let nextEndOffset = endOffset;
  let scannedBytes = 0;
  let chunk = null;
  let entries = [];
  let parsedTurns = [];
  while (nextEndOffset > 0 && scannedBytes < maxScanBytes) {
    chunk = readLargeRolloutChunk(info.rolloutPath, nextEndOffset, chunkBytes);
    const chunkEntries = chunk.entries || [];
    entries = [...chunkEntries, ...entries];
    scannedBytes += Math.max(0, chunk.end - chunk.start);
    const parseStart = entries[0]?.offset ?? chunk.start;
    parsedTurns = parseLargeRolloutTurns(entries, parseStart);
    if (parsedTurns.length >= maxTurns || chunk.start <= 0) break;
    if (chunk.start >= nextEndOffset) break;
    nextEndOffset = chunk.start;
  }
  if (!chunk) return null;
  const turns = parsedTurns.length > maxTurns ? parsedTurns.slice(-maxTurns) : parsedTurns;
  let nextOffset = chunk.start;
  if (parsedTurns.length > turns.length) {
    const oldestReturnedOffset = largeThreadTurnStartOffset(turns[0]);
    if (oldestReturnedOffset != null && oldestReturnedOffset > chunk.start && oldestReturnedOffset < endOffset) {
      nextOffset = oldestReturnedOffset;
    }
  }
  const nextCursor = nextOffset > 0 ? `${largeThreadFastPathCursorPrefix}${nextOffset}` : null;
  return { turns, nextCursor, chunk };
}

function largeThreadTurnsFastPathResponse(params = {}) {
  const page = largeThreadTurnsFastPathPage(params);
  if (!page) return null;
  return {
    data: page.turns.slice().reverse(),
    nextCursor: page.nextCursor,
    backwardsCursor: page.nextCursor,
  };
}

function largeThreadInitialTurnsPageFromPage(page = null) {
  if (!page || !Array.isArray(page.turns)) return null;
  return {
    data: page.turns.slice().reverse(),
    nextCursor: page.nextCursor,
    backwardsCursor: page.nextCursor,
  };
}

function largeThreadTurnsPaginationFromPage(page = null) {
  const turns = Array.isArray(page?.turns) ? page.turns : [];
  const olderCursor = page?.nextCursor ?? null;
  const oldestTurn = turns.find((turn) => typeof turn?.id === "string" && turn.id.length > 0);
  return {
    olderCursor,
    oldestLoadedTurnId: oldestTurn?.id ?? null,
    isLoadingOlder: false,
    hasLoadedOldest: olderCursor == null,
  };
}

function largeThreadReadFastPathResponse(params = {}, turnsPage = null) {
  if (!params || typeof params.threadId !== "string" || params.threadId.length === 0) return null;
  const info = largeThreadFastPathInfo(params.threadId);
  if (!info) return null;
  const record = threadRecord(params.threadId);
  if (!record) return null;
  const createdAt = epochSecondsFromRow(record, "created_at");
  const updatedAt = epochSecondsFromRow(record, "updated_at");
  const page = turnsPage || largeThreadTurnsFastPathPage({ ...params, cursor: null });
  const turns = Array.isArray(page?.turns) ? page.turns : [];
  const runtimeSettings = largeThreadRuntimeSettings(record);
  const currentPermissions = {
    approvalPolicy: runtimeSettings.approvalPolicy,
    approvalsReviewer: runtimeSettings.approvalsReviewer,
    sandboxPolicy: runtimeSettings.sandbox,
  };
  return {
    thread: {
      id: params.threadId,
      sessionId: params.threadId,
      forkedFromId: null,
      parentThreadId: null,
      hostId: "local",
      preview: truncateUiText(record.preview || record.first_user_message || record.title || "", 500),
      ephemeral: false,
      modelProvider: record.model_provider || "",
      createdAt,
      updatedAt,
      status: { type: "idle" },
      threadRuntimeStatus: { type: "idle" },
      path: record.rollout_path,
      rolloutPath: record.rollout_path,
      cwd: record.cwd || "",
      cliVersion: record.cli_version || "",
      source: record.source || "",
      threadSource: record.thread_source || record.source || "",
      agentNickname: record.agent_nickname ?? null,
      agentRole: record.agent_role ?? null,
      gitInfo: {
        sha: record.git_sha || null,
        branch: record.git_branch || null,
        originUrl: record.git_origin_url || null,
      },
      name: truncateUiText(record.title || "", 240),
      title: truncateUiText(record.title || "", 240),
      turns,
      requests: [],
      resumeState: "resumed",
      latestModel: runtimeSettings.model,
      latestReasoningEffort: runtimeSettings.reasoningEffort,
      previousTurnModel: null,
      latestCollaborationMode: {
        mode: "default",
        settings: {
          reasoning_effort: runtimeSettings.reasoningEffort,
          model: runtimeSettings.model,
          developer_instructions: null,
        },
      },
      hasUnreadTurn: false,
      threadGoal: null,
      latestTokenUsageInfo: null,
      workspaceKind: "project",
      workspaceBrowserRoot: null,
      projectlessOutputDirectory: null,
      turnsPagination: largeThreadTurnsPaginationFromPage(page),
      currentPermissions,
      latestThreadSettings: {
        cwd: record.cwd || "",
        approvalPolicy: currentPermissions.approvalPolicy,
        approvalsReviewer: currentPermissions.approvalsReviewer,
        sandboxPolicy: currentPermissions.sandboxPolicy,
        permissions: null,
        model: runtimeSettings.model,
        serviceTier: runtimeSettings.serviceTier,
        effort: runtimeSettings.reasoningEffort,
        collaborationMode: {
          mode: "default",
          settings: {
            reasoning_effort: runtimeSettings.reasoningEffort,
            model: runtimeSettings.model,
            developer_instructions: null,
          },
        },
        activePermissionProfile: runtimeSettings.activePermissionProfile,
      },
    },
    initialTurnsPage: largeThreadInitialTurnsPageFromPage(page),
  };
}

function largeThreadStatusFastPathResponse(params = {}) {
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const info = largeThreadFastPathInfo(threadId);
  if (!info) return null;
  const record = threadRecord(threadId);
  if (!record) return null;
  const page = largeThreadTurnsFastPathPage({ threadId, cursor: null, limit: Math.min(5, historyWindowMaxTurns) });
  const turns = Array.isArray(page?.turns) ? page.turns : [];
  const latestTurn = turns.at(-1) || null;
  const running = turns.some((turn) => turn?.status === "inProgress");
  const login = codexLoginStatus();
  return {
    threadId,
    status: { type: running ? "inProgress" : "idle" },
    running,
    queue: { state: "idle" },
    updatedAt: epochSecondsFromRow(record, "updated_at") ?? Date.now(),
    waiting: {
      permission: false,
      login: !login.loggedIn,
    },
    error: null,
    source: "large-thread-fast-path",
    latestTurnId: latestTurn?.turnId || latestTurn?.id || null,
    latestTurnStatus: latestTurn?.status || null,
  };
}

function largeThreadRuntimeSettings(record = {}) {
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
  const fullAccess = selectedLocalFullAccessEnabled() || dbSandboxPolicyIsFullAccess(record.sandbox_policy);
  return {
    model: typeof record.model === "string" && record.model.length > 0 ? record.model : "gpt-5.5",
    modelProvider: typeof record.model_provider === "string" && record.model_provider.length > 0 ? record.model_provider : "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [],
    approvalPolicy: fullAccess ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox: fullAccess ? fullAccessSandboxPolicy() : {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    activePermissionProfile: null,
    reasoningEffort: typeof record.reasoning_effort === "string" && record.reasoning_effort.length > 0
      ? record.reasoning_effort
      : "medium",
  };
}

function largeThreadResumeConfig(params = {}) {
  const config = params.config && typeof params.config === "object" && !Array.isArray(params.config)
    ? params.config
    : {
    "features.enable_request_compression": true,
    "features.collaboration_modes": true,
    "features.personality": true,
    "features.request_rule": true,
    "features.resize_all_images": true,
    "features.apps_mcp_path_override": true,
    "features.apply_patch_streaming_events": true,
    "features.workspace_owner_usage_nudge": true,
    "features.enable_mcp_apps": true,
    "features.realtime_conversation": false,
  };
  if (!selectedLocalFullAccessEnabled()) return config;
  return {
    ...config,
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
  };
}

function largeThreadAppResumeParams(params = {}) {
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  if (!threadId || !largeThreadFastPathInfo(threadId)) return null;
  const record = threadRecord(threadId);
  if (!record) return null;
  const cwd = typeof params.cwd === "string" && params.cwd.length > 0
    ? params.cwd
    : (typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd());
  const rolloutPath = typeof params.path === "string" && params.path.length > 0
    ? params.path
    : record.rollout_path;
  if (typeof rolloutPath !== "string" || rolloutPath.length === 0) return null;
  const base = {
    threadId,
    history: null,
    path: rolloutPath,
    model: typeof params.model === "string" ? params.model : (record.model || null),
    modelProvider: typeof params.modelProvider === "string" ? params.modelProvider : (record.model_provider || null),
    serviceTier: params.serviceTier ?? null,
    cwd,
    config: largeThreadResumeConfig(params),
    developerInstructions: typeof params.developerInstructions === "string" ? params.developerInstructions : "",
    personality: typeof params.personality === "string" ? params.personality : "friendly",
    excludeTurns: true,
    initialTurnsPage: { limit: 5, itemsView: "full" },
  };
  return applySelectedPermissionModeToParams("thread/resume", base);
}

function largeThreadResumeFastPathResponse(params = {}) {
  if (!params || typeof params.threadId !== "string" || params.threadId.length === 0) return null;
  const info = largeThreadFastPathInfo(params.threadId);
  if (!info) return null;
  const record = threadRecord(params.threadId);
  if (!record) return null;
  const turnsPage = largeThreadTurnsFastPathPage({ ...params, cursor: null });
  const readResult = largeThreadReadFastPathResponse(params, turnsPage);
  const thread = readResult?.thread;
  if (!thread) return null;
  return {
    thread: {
      ...thread,
      status: { type: "idle" },
    },
    ...largeThreadRuntimeSettings(record),
    initialTurnsPage: largeThreadInitialTurnsPageFromPage(turnsPage),
  };
}

function imageGenerationIdFromPayload(payload = {}) {
  const id = payload.call_id || payload.id || payload.callId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function imageGenerationStatus(payload = {}) {
  if (typeof payload.result === "string" || typeof payload.saved_path === "string" || typeof payload.savedPath === "string") {
    return "completed";
  }
  return typeof payload.status === "string" && payload.status.length > 0 ? payload.status : "completed";
}

function mergeGeneratedImageRecord(target, event, payload) {
  const id = imageGenerationIdFromPayload(payload);
  if (!id) return target;
  const next = target || { id, timestampMs: Date.parse(event?.timestamp || "") || 0 };
  next.id = id;
  const eventTimestampMs = Date.parse(event?.timestamp || "");
  if (Number.isFinite(eventTimestampMs) && eventTimestampMs > 0) next.timestampMs = eventTimestampMs;
  next.status = imageGenerationStatus(payload);
  if (typeof payload.revised_prompt === "string") next.revisedPrompt = payload.revised_prompt;
  if (typeof payload.revisedPrompt === "string") next.revisedPrompt = payload.revisedPrompt;
  if (typeof payload.result === "string" && payload.result.length > 0) next.result = payload.result;
  if (typeof payload.saved_path === "string" && payload.saved_path.length > 0) next.savedPath = payload.saved_path;
  if (typeof payload.savedPath === "string" && payload.savedPath.length > 0) next.savedPath = payload.savedPath;
  return next;
}

function rolloutGeneratedImagesForThread(threadId) {
  const info = rolloutInfoForThread(threadId);
  if (!info) return [];
  const cacheKey = `${info.threadId}:${info.rolloutPath}`;
  const cached = generatedImageRolloutCache.get(cacheKey);
  if (cached && cached.signature === info.signature) {
    generatedImageRolloutCache.delete(cacheKey);
    generatedImageRolloutCache.set(cacheKey, cached);
    return cached.images;
  }

  const recordsById = new Map();
  try {
    const lines = fs.readFileSync(info.rolloutPath, "utf8").split(/\n/);
    for (const line of lines) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.type !== "image_generation_end" && payload.type !== "image_generation_call") continue;
      const id = imageGenerationIdFromPayload(payload);
      if (!id) continue;
      recordsById.set(id, mergeGeneratedImageRecord(recordsById.get(id), event, payload));
    }
  } catch (error) {
    debugLog("failed to read rollout generated images", threadId, error.message || String(error));
  }

  const images = [...recordsById.values()]
    .filter((record) => typeof record.result === "string" || typeof record.savedPath === "string")
    .sort((left, right) => (left.timestampMs || 0) - (right.timestampMs || 0));
  generatedImageRolloutCache.delete(cacheKey);
  generatedImageRolloutCache.set(cacheKey, { signature: info.signature, images });
  while (generatedImageRolloutCache.size > generatedImageRolloutCacheMaxEntries) {
    const oldestKey = generatedImageRolloutCache.keys().next().value;
    if (oldestKey === undefined) break;
    generatedImageRolloutCache.delete(oldestKey);
  }
  return images;
}

function epochMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 100000000000 ? Math.trunc(number) : Math.trunc(number * 1000);
}

function turnTimeBoundsMs(turn) {
  const startedAt = epochMilliseconds(turn?.startedAt);
  const completedAt = epochMilliseconds(turn?.completedAt);
  return {
    start: startedAt,
    end: completedAt || startedAt,
  };
}

function generatedImageTurnIndex(turns, image) {
  const imageMs = Number(image?.timestampMs) || 0;
  if (imageMs <= 0) return turns.length - 1;
  let bestIndex = -1;
  let bestSpan = Infinity;
  for (let index = 0; index < turns.length; index += 1) {
    const bounds = turnTimeBoundsMs(turns[index]);
    if (bounds.start <= 0) continue;
    const end = Math.max(bounds.end, bounds.start);
    if (imageMs < bounds.start - 120000 || imageMs > end + 120000) continue;
    const span = Math.max(1, end - bounds.start);
    if (span < bestSpan) {
      bestSpan = span;
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) return bestIndex;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const bounds = turnTimeBoundsMs(turns[index]);
    if (bounds.start > 0 && bounds.start <= imageMs) return index;
  }
  return turns.length - 1;
}

function generatedImageDataUrl(image) {
  if (typeof image?.result !== "string" || image.result.length === 0) return null;
  if (image.result.startsWith("data:image/")) return image.result;
  return `data:image/png;base64,${image.result}`;
}

function generatedImageLocalPath(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  if (text.startsWith("app://fs/@fs/")) text = text.slice("app://fs/@fs".length);
  if (text.startsWith("/@fs/")) text = text.slice("/@fs".length);
  if (text.startsWith("file://")) {
    try {
      text = new URL(text).pathname;
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(text)) return null;
  return path.resolve(text);
}

function imageMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".png":
    default:
      return "image/png";
  }
}

function generatedImageDataUrlFromPath(value) {
  const localPath = generatedImageLocalPath(value);
  if (!localPath) return null;
  const generatedRoot = path.resolve(codexHome, "generated_images");
  const generatedRootWithSeparator = generatedRoot.endsWith(path.sep) ? generatedRoot : `${generatedRoot}${path.sep}`;
  if (localPath !== generatedRoot && !localPath.startsWith(generatedRootWithSeparator)) return null;
  try {
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > generatedImageInlineMaxBytes) return null;
    const data = fs.readFileSync(localPath).toString("base64");
    return `data:${imageMimeType(localPath)};base64,${data}`;
  } catch {
    return null;
  }
}

function generatedImageDataUrlFromValue(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  if (text.startsWith("data:image/")) return text;
  const fromPath = generatedImageDataUrlFromPath(text);
  if (fromPath) return fromPath;
  if (/^(?:app|file):\/\//i.test(text) || text.startsWith("/@fs/") || path.isAbsolute(text)) return null;
  return `data:image/png;base64,${text}`;
}

function isGeneratedImageObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = value.type;
  return type === "imageGeneration"
    || type === "generated-image"
    || type === "image_generation_end"
    || type === "image_generation_call";
}

function sanitizeGeneratedImageObjectForWeb(value) {
  if (!isGeneratedImageObject(value)) return value;
  const dataUrl = generatedImageDataUrlFromValue(value.result)
    || generatedImageDataUrlFromValue(value.src)
    || generatedImageDataUrlFromValue(value.savedPath)
    || generatedImageDataUrlFromValue(value.saved_path);
  if (!dataUrl) return value;
  const next = { ...value, src: dataUrl };
  if (typeof next.result !== "string" || next.result.trim().length === 0 || generatedImageLocalPath(next.result)) {
    next.result = dataUrl;
  }
  delete next.savedPath;
  delete next.saved_path;
  if (next.status === "generating") next.status = "completed";
  return next;
}

function sanitizeGeneratedImagesForWeb(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = [];
    seen.set(value, next);
    for (const item of value) {
      const sanitized = sanitizeGeneratedImagesForWeb(item, seen);
      if (sanitized !== item) changed = true;
      next.push(sanitized);
    }
    return changed ? next : value;
  }

  let changed = false;
  const next = {};
  seen.set(value, next);
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeGeneratedImagesForWeb(item, seen);
    if (sanitized !== item) changed = true;
    next[key] = sanitized;
  }
  const imageSanitized = sanitizeGeneratedImageObjectForWeb(next);
  if (imageSanitized !== next) return imageSanitized;
  return changed ? next : value;
}

function generatedImageTurnItem(image) {
  const hasResult = typeof image.result === "string" && image.result.length > 0;
  return {
    type: "imageGeneration",
    id: image.id,
    status: image.status || "completed",
    ...(typeof image.revisedPrompt === "string" ? { revisedPrompt: image.revisedPrompt } : {}),
    ...(hasResult ? { result: image.result } : {}),
    ...(!hasResult && typeof image.savedPath === "string" ? { savedPath: image.savedPath } : {}),
    ...(generatedImageDataUrl(image) ? { src: generatedImageDataUrl(image) } : {}),
  };
}

function turnHasGeneratedImage(turn, imageId) {
  if (!Array.isArray(turn?.items)) return false;
  return turn.items.some((item) => item && typeof item === "object"
    && (item.id === imageId || item.callId === imageId || item.call_id === imageId)
    && (item.type === "imageGeneration" || item.type === "generated-image"));
}

function injectGeneratedImagesIntoTurns(result, threadId) {
  if (!threadId || !result || !Array.isArray(result.data) || result.data.length === 0) return result;
  const images = rolloutGeneratedImagesForThread(threadId);
  if (images.length === 0) return result;

  const imagesByTurnIndex = new Map();
  for (const image of images) {
    if (!image?.id) continue;
    const turnIndex = generatedImageTurnIndex(result.data, image);
    if (turnIndex < 0 || turnIndex >= result.data.length) continue;
    if (turnHasGeneratedImage(result.data[turnIndex], image.id)) continue;
    const bucket = imagesByTurnIndex.get(turnIndex) || [];
    bucket.push(image);
    imagesByTurnIndex.set(turnIndex, bucket);
  }
  if (imagesByTurnIndex.size === 0) return result;

  let changed = false;
  const data = result.data.map((turn, index) => {
    const bucket = imagesByTurnIndex.get(index);
    if (!bucket || !turn || typeof turn !== "object") return turn;
    const items = Array.isArray(turn.items) ? [...turn.items] : [];
    const insertIndex = items.findIndex((item) => item?.type === "agentMessage" && item?.phase === "final_answer");
    const renderedItems = bucket.map(generatedImageTurnItem);
    if (insertIndex >= 0) {
      items.splice(insertIndex, 0, ...renderedItems);
    } else {
      items.push(...renderedItems);
    }
    changed = true;
    return { ...turn, items };
  });
  return changed ? { ...result, data } : result;
}

function normalizeThreadTurnsResult(result, { preserveLatestInProgress = true, threadId = null } = {}) {
  if (!result || !Array.isArray(result.data)) return result;

  let newestInProgressIndex = -1;
  let newestInProgressStartedAt = -Infinity;
  if (preserveLatestInProgress) {
    result.data.forEach((turn, index) => {
      if (turn?.status !== "inProgress" || !hasVisibleTurnItems(turn)) return;
      const startedAt = Number(turn.startedAt) || 0;
      if (startedAt >= newestInProgressStartedAt) {
        newestInProgressStartedAt = startedAt;
        newestInProgressIndex = index;
      }
    });
  }

  let changed = false;
  const data = [];
  result.data.forEach((turn, index) => {
    if (!turn || typeof turn !== "object" || turn.status !== "inProgress") {
      data.push(turn);
      return;
    }
    if (index === newestInProgressIndex) {
      data.push(turn);
      return;
    }
    changed = true;
    if (!hasVisibleTurnItems(turn)) return;
    data.push({ ...turn, status: "interrupted" });
  });

  const normalized = changed ? { ...result, data } : result;
  return injectGeneratedImagesIntoTurns(normalized, threadId);
}

function threadTurnsResultHasInProgress(result) {
  return Array.isArray(result?.data) && result.data.some((turn) => turn?.status === "inProgress");
}

function threadTurnsResultHasGeneratedImagePayload(result) {
  if (!Array.isArray(result?.data)) return false;
  return result.data.some((turn) => Array.isArray(turn?.items) && turn.items.some((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type !== "imageGeneration" && item.type !== "generated-image") return false;
    return typeof item.result === "string" || (typeof item.src === "string" && item.src.startsWith("data:image/"));
  }));
}

function threadTurnsResultSignature(result) {
  if (!result || !Array.isArray(result.data)) return null;
  const parts = result.data.slice(0, 20).map((turn) => {
    if (!turn || typeof turn !== "object") return "null";
    const items = Array.isArray(turn.items) ? turn.items : [];
    const lastItem = items.length > 0 ? items[items.length - 1] : null;
    const lastItemSignal = textHash(safeString(lastItem).slice(-4096));
    return [
      turn.id || turn.turnId || "",
      turn.status || "",
      turn.startedAt || "",
      turn.completedAt || "",
      turn.updatedAt || "",
      items.length,
      lastItemSignal,
    ].join(":");
  });
  return textHash(parts.join("|"));
}

function threadIdFromTurnPayload(params = {}, result = null) {
  const candidates = [
    params?.threadId,
    params?.conversationId,
    result?.threadId,
    result?.conversationId,
    result?.thread?.id,
    result?.thread?.sessionId,
    result?.conversation?.id,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0) || null;
}

function threadIdFromThreadObject(thread = null) {
  return [thread?.id, thread?.sessionId]
    .find((value) => typeof value === "string" && value.length > 0) || null;
}

function ephemeralThreadIdFromResult(method, params = {}, result = null) {
  if (result?.thread?.ephemeral !== true) return null;
  const resultThreadId = threadIdFromThreadObject(result.thread);
  if (resultThreadId) return resultThreadId;
  if (method === "thread/fork") return null;
  return threadIdFromParams(params);
}

function managedWorkspaceSandboxPolicy(previousPolicy = {}) {
  if (managedSandboxFallbackMode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: Array.isArray(previousPolicy?.writableRoots) ? previousPolicy.writableRoots : [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function isManagedSandboxOverrideKey(key) {
  const normalized = String(key || "").replace(/[-_]/g, "").toLowerCase();
  const leaf = normalized.split(".").pop();
  return leaf === "sandbox"
    || leaf === "sandboxmode"
    || leaf === "sandboxpolicy"
    || leaf === "sandboxworkspacewrite"
    || leaf === "sandboxpermissions"
    || normalized.startsWith("sandboxworkspacewrite.");
}

function managedWorkspacePermissionProfile() {
  return appServerDefaultPermissionsOverride || ":workspace";
}

function sanitizeManagedPermissionTree(value, parentKey = "") {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = sanitizeManagedPermissionTree(item, parentKey);
      if (sanitized !== item) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;
  const parentNormalized = configKeyLeaf(parentKey).replace(/[-_]/g, "").toLowerCase();
  if (parentNormalized === "sandboxpolicy" && isDangerFullAccessValue(value.type)) {
    return managedWorkspaceSandboxPolicy(value);
  }
  let changed = false;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = configKeyLeaf(key).replace(/[-_]/g, "").toLowerCase();
    if (normalized === "approvalsreviewer") {
      changed = true;
      continue;
    }
    if (normalized === "approvalpolicy") {
      next[key] = "never";
      if (child !== "never") changed = true;
      continue;
    }
    if (normalized === "sandbox" || normalized === "sandboxmode") {
      next[key] = managedSandboxFallbackMode;
      if (child !== managedSandboxFallbackMode) changed = true;
      continue;
    }
    if (normalized === "sandboxpolicy") {
      next[key] = managedWorkspaceSandboxPolicy(child);
      if (JSON.stringify(next[key]) !== JSON.stringify(child)) changed = true;
      continue;
    }
    if (normalized === "sandboxworkspacewrite" || normalized === "sandboxpermissions" || String(key).replace(/[-_]/g, "").toLowerCase().startsWith("sandboxworkspacewrite.")) {
      changed = true;
      continue;
    }
    if (normalized === "defaultpermissions" || normalized === "permissionprofile" || normalized === "permissionprofileid") {
      next[key] = managedWorkspacePermissionProfile();
      if (child !== next[key]) changed = true;
      continue;
    }
    if (normalized === "activepermissionprofile") {
      if (isDangerFullAccessValue(child) || isDangerFullAccessValue(child?.id) || isDangerFullAccessValue(child?.type)) {
        next[key] = null;
        changed = true;
      } else {
        const sanitized = sanitizeManagedPermissionTree(child, key);
        next[key] = sanitized;
        if (sanitized !== child) changed = true;
      }
      continue;
    }
    const sanitized = sanitizeManagedPermissionTree(child, key);
    next[key] = sanitized;
    if (sanitized !== child) changed = true;
  }
  return changed ? next : value;
}

function managedWorkspaceThreadSettings(settings = {}) {
  const source = isPlainObject(settings) ? sanitizeManagedPermissionTree(settings, "threadSettings") : {};
  const next = {
    ...source,
    approvalPolicy: "never",
    sandboxPolicy: managedWorkspaceSandboxPolicy(source.sandboxPolicy),
  };
  delete next.approvalsReviewer;
  delete next.approval_policy;
  delete next.sandbox;
  delete next.sandboxMode;
  delete next.sandbox_mode;
  delete next.sandbox_policy;
  if (isDangerFullAccessValue(next.activePermissionProfile?.id) || isDangerFullAccessValue(next.activePermissionProfile)) {
    next.activePermissionProfile = null;
  }
  return next;
}

function managedWorkspaceConfig(config = {}) {
  const source = isPlainObject(config) ? sanitizeManagedPermissionTree(config, "config") : {};
  const next = {
    ...source,
    approval_policy: "never",
    sandbox_mode: managedSandboxFallbackMode,
  };
  delete next.sandboxPolicy;
  delete next.sandbox_policy;
  delete next.sandboxMode;
  delete next.sandbox;
  if (isDangerFullAccessValue(next.activePermissionProfile?.id) || isDangerFullAccessValue(next.activePermissionProfile)) {
    next.activePermissionProfile = null;
  }
  return next;
}

function configKeyLeaf(keyPath) {
  if (typeof keyPath !== "string") return "";
  const parts = keyPath.split(".");
  return parts[parts.length - 1] || keyPath;
}

function isDangerFullAccessValue(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  const compact = normalized.replace(/^:/, "").replace(/[-_\s]/g, "").toLowerCase();
  return normalized === "danger-full-access"
    || normalized === "dangerFullAccess"
    || normalized === "danger_full_access"
    || normalized === ":danger-full-access"
    || compact === "dangerfullaccess"
    || compact === "fullaccess";
}

function sanitizeManagedConfigWriteValue(keyPath, value) {
  const normalized = configKeyLeaf(keyPath).replace(/[-_]/g, "").toLowerCase();
  if ((normalized === "sandbox" || normalized === "sandboxmode") && isDangerFullAccessValue(value)) {
    return managedSandboxFallbackMode;
  }
  if (normalized === "sandboxpolicy") {
    if (isDangerFullAccessValue(value)) return managedWorkspaceSandboxPolicy();
    if (value && typeof value === "object" && !Array.isArray(value) && isDangerFullAccessValue(value.type)) {
      return managedWorkspaceSandboxPolicy(value);
    }
  }
  if ((normalized === "defaultpermissions" || normalized === "permissionprofile" || normalized === "permissionprofileid") && isDangerFullAccessValue(value)) {
    return managedWorkspacePermissionProfile();
  }
  if (normalized === "activepermissionprofile"
    && (isDangerFullAccessValue(value) || isDangerFullAccessValue(value?.id) || isDangerFullAccessValue(value?.type))) {
    return null;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && isDangerFullAccessValue(value.type)) {
    return managedWorkspaceSandboxPolicy(value);
  }
  return sanitizeManagedPermissionTree(value, keyPath);
}

function sanitizeManagedConfigWriteParams(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (method === "config/value/write") {
    const value = sanitizeManagedConfigWriteValue(params.keyPath, params.value);
    return value === params.value ? params : { ...params, value };
  }
  if (method === "config/batchWrite" && Array.isArray(params.edits)) {
    let changed = false;
    const edits = params.edits.map((edit) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
      const value = sanitizeManagedConfigWriteValue(edit.keyPath, edit.value);
      if (value === edit.value) return edit;
      changed = true;
      return { ...edit, value };
    });
    return changed ? { ...params, edits } : params;
  }
  return params;
}

function selectedLocalAgentMode() {
  const modes = persistedAtomState["agent-mode-by-host-id"];
  return isPlainObject(modes) ? modes.local : null;
}

function fullAccessSandboxPolicy() {
  return { type: "dangerFullAccess" };
}

function fullAccessThreadSettings(settings = {}) {
  const next = isPlainObject(settings) ? { ...settings } : {};
  next.approvalPolicy = "never";
  next.approvalsReviewer = "user";
  next.sandboxPolicy = fullAccessSandboxPolicy();
  delete next.approval_policy;
  delete next.sandbox;
  delete next.sandboxMode;
  delete next.sandbox_mode;
  delete next.sandbox_policy;
  return next;
}

function applySelectedPermissionModeToParams(method, params) {
  if (selectedLocalAgentMode() !== "full-access" || !isPlainObject(params)) return params;
  if (!["thread/start", "thread/resume", "turn/start", "turn/steer", "thread/settings/update"].includes(String(method || ""))) return params;
  const next = {
    ...params,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    sandboxMode: "danger-full-access",
    sandboxPolicy: fullAccessSandboxPolicy(),
  };
  if (isPlainObject(next.config)) {
    next.config = {
      ...next.config,
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    };
  }
  if (Object.prototype.hasOwnProperty.call(next, "threadSettings") || method === "thread/settings/update") {
    next.threadSettings = fullAccessThreadSettings(next.threadSettings);
  }
  return next;
}

function forceLocalManagedWorkspacePermissions(method, params) {
  return applySelectedPermissionModeToParams(method, params);
}

function threadTurnsCacheFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function threadTurnsCacheInfo(params = {}) {
  if (!threadTurnsCacheEnabled) return null;
  if (typeof params.threadId !== "string" || params.threadId.length === 0) return null;
  const record = threadRecord(params.threadId);
  if (!record?.rollout_path) return null;
  const rolloutPath = path.resolve(record.rollout_path);
  const sessionsRoot = path.resolve(codexHome, "sessions");
  const sessionsRootWithSeparator = sessionsRoot.endsWith(path.sep) ? sessionsRoot : `${sessionsRoot}${path.sep}`;
  if (rolloutPath !== sessionsRoot && !rolloutPath.startsWith(sessionsRootWithSeparator)) return null;
  const signature = threadTurnsCacheFileSignature(rolloutPath);
  if (!signature) return null;
  const key = JSON.stringify({
    threadId: params.threadId,
    cursor: params.cursor ?? null,
    limit: params.cursor == null ? null : (params.limit ?? null),
    sortDirection: params.sortDirection ?? null,
    itemsView: params.itemsView ?? null,
  });
  return { key, signature, rolloutPath, threadId: params.threadId };
}

function getCachedThreadTurns(params = {}) {
  const info = threadTurnsCacheInfo(params);
  if (!info) return null;
  const entry = threadTurnsCache.get(info.key);
  if (!entry || entry.signature !== info.signature) {
    if (entry) threadTurnsCache.delete(info.key);
    return null;
  }
  threadTurnsCache.delete(info.key);
  threadTurnsCache.set(info.key, entry);
  return entry.result;
}

function setCachedThreadTurns(params = {}, result) {
  if (!result || !Array.isArray(result.data)) return;
  if (result.nextCursor != null) return;
  if (result.data.some((turn) => turn?.status === "inProgress")) return;
  if (threadTurnsResultHasGeneratedImagePayload(result)) return;
  const info = threadTurnsCacheInfo(params);
  if (!info) return;
  threadTurnsCache.delete(info.key);
  threadTurnsCache.set(info.key, {
    signature: info.signature,
    result,
    storedAt: Date.now(),
  });
  while (threadTurnsCache.size > threadTurnsCacheMaxEntries) {
    const oldestKey = threadTurnsCache.keys().next().value;
    if (oldestKey === undefined) break;
    threadTurnsCache.delete(oldestKey);
  }
}

function boundedTurnPageLimit(value, fallback = threadTurnsWindowDefaultLimit) {
  const requested = Number.parseInt(String(value ?? ""), 10);
  const fallbackLimit = Number.isFinite(Number(fallback)) && Number(fallback) > 0
    ? Math.trunc(Number(fallback))
    : threadTurnsWindowDefaultLimit;
  const effective = Number.isFinite(requested) && requested > 0 ? requested : fallbackLimit;
  const upper = Math.max(1, Math.min(completeThreadTurnsPageLimit, 100));
  return Math.max(1, Math.min(effective, upper));
}

function threadReadInitialTurnsLimit(params = {}) {
  return boundedTurnPageLimit(params?.initialTurnsPage?.limit ?? params?.limit, threadTurnsWindowDefaultLimit);
}

function chronologicalTurnsFromTurnsPage(result = null) {
  return Array.isArray(result?.data) ? result.data.slice().reverse() : [];
}

function turnStableId(turn = null) {
  return typeof turn?.turnId === "string" && turn.turnId.length > 0
    ? turn.turnId
    : (typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : null);
}

function turnsPaginationFromTurnsPage(result = null, chronologicalTurns = []) {
  const olderCursor = result?.nextCursor ?? result?.backwardsCursor ?? null;
  const oldestLoadedTurn = chronologicalTurns.find((turn) => turnStableId(turn));
  return {
    olderCursor,
    oldestLoadedTurnId: turnStableId(oldestLoadedTurn),
    isLoadingOlder: false,
    hasLoadedOldest: olderCursor == null,
  };
}

function initialTurnsPageFromTurnsResult(result = null) {
  if (!result || !Array.isArray(result.data)) return null;
  const nextCursor = result.nextCursor ?? result.backwardsCursor ?? null;
  return {
    data: result.data,
    nextCursor,
    backwardsCursor: result.backwardsCursor ?? nextCursor,
  };
}

function invalidateThreadTurnsCache(threadId = null) {
  if (!threadId) {
    threadTurnsCache.clear();
    return;
  }
  const needle = `"threadId":"${String(threadId).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
  for (const key of [...threadTurnsCache.keys()]) {
    if (key.includes(needle)) threadTurnsCache.delete(key);
  }
}

function shouldInvalidateThreadTurns(method, params = {}) {
  if (!method || !params?.threadId) return false;
  return method.startsWith("turn/")
    || method.startsWith("item/")
    || method === "thread/inject_items"
    || method === "thread/archive"
    || method === "thread/unarchive"
    || method === "thread/delete";
}

function textHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function textFromTurnInput(input) {
  if (typeof input === "string") return input.trim();
  if (!Array.isArray(input)) return "";
  return input.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    if (typeof item.text === "string") return item.text;
    if (Array.isArray(item.content)) return textFromTurnInput(item.content);
    return "";
  }).filter((part) => part.length > 0).join("\n").trim();
}

function textInputFromPromptHistory(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return [];
  return [{ type: "text", text: trimmed, text_elements: [] }];
}

function turnInputSignature(threadId, inputOrText) {
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  const text = typeof inputOrText === "string" ? inputOrText.trim() : textFromTurnInput(inputOrText);
  if (!text) return null;
  return `${threadId}:${textHash(text)}`;
}

function isThreadLikePromptHistoryKey(key) {
  return typeof key === "string" && /^[0-9a-fA-F-]{36}$/.test(key);
}

function appendedPromptHistoryEntries(previousValue, nextValue) {
  if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) return [];
  const previous = previousValue && typeof previousValue === "object" && !Array.isArray(previousValue)
    ? previousValue
    : {};
  const entries = [];
  for (const [threadId, nextItems] of Object.entries(nextValue)) {
    if (!isThreadLikePromptHistoryKey(threadId) || !Array.isArray(nextItems)) continue;
    const previousItems = Array.isArray(previous[threadId]) ? previous[threadId] : [];
    if (nextItems.length <= previousItems.length) continue;
    for (const item of nextItems.slice(previousItems.length)) {
      const text = typeof item === "string" ? item.trim() : "";
      if (text) entries.push({ threadId, text });
    }
  }
  return entries;
}

function commandText(command) {
  if (Array.isArray(command)) return command.map(shellQuote).join(" ");
  if (typeof command === "string") return command;
  return null;
}

function compactTerminalBuffer(text) {
  if (Buffer.byteLength(text, "utf8") <= terminalSnapshotMaxBytes) {
    return { buffer: text, truncated: false };
  }
  const bytes = Buffer.from(text, "utf8");
  return {
    buffer: bytes.subarray(bytes.length - terminalSnapshotMaxBytes).toString("utf8"),
    truncated: true,
  };
}

function terminalEventsFromRollout(rolloutPath) {
  if (typeof rolloutPath !== "string" || rolloutPath.length === 0 || !fs.existsSync(rolloutPath)) return [];
  const events = [];
  const startsByCallId = new Map();
  const lines = fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event?.payload;
    if (payload?.type === "exec_command_begin" && payload.call_id) {
      startsByCallId.set(payload.call_id, payload);
      continue;
    }
    if (payload?.type === "exec_command_end") {
      const start = startsByCallId.get(payload.call_id) || {};
      const cmd = commandText(payload.command) || commandText(start.command) || "";
      const output = String(payload.aggregated_output ?? `${payload.stdout || ""}${payload.stderr || ""}`);
      events.push({
        command: cmd,
        cwd: payload.cwd || start.cwd || null,
        exitCode: payload.exit_code ?? null,
        output,
      });
    }
  }
  return events;
}

function terminalSnapshotForThread(threadId) {
  const record = threadRecord(threadId);
  const cwd = record?.cwd || process.cwd();
  const shell = process.env.SHELL || "/bin/bash";
  const events = terminalEventsFromRollout(record?.rollout_path).slice(-25);
  const text = events.length === 0
    ? `No terminal command output has been captured for this thread yet.\r\n`
    : events.map((event) => {
        const header = [
          `${event.cwd || cwd}$ ${event.command || "[command]"}`,
          event.output || "[no output]",
          event.exitCode == null ? "" : `[exit ${event.exitCode}]`,
        ].filter(Boolean).join("\r\n");
        return `${header}\r\n`;
      }).join("\r\n");
  const compact = compactTerminalBuffer(text);
  return {
    session: {
      threadId,
      cwd,
      shell,
      title: null,
      rawShellTitle: null,
      buffer: compact.buffer,
      truncated: compact.truncated,
    },
  };
}

async function appServerOneShotRequest(method, params = {}, options = {}) {
  await appServerProcess.ensureStarted();
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`app-server ${method} request timed out`));
    }, options.timeoutMs || 30000);
    let initialized = false;
    const pending = new Map();
    const sendRequest = (id, requestMethod, requestParams) => {
      pending.set(id, requestMethod);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams }));
    };
    ws.on("open", () => {
      sendRequest("initialize", "initialize", {
        clientInfo: { name: clientName, title: appDisplayName, version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id === "initialize" && !initialized) {
        initialized = true;
        sendRequest("prewarm", method, params);
        return;
      }
      if (message.id !== "prewarm") return;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (message.error) {
        reject(new Error(message.error.message || `${method} failed`));
      } else {
        resolve(message.result);
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on("close", () => {
      if (!pending.has("prewarm")) return;
    });
  });
}

async function prewarmAppServerCaches() {
  if (!startupPrewarmEnabled) return;
  await appServerProcess.ensureStarted();
  const requests = [
    appServerOneShotRequest("getAuthStatus", {}, { timeoutMs: 20000 }),
  ];
  if (startupThreadListPrewarmEnabled) {
    requests.push(appServerOneShotRequest("thread/list", {
      archived: false,
      cursor: null,
      limit: 50,
      modelProviders: null,
      sortKey: "updated_at",
    }, { timeoutMs: 30000 }));
  }
  await Promise.allSettled(requests);
}

function send(res, status, headers, body = "") {
  res.writeHead(status, headers);
  res.end(body);
}

const compressedStaticResponseCache = new Map();

function appendVaryAcceptEncoding(headers = {}) {
  const next = { ...headers };
  const existing = String(next.Vary || next.vary || "").trim();
  if (!existing) {
    next.Vary = "Accept-Encoding";
  } else if (!/(^|,\s*)accept-encoding(\s*,|$)/i.test(existing)) {
    next.Vary = `${existing}, Accept-Encoding`;
  }
  return next;
}

function bodyBuffer(body = "") {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body ?? ""));
}

function compressibleContentType(contentType = "") {
  const normalized = String(contentType || "").toLowerCase();
  return normalized.startsWith("text/")
    || normalized.includes("javascript")
    || normalized.includes("json")
    || normalized.includes("xml")
    || normalized.includes("svg");
}

function acceptedStaticEncoding(req) {
  if (!staticCompressionEnabled) return null;
  const value = String(req?.headers?.["accept-encoding"] || "");
  if (/\bgzip\b/i.test(value)) return "gzip";
  if (/\bbr\b/i.test(value)) return "br";
  return null;
}

function compressedBodyForBuffer(buffer, encoding, cacheKey = null) {
  if (!encoding || !buffer || buffer.length < staticCompressionMinBytes) return null;
  const key = cacheKey && staticCompressionCacheMaxEntries > 0 ? `${encoding}:${cacheKey}` : null;
  if (key) {
    const cached = compressedStaticResponseCache.get(key);
    if (cached) {
      compressedStaticResponseCache.delete(key);
      compressedStaticResponseCache.set(key, cached);
      return cached;
    }
  }
  const compressed = encoding === "br"
    ? zlib.brotliCompressSync(buffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 1,
        },
      })
    : zlib.gzipSync(buffer, { level: 1 });
  if (key) {
    compressedStaticResponseCache.set(key, compressed);
    while (compressedStaticResponseCache.size > staticCompressionCacheMaxEntries) {
      const oldestKey = compressedStaticResponseCache.keys().next().value;
      if (oldestKey === undefined) break;
      compressedStaticResponseCache.delete(oldestKey);
    }
  }
  return compressed;
}

function sendStaticBody(req, res, status, headers, body = "", cacheKey = null) {
  const buffer = bodyBuffer(body);
  const method = String(req?.method || "GET").toUpperCase();
  const contentType = headers?.["Content-Type"] || headers?.["content-type"] || "";
  const encoding = compressibleContentType(contentType) ? acceptedStaticEncoding(req) : null;
  const compressed = encoding ? compressedBodyForBuffer(buffer, encoding, cacheKey) : null;
  const payload = compressed || buffer;
  const responseHeaders = compressed
    ? appendVaryAcceptEncoding({ ...headers, "Content-Encoding": encoding, "Content-Length": payload.length })
    : { ...headers, "Content-Length": payload.length };
  res.writeHead(status, responseHeaders);
  res.end(method === "HEAD" ? undefined : payload);
}

function staticFileCompressionCacheKey(filePath, requestUrl = null) {
  try {
    const stat = fs.statSync(filePath);
    return [
      "file",
      assetPatchVersion,
      path.relative(webviewDir, filePath),
      Math.trunc(stat.mtimeMs),
      stat.size,
      requestUrl?.searchParams?.has("codexapp_patch") ? "patched-url" : "plain-url",
    ].join(":");
  } catch {
    return null;
  }
}

function sendStaticFile(req, res, filePath, headers, requestUrl = null) {
  const contentType = headers?.["Content-Type"] || headers?.["content-type"] || "";
  if (!compressibleContentType(contentType)) {
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  sendStaticBody(req, res, 200, headers, fs.readFileSync(filePath), staticFileCompressionCacheKey(filePath, requestUrl));
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = path.normalize(decoded)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const target = normalized === "" || normalized === "." ? "index.html" : normalized;
  const fullPath = path.resolve(root, target);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(rootWithSeparator)) {
    return null;
  }
  return fullPath;
}

function htmlAttributeEscape(value) {
  return String(value).replace(/[&"<>]/g, (char) => ({
    "&": "&amp;",
    "\"": "&quot;",
    "<": "&lt;",
    ">": "&gt;",
  }[char]));
}

function cacheBustedAssetUrl(url) {
  if (typeof url !== "string" || url.includes("codexapp_patch=")) return url;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}codexapp_patch=${encodeURIComponent(assetPatchVersion)}${hash}`;
}

function cacheBustIndexHtmlAssets(html) {
  return html.replace(
    /\b(src|href)=(["'])((?:\.\/|\/)?assets\/[^"']+\.(?:js|css)(?:\?[^"']*)?)\2/g,
    (_match, attribute, quote, url) => `${attribute}=${quote}${cacheBustedAssetUrl(url)}${quote}`,
  );
}

function cacheBustJavaScriptDynamicImports(source) {
  const patched = source.replace(
    /import\((["'`])(\.\/[^"'`]+\.js(?:\?[^"'`]*)?)\1\)/g,
    (_match, quote, url) => `import(${quote}${cacheBustedAssetUrl(url)}${quote})`,
  );
  return patched.replace(
    /(["'`])(\.\/[^"'`]+\.js(?:\?[^"'`]*)?)\1/g,
    (_match, quote, url) => `${quote}${cacheBustedAssetUrl(url)}${quote}`,
  );
}

function cacheBustRemoteConnectionVisibilityImports(source) {
  return source.replace(
    /\b(from|import)\s*(["'])(\.\/remote-connection-visibility-[^"']+\.js)(?:\?[^"']*)?\2/g,
    (_match, keyword, quote, url) => `${keyword}${quote}${cacheBustedAssetUrl(url)}${quote}`,
  );
}

function replaceJavaScriptOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    log("javascript patch target not found", label);
    return source;
  }
  return source.replace(search, replacement);
}

function appServerManagerHistoryPatchSource() {
  return [
    "function ip(e,t){let n=rp.get(e);return n??(n=new sp(e),rp.set(e,n)),n.loadRemainingConversationTurns(t)}",
    "function codexappLargeCursorOffset(e){if(typeof e!==`string`)return null;let t=e.match(/codexapp-large-rollout:(\\d+)/);return t?Number.parseInt(t[1],10):null}",
    `function codexappHistoryWindowMax(){return ${historyWindowMaxTurns}}`,
    `function codexappHistoryCacheMax(){return ${historyWindowCacheMaxTurns}}`,
    "function codexappTurnKey(e){return e?.turnId??e?.id??null}",
    "function codexappFirstTurnId(e){let t=(e||[]).find(e=>codexappTurnKey(e)!=null);return codexappTurnKey(t)??null}",
    "function codexappLastTurnId(e){for(let t=(e||[]).length-1;t>=0;t--){let n=codexappTurnKey(e[t]);if(n!=null)return n}return null}",
    "function codexappUniqueTurns(e){let t=new Set,n=[];for(let r of e||[]){let e=codexappTurnKey(r);if(e!=null){if(t.has(e))continue;t.add(e)}n.push(r)}return n}",
    "function codexappMergeWindowTurns(e,t){return codexappUniqueTurns([...(e||[]),...(t||[])])}",
    "function codexappPlainTurn(e){try{return JSON.parse(JSON.stringify(e))}catch{return e}}",
    "function codexappPlainTurns(e){return(e||[]).map(codexappPlainTurn)}",
    "function codexappWindowCache(e){let t=globalThis.__codexappHistoryWindowCache;if(!(t instanceof Map)){t=new Map;globalThis.__codexappHistoryWindowCache=t}let n=t.get(e);return n??(n={before:[],after:[]},t.set(e,n)),n}",
    "function codexappHasWindowCache(e){let t=globalThis.__codexappHistoryWindowCache;return t instanceof Map&&t.has(e)}",
    "function codexappStoreBefore(e,t){if(!Array.isArray(t)||t.length===0)return;let n=codexappHistoryCacheMax();e.before=codexappUniqueTurns([...(e.before||[]),...codexappPlainTurns(t)]).slice(-n)}",
    "function codexappStoreAfter(e,t){if(!Array.isArray(t)||t.length===0)return;let n=codexappHistoryCacheMax();e.after=codexappUniqueTurns([...codexappPlainTurns(t),...(e.after||[])]).slice(0,n)}",
    "function codexappWindowMeta(e,t){return{before:e.before?.length??0,after:e.after?.length??0,max:codexappHistoryWindowMax(),reason:t??null}}",
    "function codexappWithWindowMeta(e,t,n){let r=codexappWindowCache(e.id);return{...e,codexappWindow:codexappWindowMeta(r,n),turns:t}}",
    "function codexappIsEmptyGhostTurn(e){return e?.status===`inProgress`&&e?.turnId==null&&e?.id==null&&(!Array.isArray(e?.items)||e.items.length===0)}",
    "function codexappDropEmptyGhostTurns(e){if(!Array.isArray(e)||e.length<2)return e;let t=-1;for(let n=e.length-1;n>=0;n--){let r=e[n];if(!codexappIsEmptyGhostTurn(r)&&(r?.status!==`inProgress`||Array.isArray(r?.items)&&r.items.length>0)){t=n;break}}if(t<0)return e;let n=e.filter((e,n)=>!(n<t&&codexappIsEmptyGhostTurn(e)));return n.length===e.length?e:n}",
    "function codexappClampHydratedConversation(e,t){if(t==null||!Array.isArray(t.turns))return t;let n=codexappDropEmptyGhostTurns(t.turns);t=n===t.turns?t:{...t,turns:n};let r=t.turns,i=t.turnsPagination??null,a=codexappLargeCursorOffset(i?.olderCursor),o=codexappLargeCursorOffset(e?.turnsPagination?.olderCursor),s=a!=null||o!=null||codexappHasWindowCache(t.id);if(!s)return t;let c=codexappWindowCache(t.id),l=codexappHistoryWindowMax();if(r.length<=l)return{...t,codexappWindow:codexappWindowMeta(c,`within-window`)};let u=Array.isArray(e?.turns)?e.turns:[],d=r.some(e=>e?.status===`inProgress`),f=o!=null&&a!=null&&a<o&&r.length>u.length&&codexappLastTurnId(u)===codexappLastTurnId(r)&&!d,p,m,h;return f?(p=r.slice(0,l),m=r.slice(l),codexappStoreAfter(c,m),h=`older-window`):(m=r.slice(0,r.length-l),p=r.slice(-l),codexappStoreBefore(c,m),h=`newer-window`),{...t,turns:p,turnsPagination:i?{...i,oldestLoadedTurnId:codexappFirstTurnId(p)??i.oldestLoadedTurnId,isLoadingOlder:!1}:i,codexappWindow:codexappWindowMeta(c,h)}}",
    "function codexappShiftHistoryWindow(e,t,n){let r=e?.getConversation?.(t);if(r==null||!Array.isArray(r.turns))return!1;let i=codexappWindowCache(t),a=codexappHistoryWindowMax(),o=Math.max(1,Math.ceil(a/2)),s=n===`newer`?i.after.splice(0,o):i.before.splice(Math.max(0,i.before.length-o));if(s.length===0)return!1;e.updateConversationState(t,e=>{let r=Array.isArray(e.turns)?e.turns:[],c=n===`newer`?codexappMergeWindowTurns(r,s):codexappMergeWindowTurns(s,r);if(c.length>a)if(n===`newer`){codexappStoreBefore(i,c.slice(0,c.length-a));c=c.slice(-a)}else{codexappStoreAfter(i,c.slice(a));c=c.slice(0,a)}e.turns=c,e.turnsPagination={...(e.turnsPagination??{}),oldestLoadedTurnId:codexappFirstTurnId(c)??e.turnsPagination?.oldestLoadedTurnId,isLoadingOlder:!1},e.codexappWindow=codexappWindowMeta(i,`shift-`+n)});return!0}",
    "function codexappPreferPagination(e,t){if(e==null)return t??null;if(t==null)return e;let n=codexappLargeCursorOffset(e.olderCursor),r=codexappLargeCursorOffset(t.olderCursor),i=e.hasLoadedOldest===!0&&t.hasLoadedOldest!==!0,a=n!=null&&(r==null||n<r);return i||a?{...e,isLoadingOlder:!1}:t}",
    "function codexappMergeHydratedConversation(e,t){if(e==null||t==null||!Array.isArray(e.turns)||!Array.isArray(t.turns))return codexappClampHydratedConversation(e,t);let n=e.turnsPagination??null,r=t.turnsPagination??null;if(codexappLargeCursorOffset(n?.olderCursor)==null&&codexappLargeCursorOffset(r?.olderCursor)==null&&!codexappHasWindowCache(t.id))return codexappClampHydratedConversation(e,t);let i=codexappPreferPagination(n,r),a=i===n,o=e.turns.length>t.turns.length;if(!a&&!o)return codexappClampHydratedConversation(e,t);let s=new Map,c=[],l=t.turns.filter(e=>codexappTurnKey(e)==null),u=0;for(let e of t.turns){let t=codexappTurnKey(e);t!=null&&s.set(t,e)}for(let t of e.turns){let e=codexappTurnKey(t);if(e!=null){let n=s.get(e);n?(c.push(n),s.delete(e)):c.push(t)}else c.push(u<l.length?l[u++]:t)}for(let e of t.turns){let t=codexappTurnKey(e);t!=null&&s.has(t)&&(c.push(e),s.delete(t))}for(;u<l.length;)c.push(l[u++]);return codexappClampHydratedConversation(e,{...t,turns:c,turnsPagination:i})}",
    "function codexappRegisterHistoryManager(e){let t=globalThis.__codexappHistoryManagers??new Set;globalThis.__codexappHistoryManagers=t,t.add(e);let n=r=>{for(let e of Array.from(t))if(e?.conversations?.get(r)!=null)return e;return e},r=()=>{for(let e of Array.from(t)){let t=e?.currentConversationId??e?.activeConversationId??e?.conversationId??null;if(typeof t==`string`&&e?.conversations?.get(t)!=null)return t;let n=Array.from(e?.conversations?.keys?.()??[]).at(-1);if(typeof n==`string`)return n}return null};globalThis.__codexappResolveActiveThreadId=()=>r(),globalThis.__codexappLoadOlderThreadHistory=async r=>{let e=n(r);return e?ip(e,r):null},globalThis.__codexappShiftThreadHistoryWindow=(r,i)=>{let e=n(r);return e?codexappShiftHistoryWindow(e,r,i):!1},globalThis.__codexappGetThreadHistoryWindow=r=>{let e=codexappWindowCache(r);return codexappWindowMeta(e,`inspect`)},globalThis.__codexappGetThreadHistoryPagination=r=>n(r)?.conversations?.get(r)?.turnsPagination??null}",
    "function ap(){",
  ].join("");
}

function allowCloudflareInsightsInCsp(html) {
  const cloudflareInsightsOrigin = "https://static.cloudflareinsights.com";
  if (!html.includes("Content-Security-Policy") || html.includes(cloudflareInsightsOrigin)) {
    return html;
  }
  if (html.includes("&#39;wasm-unsafe-eval&#39;")) {
    return html.replace("&#39;wasm-unsafe-eval&#39;", `&#39;wasm-unsafe-eval&#39; ${cloudflareInsightsOrigin}`);
  }
  return html.replace(/(script-src\b)/i, `$1 ${cloudflareInsightsOrigin}`);
}

function injectBridge(indexHtml, initialRoute = null) {
  let html = allowCloudflareInsightsInCsp(cacheBustIndexHtmlAssets(indexHtml));
  if (!html.includes("<base href=")) {
    html = html.replace(/<head>/, `<head>\n    <base href="/">`);
  }
  if (initialRoute && !html.includes(`name="initial-route"`)) {
    const routeMeta = `<meta name="initial-route" content="${htmlAttributeEscape(initialRoute)}">`;
    html = html.replace(/<base href="\/">/, `<base href="/">\n    ${routeMeta}`);
  }
  const script = `<script src="${bridgeScriptPath}"></script>`;
  if (html.includes(script)) {
    return html;
  }
  return html.replace(/<script type="module"/, `${script}\n    <script type="module"`);
}

function patchJavaScript(filePath, source) {
  const base = path.basename(filePath);
  const cacheBustOnly = () => cacheBustJavaScriptDynamicImports(source);
  if (base.startsWith("preload-helper-")) {
    return replaceJavaScriptOnce(
      source,
      "if(i&&i.length>0){let r=document.getElementsByTagName(`link`)",
      "if(i&&i.length>0){i=i.filter(e=>String(e).endsWith(`.css`));let r=document.getElementsByTagName(`link`)",
      "preload-helper: keep css preload but skip js modulepreload fanout",
    );
  }
  if (base.startsWith("app-prefetch-impl-")) {
    return "function AppPrefetchImpl(){return null}export{AppPrefetchImpl};\n";
  }
  if (base.startsWith("index-")) {
    return cacheBustOnly();
  }
  if (base.startsWith("rpc-")) {
    const patched = source.replace(
      /async function ([A-Za-z_$][\w$]*)\(\)\{Q=[A-Za-z_$][\w$]*\(\),\$=await Q\.services\}/g,
      "async function $1(){$=globalThis.codexappHostServices??{},Q=globalThis.codexappHost??{services:$}}",
    );
    return cacheBustJavaScriptDynamicImports(patched);
  }
  if (base.startsWith("app-server-manager-signals-")) {
    let patched = source;
    patched = replaceJavaScriptOnce(
      patched,
      "constructor(e){this.hostId=e}requestClient=",
      "constructor(e){this.hostId=e,codexappRegisterHistoryManager(this)}requestClient=",
      "app-server-manager-signals: expose history loader from page manager",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "applyConversationState(e,t){if((this.conversations.get(e)??null)!==t){if(t==null){this.conversations.delete(e);for(let t of this.conversationStateCallbacks)t(e,null);return}this.conversations.set(e,t);for(let n of this.conversationStateCallbacks)n(e,t);for(let n of this.conversationCallbacks.get(e)??[])n(t)}}",
      "applyConversationState(e,t){t=codexappMergeHydratedConversation(this.conversations.get(e)??null,t);if((this.conversations.get(e)??null)!==t){if(t==null){this.conversations.delete(e);for(let t of this.conversationStateCallbacks)t(e,null);return}this.conversations.set(e,t);for(let n of this.conversationStateCallbacks)n(e,t);for(let n of this.conversationCallbacks.get(e)??[])n(t)}}",
      "app-server-manager-signals: preserve loaded older history on snapshots",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "async function tp({conversation:e,olderCursor:t,fetchPage:n,getCurrentConversation:r}){let i=np(e),a=[],o=t;for(;o!=null;){let s=await n(o,5);if(r()?.turnsPagination?.olderCursor!==t)return{status:`stale`};if(a.push(Yf({threadId:e.id,turns:s.data.slice().reverse(),model:e.latestModel,reasoningEffort:e.latestReasoningEffort,cwd:i.cwd,permissions:i.permissions})),s.nextCursor===o)throw Error(`Failed to load remaining conversation turns`);o=s.nextCursor}return{status:`loaded`,turns:a.reverse().flat()}}",
      "async function tp({conversation:e,olderCursor:t,fetchPage:n,getCurrentConversation:r}){let i=np(e),a=[],o=t;if(o!=null){let s=await n(o,5);if(r()?.turnsPagination?.olderCursor!==t)return{status:`stale`};if(a.push(Yf({threadId:e.id,turns:s.data.slice().reverse(),model:e.latestModel,reasoningEffort:e.latestReasoningEffort,cwd:i.cwd,permissions:i.permissions})),s.nextCursor===o)throw Error(`Failed to load remaining conversation turns`);o=s.nextCursor}return{status:`loaded`,turns:a.reverse().flat(),nextCursor:o}}",
      "app-server-manager-signals: single-page older history fetch",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "return{status:`loaded`,olderTurns:a.turns,mergedTurns:s}}function ep",
      "return{status:`loaded`,olderTurns:a.turns,mergedTurns:s,nextCursor:a.nextCursor??null}}function ep",
      "app-server-manager-signals: preserve older cursor from page fetch",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "e.turnsPagination={olderCursor:null,oldestLoadedTurnId:n.olderTurns.find(e=>e.turnId!=null)?.turnId??i,isLoadingOlder:!1,hasLoadedOldest:!0}",
      "e.turnsPagination={olderCursor:n.nextCursor??null,oldestLoadedTurnId:n.olderTurns.find(e=>e.turnId!=null)?.turnId??i,isLoadingOlder:!1,hasLoadedOldest:n.nextCursor==null}",
      "app-server-manager-signals: keep cursor after older page merge",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "getConversation(e){return this.conversations.get(e)??null}",
      "getConversation(e){codexappRegisterHistoryManager(this);return this.conversations.get(e)??null}",
      "app-server-manager-signals: expose history loader",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "getHasInProgressLocalConversation({exceptConversationId:e}={}){return this.recentConversations.some(t=>t.id!==e&&to(t))}",
      "getHasInProgressLocalConversation({exceptConversationId:e}={}){return !1}",
      "app-server-manager-signals: do not block new chats while another local thread is active",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "getHasInProgressLocalConversation({exceptConversationId:e}={}){for(let t of this.threadStore.getRecentConversationIds()){if(t===e)continue;let n=this.conversations.get(t);if(n!=null&&to(n))return!0}return!1}",
      "getHasInProgressLocalConversation({exceptConversationId:e}={}){return !1}",
      "app-server-manager-signals: keep project actions usable with active threads",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "loadRemainingConversationTurns(e){throw Error(`loadRemainingConversationTurns is worker-only`)}",
      "loadRemainingConversationTurns(e){codexappRegisterHistoryManager(this);return ip(this,e)}",
      "app-server-manager-signals: enable page-side history loader",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "async loadRemainingConversationTurns(e){return ip(this,e)}",
      "async loadRemainingConversationTurns(e){codexappRegisterHistoryManager(this);return ip(this,e)}",
      "app-server-manager-signals: expose history loader from method",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "function ip(e,t){let n=rp.get(e);return n??(n=new sp(e),rp.set(e,n)),n.loadRemainingConversationTurns(t)}function ap(){",
      appServerManagerHistoryPatchSource(),
      "app-server-manager-signals: register all history managers",
    );
    patched = replaceJavaScriptOnce(
      patched,
      "v&&ue?.olderCursor!=null&&ov(e,t)",
      "globalThis.__codexappAutoHistoryHydration===!0&&v&&ue?.olderCursor!=null&&ov(e,t)",
      "app-server-manager-signals: disable automatic full history hydration",
    );
    return cacheBustJavaScriptDynamicImports(patched);
  }
  if (base.startsWith("local-conversation-thread-")) {
    const patched = replaceJavaScriptOnce(
      source,
      "(0,Q.jsxs)(sn.div,{ref:we,\"data-thread-find-target\":`conversation`,className:",
      "(0,Q.jsxs)(sn.div,{ref:we,\"data-thread-find-target\":`conversation`,\"data-codexapp-conversation-id\":e,className:",
      "local-conversation-thread: expose conversation id on transcript root",
    );
    return cacheBustJavaScriptDynamicImports(patched);
  }
  if (base.startsWith("app-main-")) {
    let patched = source;
    if (patchUpdateRequiredGate) {
      patched = patched.replace(/\b[A-Za-z_$][\w$]*\(`2929582856`\)/g, "false");
    }
    patched = patched.replace(
      "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
      "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r}",
    );
    patched = patched.replace(
      "function CC({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
      "function CC({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r}",
    );
    patched = patched.replace(
      "a?.get(`enable_i18n`,!1)",
      "true",
    );
    return cacheBustJavaScriptDynamicImports(cacheBustRemoteConnectionVisibilityImports(patched));
  }
  if (base.startsWith("settings-page-")) {
    let patched = source
      .replace(
        "case`connections`:return f&&!d;",
        "case`connections`:return!0;",
      )
      .replace(
        /(var [A-Za-z_$][\w$]*=\[`profile`,`agent`,`personalization`,`mcp-settings`,`hooks-settings`)(,`local-environments`)/,
        "$1,`connections`$2",
      );
    return cacheBustJavaScriptDynamicImports(cacheBustRemoteConnectionVisibilityImports(patched));
  }
  if (base.startsWith("remote-connections-page-")) {
    let patched = source.replace(
      "if(!r()){",
      "if(!1){",
    );
    return cacheBustJavaScriptDynamicImports(cacheBustRemoteConnectionVisibilityImports(patched));
  }
  if (base.startsWith("remote-connections-settings-")) {
    let patched = source.replace(
      "X=me(),be=!o,",
      "X=true,be=!o,",
    );
    return cacheBustJavaScriptDynamicImports(cacheBustRemoteConnectionVisibilityImports(patched));
  }
  if (base.startsWith("remote-connection-visibility-")) {
    let patched = source
      .replace(
        "function f(){return codexLinuxRemoteControlLoadGateEnabled()||o(`1042620455`)}",
        "function f(){return true}",
      )
      .replace(
        "function codexLinuxRemoteControlLoadGateEnabled(){return typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)}",
        "function codexLinuxRemoteControlLoadGateEnabled(){return true}",
      );
    return cacheBustJavaScriptDynamicImports(patched);
  }
  if (base.startsWith("zh-CN-")) {
    return cacheBustJavaScriptDynamicImports(source
      .replaceAll("这台 Mac", "此电脑")
      .replaceAll("此 Mac", "此电脑")
      .replaceAll("此电脑 的", "此电脑的")
      .replaceAll("此电脑 保持", "此电脑保持"));
  }
  return cacheBustOnly();
}

const patchedJavaScriptCache = new Map();

function cachedPatchedJavaScript(filePath) {
  if (patchedJavaScriptCacheMaxEntries <= 0) {
    return patchJavaScript(filePath, fs.readFileSync(filePath, "utf8"));
  }
  const stat = fs.statSync(filePath);
  const key = filePath;
  const cached = patchedJavaScriptCache.get(key);
  if (cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.size === stat.size
    && cached.patchVersion === assetPatchVersion) {
    return cached.body;
  }
  const body = patchJavaScript(filePath, fs.readFileSync(filePath, "utf8"));
  patchedJavaScriptCache.set(key, {
    body,
    mtimeMs: stat.mtimeMs,
    patchVersion: assetPatchVersion,
    size: stat.size,
  });
  while (patchedJavaScriptCache.size > patchedJavaScriptCacheMaxEntries) {
    const oldestKey = patchedJavaScriptCache.keys().next().value;
    if (oldestKey === undefined) break;
    patchedJavaScriptCache.delete(oldestKey);
  }
  return body;
}

function shouldPatchJavaScript(filePath) {
  if (path.extname(filePath).toLowerCase() === ".js") return true;
  const base = path.basename(filePath);
  return base.startsWith("index-")
    || base.startsWith("rpc-")
    || base.startsWith("app-server-manager-signals-")
    || base.startsWith("local-conversation-thread-")
    || base.startsWith("app-main-")
    || base.startsWith("settings-page-")
    || base.startsWith("remote-connections-page-")
    || base.startsWith("remote-connections-settings-")
    || base.startsWith("remote-connection-visibility-")
    || base.startsWith("zh-CN-");
}

function patchPrewarmPriority(filePath) {
  const base = path.basename(filePath);
  if (/^(index-|app-main-|app-shell-|app-server-manager-signals-|local-conversation-thread-)/.test(base)) return 0;
  if (/^(sidebar-|thread-|local-|app-)/.test(base)) return 1;
  return 2;
}

function patchableJavaScriptFilesForPrewarm() {
  const files = [];
  const roots = [
    webviewDir,
    path.join(webviewDir, "assets"),
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const filePath = path.join(root, entry.name);
      if (shouldPatchJavaScript(filePath)) files.push(filePath);
    }
  }
  return files.sort((a, b) => patchPrewarmPriority(a) - patchPrewarmPriority(b) || a.localeCompare(b));
}

function prewarmPatchedJavaScriptCache() {
  if (!patchedJavaScriptPrewarmEnabled || patchedJavaScriptCacheMaxEntries <= 0) return;
  const files = patchableJavaScriptFilesForPrewarm().slice(0, patchedJavaScriptCacheMaxEntries);
  if (files.length === 0) return;
  const startedAt = Date.now();
  let index = 0;
  const step = () => {
    const end = Math.min(files.length, index + patchedJavaScriptPrewarmBatchSize);
    for (; index < end; index += 1) {
      try {
        cachedPatchedJavaScript(files[index]);
      } catch (error) {
        if (index < 5) log("patched javascript prewarm failed", path.basename(files[index]), error.message || String(error));
      }
    }
    if (index < files.length) {
      setImmediate(step);
      return;
    }
    log("patched javascript cache prewarmed", {
      files: files.length,
      durationMs: Date.now() - startedAt,
    });
  };
  setImmediate(step);
}

function assetCacheControl(filePath, ext, requestUrl = null) {
  const base = path.basename(filePath);
  if (base === "index.html" || base === path.basename(bridgeScriptPath)) {
    return "no-store";
  }
  if (ext === ".js" && shouldPatchJavaScript(filePath)) {
    return requestUrl?.searchParams?.has("codexapp_patch")
      ? "public, max-age=31536000, immutable"
      : "no-store";
  }
  const relative = path.relative(webviewDir, filePath).replaceAll(path.sep, "/");
  if (relative.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  if (ext === ".html") return "no-store";
  return "public, max-age=3600";
}

function shouldServeSpaFallback(req, urlPath) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (urlPath === bridgePath || urlPath === bridgeScriptPath || urlPath === "/health") return false;
  if (path.extname(urlPath)) return false;
  const accept = String(req.headers.accept || "");
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}

function localThreadIdFromRoute(routePath = "") {
  const parts = String(routePath || "").split("/").filter(Boolean);
  const index = parts.indexOf("local");
  return index >= 0 ? parts[index + 1] || null : null;
}

function longThreadRescueHtml(threadId) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codex</title>
  <style>
    html, body, #root { height: 100%; margin: 0; }
    body { background: #fff; color: #171717; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .startup-loader { min-height: 100%; display: grid; place-items: center; color: #777; font-size: 14px; }
  </style>
</head>
<body>
  <div id="root"><div class="startup-loader">正在打开长线程窗口...</div></div>
  <script>window.__codexappLongThreadRescue = ${JSON.stringify({ threadId })};</script>
  <script src="${bridgeScriptPath}"></script>
</body>
</html>`;
}

function sendIndexHtml(req, res, initialRoute = null) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const routePath = typeof initialRoute === "string" ? initialRoute : requestUrl.pathname;
  const threadId = localThreadIdFromRoute(routePath);
  if (threadId && largeThreadFastPathInfo(threadId) && requestUrl.searchParams.get("codexapp_official") !== "1") {
    sendStaticBody(req, res, 200, {
      "Content-Type": MIME_TYPES.get(".html"),
      "Cache-Control": "no-store",
    }, longThreadRescueHtml(threadId), `long-thread-rescue:${bridgeScriptVersion}:${assetPatchVersion}:${threadId}`);
    return;
  }
  const indexPath = path.join(webviewDir, "index.html");
  sendStaticBody(req, res, 200, {
    "Content-Type": MIME_TYPES.get(".html"),
    "Cache-Control": assetCacheControl(indexPath, ".html"),
  }, injectBridge(fs.readFileSync(indexPath, "utf8"), routePath), `index:${assetPatchVersion}:${routePath || ""}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name || "Error"} ${value.message || ""} ${value.stack || ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quotaTextSignal(value) {
  const text = safeString(value).toLowerCase();
  if (!text) return false;
  return [
    "usage_limit_reached",
    "workspace_owner_usage_limit_reached",
    "insufficient_quota",
    "quota_exceeded",
    "quota exceeded",
    "credits exhausted",
    "out of credits",
    "spending limit",
    "billing hard limit",
    "you've hit your usage limit",
    "you have hit your usage limit",
    "usage limit has been reached",
    "rate_limit_reached",
    "rate limit reached",
  ].some((needle) => text.includes(needle));
}

function authInvalidatedTextSignal(value) {
  const text = safeString(value).toLowerCase();
  if (!text) return false;
  return [
    "token_invalidated",
    "refresh_token_reused",
    "refresh token has already been used",
    "authentication token has been invalidated",
    "please try signing in again",
    "401 unauthorized",
  ].some((needle) => text.includes(needle));
}

function numericPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function quotaBucketExhausted(bucket) {
  if (!bucket || typeof bucket !== "object") return false;
  const used = numericPercent(
    bucket.usedPercent
      ?? bucket.used_percent
      ?? bucket.usedPct
      ?? bucket.used_pct
      ?? bucket.percent
      ?? bucket.pct
  );
  if (used != null && used >= 99.5) return true;
  const remaining = numericPercent(
    bucket.remainingPercent
      ?? bucket.remaining_percent
      ?? bucket.remainingPct
      ?? bucket.remaining_pct
  );
  return remaining != null && remaining <= 0.5;
}

function rateLimitsExhausted(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.rateLimitReachedType || payload.rate_limit_reached_type) return true;
  if (payload.credits && payload.credits.hasCredits === false && payload.credits.unlimited !== true) return true;
  const candidates = [
    payload,
    payload.rateLimits,
    payload.rate_limits,
    payload.primary,
    payload.secondary,
    payload.fiveHour,
    payload.five_hour,
    payload.week,
    payload.weekly,
  ];
  if (payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === "object") {
    candidates.push(...Object.values(payload.rateLimitsByLimitId));
  }
  if (payload.rate_limits_by_limit_id && typeof payload.rate_limits_by_limit_id === "object") {
    candidates.push(...Object.values(payload.rate_limits_by_limit_id));
  }
  return candidates.some(quotaBucketExhausted);
}

function whamRateLimitWindow(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  const windowDurationMins = Number(bucket.windowDurationMins ?? bucket.window_duration_mins);
  return {
    used_percent: Number(bucket.usedPercent ?? bucket.used_percent ?? 0),
    limit_window_seconds: Number.isFinite(windowDurationMins) ? Math.round(windowDurationMins * 60) : null,
    reset_at: bucket.resetsAt ?? bucket.reset_at ?? null,
  };
}

function whamRateLimitBucket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const reachedType = snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type ?? null;
  return {
    primary_window: whamRateLimitWindow(snapshot.primary ?? snapshot.primary_window),
    secondary_window: whamRateLimitWindow(snapshot.secondary ?? snapshot.secondary_window),
    allowed: reachedType == null,
    limit_reached: reachedType != null,
  };
}

function whamCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const hasCredits = credits.hasCredits ?? credits.has_credits ?? false;
  return {
    has_credits: Boolean(hasCredits),
    hasCredits: Boolean(hasCredits),
    unlimited: Boolean(credits.unlimited),
    balance: credits.balance ?? null,
  };
}

function whamUsageResponse(payload) {
  if (!payload || typeof payload !== "object" || payload.rate_limit) return payload;
  const byLimitId = payload.rateLimitsByLimitId ?? payload.rate_limits_by_limit_id ?? {};
  const primary = payload.rateLimits ?? payload.rate_limits ?? byLimitId.codex ?? Object.values(byLimitId)[0] ?? null;
  if (!primary || typeof primary !== "object") return payload;
  const primaryId = primary.limitId ?? primary.limit_id ?? "codex";
  const additional = [];
  if (byLimitId && typeof byLimitId === "object") {
    for (const [id, snapshot] of Object.entries(byLimitId)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      if (id === primaryId || snapshot === primary) continue;
      additional.push({
        limit_name: snapshot.limitName ?? snapshot.limit_name ?? id,
        rate_limit: whamRateLimitBucket(snapshot),
      });
    }
  }
  return {
    ...payload,
    plan_type: primary.planType ?? primary.plan_type ?? payload.plan_type ?? null,
    credits: whamCredits(primary.credits ?? payload.credits),
    rate_limit_name: primary.limitName ?? primary.limit_name ?? null,
    rate_limit: whamRateLimitBucket(primary),
    additional_rate_limits: additional,
    rate_limit_reached_type: primary.rateLimitReachedType ?? primary.rate_limit_reached_type ?? null,
  };
}

function providerCurrentExhausted(payload) {
  if (!payload || typeof payload !== "object") return false;
  const account = payload.account || payload.activeSlot || payload.activeAccount || null;
  if (account && typeof account === "object") {
    const state = String(account.state || account.displayState || account.status || "").toLowerCase();
    if (["exhausted", "quota_exhausted", "no_quota", "rate_limited"].includes(state)) return true;
    const fiveHour = numericPercent(account.quota5hPct ?? account.quota_5h_pct ?? account.current_quota_5h_pct);
    const week = numericPercent(account.quotaWeekPct ?? account.quota_week_pct ?? account.current_quota_week_pct);
    if (fiveHour != null && fiveHour >= 99.5) return true;
    if (week != null && week >= 99.5) return true;
  }
  return rateLimitsExhausted(payload) || looksLikeQuotaExhausted(payload);
}

function looksLikeQuotaExhausted(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return false;
  if (typeof value === "string") return quotaTextSignal(value);
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (value instanceof Error) {
    return quotaTextSignal(value) || looksLikeQuotaExhausted(value.cause, depth + 1, seen);
  }
  if (typeof value !== "object") return quotaTextSignal(value);
  if (seen.has(value)) return false;
  seen.add(value);
  if (rateLimitsExhausted(value)) return true;
  for (const key of ["code", "type", "name", "message", "error", "reason", "statusText", "rateLimitReachedType"]) {
    if (quotaTextSignal(value[key])) return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => looksLikeQuotaExhausted(item, depth + 1, seen));
  }
  return Object.values(value).some((item) => looksLikeQuotaExhausted(item, depth + 1, seen));
}

function looksLikeAuthInvalidated(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return false;
  if (typeof value === "string") return authInvalidatedTextSignal(value);
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (value instanceof Error) {
    return authInvalidatedTextSignal(value) || looksLikeAuthInvalidated(value.cause, depth + 1, seen);
  }
  if (typeof value !== "object") return authInvalidatedTextSignal(value);
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of ["code", "type", "name", "message", "error", "reason", "statusText"]) {
    if (authInvalidatedTextSignal(value[key])) return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => looksLikeAuthInvalidated(item, depth + 1, seen));
  }
  return Object.values(value).some((item) => looksLikeAuthInvalidated(item, depth + 1, seen));
}

function looksLikeSwitchableAccountFailure(value) {
  return looksLikeQuotaExhausted(value) || looksLikeAuthInvalidated(value);
}

function looksLikeEphemeralThreadTurnsUnsupported(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return false;
  if (typeof value === "string") {
    return value.toLowerCase().includes("ephemeral threads do not support thread/turns/list");
  }
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (value instanceof Error) {
    return looksLikeEphemeralThreadTurnsUnsupported(value.message, depth + 1, seen)
      || looksLikeEphemeralThreadTurnsUnsupported(value.cause, depth + 1, seen);
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of ["code", "type", "name", "message", "error", "reason", "statusText"]) {
    if (looksLikeEphemeralThreadTurnsUnsupported(value[key], depth + 1, seen)) return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => looksLikeEphemeralThreadTurnsUnsupported(item, depth + 1, seen));
  }
  return Object.values(value).some((item) => looksLikeEphemeralThreadTurnsUnsupported(item, depth + 1, seen));
}

function accountProviderUrl(pathname) {
  if (!accountProviderBaseUrl) return null;
  const base = new URL(accountProviderBaseUrl);
  const cleanPath = String(pathname || "").replace(/^\/+/, "");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${cleanPath}`.replace(/\/{2,}/g, "/");
  return base.toString();
}

async function accountProviderJson(method, pathname, body) {
  const url = accountProviderUrl(pathname);
  if (!url) throw new Error("account provider is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), accountProviderTimeoutMs);
  const headers = {
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accountProviderToken) {
    headers.authorization = `Bearer ${accountProviderToken}`;
    headers["x-codex-account-provider-token"] = accountProviderToken;
    headers["x-codex-switcher-verification-token"] = accountProviderToken;
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(`account provider ${method} ${pathname} failed with ${response.status}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function compactProviderPayload(value) {
  if (value == null) return null;
  const text = safeString(value);
  if (text.length <= 4000) return value;
  return { summary: text.slice(0, 4000), truncated: true };
}

function initialSharedObjectSnapshot() {
  return {
    host_config: sharedObjectValue("host_config"),
    local_app_server_feature_enablement: sharedObjectValue("local_app_server_feature_enablement"),
    remote_connections: sharedObjectValue("remote_connections"),
    remote_control_connections: sharedObjectValue("remote_control_connections"),
    remote_control_connections_state: sharedObjectValue("remote_control_connections_state"),
    "codex-mobile-has-connected-device": sharedObjectValue("codex-mobile-has-connected-device"),
  };
}

let deviceAuthSession = null;

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function parseDeviceAuthOutput(output) {
  const text = stripAnsi(output);
  const verificationUrl = text.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s]*/)?.[0] || null;
  const userCode = text.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,8}\b/)?.[0] || null;
  return { verificationUrl, userCode };
}

function codexLoginStatus() {
  const result = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const text = stripAnsi(`${result.stdout || ""}${result.stderr || ""}`).trim();
  if (result.error) {
    return {
      loggedIn: false,
      text: text || result.error.message || "login status unavailable",
    };
  }
  return {
    loggedIn: result.status === 0 && text.length > 0 && !/not logged in/i.test(text),
    text: text || "login status unavailable",
  };
}

function publicDeviceAuthSession() {
  const status = codexLoginStatus();
  if (!deviceAuthSession) {
    return { state: status.loggedIn ? "complete" : "idle", loginStatus: status };
  }
  const expired = Date.now() - deviceAuthSession.startedAt > deviceAuthSessionTtlMs;
  if (expired && deviceAuthSession.state === "pending") {
    try { deviceAuthSession.process?.kill("SIGTERM"); } catch {}
    deviceAuthSession.state = "expired";
    deviceAuthSession.exitedAt = Date.now();
  }
  return {
    state: status.loggedIn ? "complete" : deviceAuthSession.state,
    verificationUrl: deviceAuthSession.verificationUrl || null,
    userCode: deviceAuthSession.userCode || null,
    startedAt: deviceAuthSession.startedAt,
    expiresAt: deviceAuthSession.startedAt + deviceAuthSessionTtlMs,
    exitCode: deviceAuthSession.exitCode ?? null,
    error: deviceAuthSession.error || null,
    loginStatus: status,
  };
}

function startDeviceAuthSession() {
  const current = publicDeviceAuthSession();
  if (current.state === "pending" && current.verificationUrl && current.userCode) return Promise.resolve(current);
  if (current.loginStatus?.loggedIn) return Promise.resolve(current);

  if (deviceAuthSession?.process && deviceAuthSession.state === "pending") {
    try { deviceAuthSession.process.kill("SIGTERM"); } catch {}
  }

  const child = spawn("codex", ["login", "--device-auth"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  deviceAuthSession = {
    process: child,
    state: "starting",
    startedAt: Date.now(),
    output: "",
    verificationUrl: null,
    userCode: null,
    exitCode: null,
    error: null,
  };

  const updateFromOutput = () => {
    const parsed = parseDeviceAuthOutput(deviceAuthSession.output);
    if (parsed.verificationUrl) deviceAuthSession.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode) deviceAuthSession.userCode = parsed.userCode;
    if (deviceAuthSession.verificationUrl && deviceAuthSession.userCode && deviceAuthSession.state === "starting") {
      deviceAuthSession.state = "pending";
    }
  };

  child.stdout.on("data", (chunk) => {
    deviceAuthSession.output += chunk.toString("utf8");
    updateFromOutput();
  });
  child.stderr.on("data", (chunk) => {
    deviceAuthSession.output += chunk.toString("utf8");
    updateFromOutput();
  });
  child.on("error", (error) => {
    deviceAuthSession.state = "failed";
    deviceAuthSession.error = error.message || String(error);
  });
  child.on("exit", (code, signal) => {
    deviceAuthSession.exitCode = code;
    deviceAuthSession.exitedAt = Date.now();
    if (codexLoginStatus().loggedIn) {
      deviceAuthSession.state = "complete";
    } else if (deviceAuthSession.state !== "expired") {
      deviceAuthSession.state = code === 0 ? "complete" : "failed";
      if (signal) deviceAuthSession.error = `device auth exited with ${signal}`;
    }
  });

  return new Promise((resolve) => {
    const deadline = Date.now() + deviceAuthStartTimeoutMs;
    const timer = setInterval(() => {
      const snapshot = publicDeviceAuthSession();
      if (snapshot.verificationUrl && snapshot.userCode) {
        clearInterval(timer);
        resolve(snapshot);
      } else if (snapshot.state === "failed" || Date.now() >= deadline) {
        clearInterval(timer);
        resolve(snapshot);
      }
    }, 100);
    timer.unref?.();
  });
}

function browserBridgeScript() {
  return `(() => {
  const clientIdKey = "codexapp.bridge.clientId.v1";
  const bridgeScriptVersion = ${JSON.stringify(bridgeScriptVersion)};
  const managedSandboxFallbackMode = ${JSON.stringify(managedSandboxFallbackMode)};
  const managedPermissionProfile = ${JSON.stringify(appServerDefaultPermissionsOverride || ":workspace")};
  const statsigNoisePatterns = [
    "[Statsig]",
    "chatgpt.com/ces/v1/rgstr",
    "/ces/v1/rgstr",
    "statsig::log_event_failed",
    "flush failed"
  ];
  const noListenerNoisePatterns = [
    "No Listener: tabs:outgoing.message.ready"
  ];

  function compactLogValue(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message || value.stack || "";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function matchesNoise(args, patterns) {
    const text = args.map(compactLogValue).join(" ");
    return patterns.some((pattern) => text.includes(pattern));
  }

  const rawConsoleWarn = console.warn.bind(console);
  const rawConsoleError = console.error.bind(console);
  console.warn = (...args) => {
    if (matchesNoise(args, statsigNoisePatterns)) return;
    rawConsoleWarn(...args);
  };
  console.error = (...args) => {
    if (matchesNoise(args, statsigNoisePatterns) || matchesNoise(args, noListenerNoisePatterns)) return;
    rawConsoleError(...args);
  };
  window.addEventListener("unhandledrejection", (event) => {
    if (matchesNoise([event.reason], noListenerNoisePatterns)) event.preventDefault();
    if (matchesNoise([event.reason], statsigNoisePatterns)) event.preventDefault();
  });
  window.addEventListener("error", (event) => {
    if (matchesNoise([event.message, event.error], noListenerNoisePatterns)) event.preventDefault();
    if (matchesNoise([event.message, event.error], statsigNoisePatterns)) event.preventDefault();
  });

  const codexappLoadMarks = {
    startedAt: performance.now(),
    firstBodyTextAt: null,
    firstThreadScrollerAt: null,
    firstHistoryManagerAt: null,
    firstThreadTurnsAt: null,
    lastSampleAt: null,
  };
  window.__codexappLoadMarks = codexappLoadMarks;
  function markCodexappLoadProgress() {
    const now = performance.now();
    codexappLoadMarks.lastSampleAt = now;
    if (codexappLoadMarks.firstBodyTextAt == null && (document.body?.innerText || "").trim().length > 0) {
      codexappLoadMarks.firstBodyTextAt = now;
    }
    if (codexappLoadMarks.firstThreadScrollerAt == null && document.querySelector(".thread-scroll-container")) {
      codexappLoadMarks.firstThreadScrollerAt = now;
    }
    const managers = window.__codexappHistoryManagers instanceof Set
      ? Array.from(window.__codexappHistoryManagers)
      : [];
    if (codexappLoadMarks.firstHistoryManagerAt == null && managers.length > 0) {
      codexappLoadMarks.firstHistoryManagerAt = now;
    }
    if (codexappLoadMarks.firstThreadTurnsAt == null && managers.some((manager) => {
      try {
        return Array.from(manager?.conversations?.values?.() || []).some((conversation) => Array.isArray(conversation?.turns) && conversation.turns.length > 0);
      } catch {
        return false;
      }
    })) {
      codexappLoadMarks.firstThreadTurnsAt = now;
    }
  }
  const codexappLoadMarksTimer = setInterval(() => {
    markCodexappLoadProgress();
    if (codexappLoadMarks.firstThreadTurnsAt != null || performance.now() - codexappLoadMarks.startedAt > 30000) {
      clearInterval(codexappLoadMarksTimer);
    }
  }, 50);
  setTimeout(markCodexappLoadProgress, 0);

  function isStatsigEventUrl(input) {
    const url = typeof input === "string" ? input : input?.url;
    return typeof url === "string" && (url.includes("chatgpt.com/ces/v1/rgstr") || url.includes("/ces/v1/rgstr"));
  }

  const rawFetch = window.fetch?.bind(window);
  if (rawFetch) {
    window.fetch = (input, init) => {
      if (isStatsigEventUrl(input)) {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
      }
      return rawFetch(input, init);
    };
  }

  function codexappThreadIdFromPath() {
    const parts = String(location.pathname || "").split("/").filter(Boolean);
    const index = parts.indexOf("local");
    return index >= 0 ? parts[index + 1] || null : null;
  }

  function codexappFastShellText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(codexappFastShellText).filter(Boolean).join("\\n");
    if (typeof value !== "object") return "";
    if (typeof value.text === "string") return value.text;
    if (typeof value.message === "string") return value.message;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return codexappFastShellText(value.content);
    return "";
  }

  function codexappFastShellTurnText(turn) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return items.map((item) => codexappFastShellText(item?.content ?? item?.text ?? item?.message ?? item))
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\\n\\n");
  }

  function codexappFastShellMcpRequest(method, params = {}, timeoutMs = 120000) {
    const id = "fast-shell-" + randomBridgeId();
    return new Promise((resolve, reject) => {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        reject(new Error("bridge is not ready"));
        return;
      }
      let settled = false;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timeout);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.type !== "mcp-response" || data.message?.id !== id) return;
        if (data.message.error) {
          finish(reject, new Error(data.message.error.message || "request failed"));
          return;
        }
        finish(resolve, data.message.result ?? {});
      };
      const timeout = setTimeout(() => finish(reject, new Error(method + " timed out")), timeoutMs);
      window.addEventListener("message", onMessage);
      try {
        bridge.sendMessageFromView({
          type: "mcp-request",
          hostId: "local",
          request: { id, method, params }
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function codexappFastShellChronologicalFromResult(result) {
    return Array.isArray(result?.data) ? result.data.slice().reverse() : [];
  }

  async function codexappFastShellFetchTurns(threadId, cursor, limit = 8) {
    if (!rawFetch) throw new Error("fetch is not ready");
    const url = "/codexapp-thread-turns?threadId=" + encodeURIComponent(threadId)
      + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")
      + "&limit=" + encodeURIComponent(String(limit));
    const response = await rawFetch(url, { headers: { "accept": "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("history request failed with " + response.status);
    return await response.json();
  }

  function codexappFastShellTurnKey(turn, index = 0) {
    return String(turn?.turnId || turn?.id || turn?.codexappFastLocalId || index);
  }

  function codexappBuildFastShellTurnBlock(turn, index = 0) {
    const block = document.createElement("section");
    block.dataset.codexappTurnKey = codexappFastShellTurnKey(turn, index);
    block.style.cssText = "margin:14px 0;padding:14px 16px;border-radius:8px;background:" + (turn?.status === "inProgress" ? "#fff8ef" : "#f6f6f6") + ";white-space:pre-wrap;overflow-wrap:anywhere;";
    const text = codexappFastShellTurnText(turn);
    block.textContent = text || (turn?.status === "inProgress" ? "正在运行..." : "");
    return block;
  }

  function codexappFastShellSetStatus(shell, text) {
    const status = shell?.querySelector?.("[data-codexapp-fast-status]");
    if (status) status.textContent = text || "";
  }

  function codexappFastShellTrim(shell, direction = "older") {
    const list = shell?.querySelector?.("[data-codexapp-fast-turns]");
    if (!list) return;
    while (list.children.length > 24) {
      if (direction === "older") list.lastElementChild?.remove();
      else list.firstElementChild?.remove();
    }
  }

  function codexappFastShellPrependTurns(shell, turns) {
    const list = shell?.querySelector?.("[data-codexapp-fast-turns]");
    if (!list || !Array.isArray(turns) || turns.length === 0) return 0;
    const beforeHeight = shell.scrollHeight;
    const seen = new Set(Array.from(list.children).map((node) => node.dataset.codexappTurnKey));
    const anchor = list.firstChild;
    let inserted = 0;
    turns.forEach((turn, index) => {
      const key = codexappFastShellTurnKey(turn, index);
      if (seen.has(key)) return;
      list.insertBefore(codexappBuildFastShellTurnBlock(turn, index), anchor);
      seen.add(key);
      inserted += 1;
    });
    codexappFastShellTrim(shell, "older");
    shell.scrollTop += Math.max(0, shell.scrollHeight - beforeHeight);
    return inserted;
  }

  function codexappFastShellAppendTurn(shell, turn) {
    const list = shell?.querySelector?.("[data-codexapp-fast-turns]");
    if (!list || !turn) return;
    list.appendChild(codexappBuildFastShellTurnBlock(turn, list.children.length));
    codexappFastShellTrim(shell, "newer");
    shell.scrollTop = shell.scrollHeight;
  }

  async function codexappFastShellLoadOlder(shell, state) {
    if (!shell || !state || state.loadingOlder || !state.olderCursor) return;
    state.loadingOlder = true;
    const button = shell.querySelector("[data-codexapp-fast-load-older]");
    if (button) button.disabled = true;
    codexappFastShellSetStatus(shell, "正在加载更早历史...");
    try {
      let inserted = 0;
      let pages = 0;
      while (state.olderCursor && inserted === 0 && pages < 4) {
        pages += 1;
        const result = await codexappFastShellFetchTurns(state.threadId, state.olderCursor, 8);
        const turns = codexappFastShellChronologicalFromResult(result);
        state.olderCursor = result?.nextCursor ?? result?.backwardsCursor ?? null;
        inserted += codexappFastShellPrependTurns(shell, turns);
      }
      if (inserted > 0) codexappFastShellSetStatus(shell, state.olderCursor ? "已加载更早历史，继续上滚可再加载。" : "已经到达最早历史。");
      else codexappFastShellSetStatus(shell, state.olderCursor ? "这一段全是重叠内容，继续上滚会再补页。" : "已经到达最早历史。");
      if (!state.olderCursor && button) button.textContent = "没有更早历史";
    } catch (error) {
      codexappFastShellSetStatus(shell, "加载历史失败：" + (error.message || String(error)));
    } finally {
      state.loadingOlder = false;
      if (button) button.disabled = !state.olderCursor;
    }
  }

  async function codexappFastShellSubmit(shell, state) {
    const input = shell?.querySelector?.("[data-codexapp-fast-input]");
    const button = shell?.querySelector?.("[data-codexapp-fast-send]");
    const text = (input?.value || "").trim();
    if (!text || state?.sending) return;
    state.sending = true;
    if (button) button.disabled = true;
    if (input) input.value = "";
    codexappFastShellAppendTurn(shell, {
      codexappFastLocalId: "local-" + randomBridgeId(),
      status: "inProgress",
      items: [{ content: { text } }]
    });
    codexappFastShellSetStatus(shell, "已发送，正在接入长线程...");
    try {
      const method = state.hasActiveTurn ? "turn/steer" : "turn/start";
      await codexappFastShellMcpRequest(method, {
        threadId: state.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        clientRequestId: "fast-shell-" + randomBridgeId()
      }, 20000);
      state.hasActiveTurn = true;
      codexappFastShellSetStatus(shell, "已提交；后台继续执行，窗口会持续可查。");
    } catch (error) {
      codexappFastShellSetStatus(shell, "发送失败：" + (error.message || String(error)));
    } finally {
      state.sending = false;
      if (button) button.disabled = false;
    }
  }

  function codexappRootHasOfficialThread(root, threadId = null) {
    if (!root) return false;
    const activeThreadId = typeof threadId === "string" && threadId.length > 0 ? threadId : codexappThreadIdFromPath();
    const managers = window.__codexappHistoryManagers instanceof Set
      ? Array.from(window.__codexappHistoryManagers)
      : [];
    if (activeThreadId && managers.some((manager) => {
      try {
        const conversation = manager?.conversations?.get?.(activeThreadId);
        return Array.isArray(conversation?.turns) && conversation.turns.length > 0;
      } catch {
        return false;
      }
    })) {
      return true;
    }
    const marked = root.querySelector("[data-codexapp-conversation-id]");
    if (activeThreadId && marked?.getAttribute?.("data-codexapp-conversation-id") === activeThreadId) {
      return !!root.querySelector(".thread-scroll-container [data-testid^='conversation-turn'], .thread-scroll-container [data-message-author-role]");
    }
    return false;
  }

  function codexappDismissFastThreadShellIfReady() {
    const root = document.getElementById("root");
    const shell = document.getElementById("codexapp-fast-thread-shell");
    const threadId = shell?.__codexappFastShellState?.threadId || codexappThreadIdFromPath();
    if (!shell || !codexappRootHasOfficialThread(root, threadId)) return false;
    shell.remove();
    codexappLoadMarks.fastShellDismissedAt ??= performance.now();
    return true;
  }

  function codexappWatchFastThreadShellDismissal() {
    if (window.__codexappFastThreadShellDismissWatcher) return;
    window.__codexappFastThreadShellDismissWatcher = setInterval(() => {
      if (codexappDismissFastThreadShellIfReady()) {
        clearInterval(window.__codexappFastThreadShellDismissWatcher);
        window.__codexappFastThreadShellDismissWatcher = null;
      }
    }, 100);
    setTimeout(() => {
      if (window.__codexappFastThreadShellDismissWatcher) {
        clearInterval(window.__codexappFastThreadShellDismissWatcher);
        window.__codexappFastThreadShellDismissWatcher = null;
      }
    }, 45000);
  }

  function codexappRenderFastThreadShell(payload) {
    const root = document.getElementById("root");
    codexappLoadMarks.fastShellRenderAttemptAt = performance.now();
    if (root && codexappRootHasOfficialThread(root, payload?.thread?.id || codexappThreadIdFromPath())) return false;
    const thread = payload?.thread;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (!thread || turns.length === 0) return false;
    const mount = document.body || document.documentElement;
    if (!mount) return false;
    document.getElementById("codexapp-fast-thread-shell")?.remove();
    if (window.__codexappLongThreadRescue && root) {
      root.style.display = "none";
      root.setAttribute("aria-hidden", "true");
    }
    const shell = document.createElement("div");
    shell.id = "codexapp-fast-thread-shell";
    shell.style.cssText = "position:fixed;inset:0;z-index:2147483000;overflow:auto;background:#fff;color:#171717;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;";
    shell.setAttribute("role", "status");
    shell.setAttribute("aria-live", "polite");
    const inner = document.createElement("div");
    inner.style.cssText = "max-width:860px;margin:0 auto;padding:28px 24px 128px;";
    const title = document.createElement("div");
    title.style.cssText = "position:sticky;top:0;background:#fff;padding:8px 0 16px;margin-bottom:8px;border-bottom:1px solid #eee;color:#555;font-size:13px;";
    title.textContent = (thread.title || thread.name || "Codex thread") + " · 快速长线程窗口";
    inner.appendChild(title);
    const state = {
      threadId: thread.id || thread.sessionId || codexappThreadIdFromPath(),
      olderCursor: thread.turnsPagination?.olderCursor ?? payload?.initialTurnsPage?.nextCursor ?? null,
      hasActiveTurn: turns.some((turn) => turn?.status === "inProgress"),
      loadingOlder: false,
      sending: false
    };
    shell.__codexappFastShellState = state;
    const loadOlder = document.createElement("button");
    loadOlder.type = "button";
    loadOlder.dataset.codexappFastLoadOlder = "1";
    loadOlder.style.cssText = "display:block;width:100%;margin:12px 0 16px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#555;font:13px system-ui;cursor:pointer;";
    loadOlder.textContent = state.olderCursor ? "加载更早历史" : "没有更早历史";
    loadOlder.disabled = !state.olderCursor;
    loadOlder.addEventListener("click", () => { void codexappFastShellLoadOlder(shell, state); });
    inner.appendChild(loadOlder);
    const list = document.createElement("div");
    list.dataset.codexappFastTurns = "1";
    turns.forEach((turn, index) => list.appendChild(codexappBuildFastShellTurnBlock(turn, index)));
    inner.appendChild(list);
    const footer = document.createElement("div");
    footer.dataset.codexappFastStatus = "1";
    footer.style.cssText = "color:#777;font-size:13px;margin:20px 0;";
    footer.textContent = "完整界面正在接管；此窗口可先查历史和提交消息。";
    inner.appendChild(footer);
    const composer = document.createElement("form");
    composer.style.cssText = "position:sticky;bottom:0;margin:18px 0 0;padding:12px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.08);";
    const textarea = document.createElement("textarea");
    textarea.dataset.codexappFastInput = "1";
    textarea.rows = 3;
    textarea.placeholder = "输入消息";
    textarea.style.cssText = "box-sizing:border-box;width:100%;resize:vertical;border:0;outline:0;font:14px/1.45 system-ui;background:#fff;color:#171717;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;color:#777;font-size:12px;";
    const hint = document.createElement("span");
    hint.textContent = "Enter 发送，Shift+Enter 换行";
    const sendButton = document.createElement("button");
    sendButton.type = "submit";
    sendButton.dataset.codexappFastSend = "1";
    sendButton.textContent = "发送";
    sendButton.style.cssText = "border:0;border-radius:999px;background:#171717;color:#fff;padding:8px 16px;font:13px system-ui;cursor:pointer;";
    actions.appendChild(hint);
    actions.appendChild(sendButton);
    composer.appendChild(textarea);
    composer.appendChild(actions);
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      void codexappFastShellSubmit(shell, state);
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault();
        void codexappFastShellSubmit(shell, state);
      }
    });
    inner.appendChild(composer);
    shell.appendChild(inner);
    shell.addEventListener("scroll", () => {
      if (shell.scrollTop < 96) void codexappFastShellLoadOlder(shell, state);
    }, { passive: true });
    mount.appendChild(shell);
    const now = performance.now();
    codexappLoadMarks.firstFastShellAt ??= now;
    codexappLoadMarks.firstBodyTextAt ??= now;
    codexappLoadMarks.fastShellTurns = turns.length;
    codexappWatchFastThreadShellDismissal();
    return true;
  }

  function installCodexappFastThreadShell() {
    if (!rawFetch) {
      codexappLoadMarks.fastShellSkipReason = "fetch-unavailable";
      return false;
    }
    const threadId = codexappThreadIdFromPath();
    if (!threadId) {
      codexappLoadMarks.fastShellSkipReason = "not-thread-route";
      return false;
    }
    if (window.__codexappFastThreadShellStarted === threadId) return true;
    const root = document.getElementById("root");
    if (root && codexappRootHasOfficialThread(root, threadId)) {
      codexappLoadMarks.fastShellSkipReason = "official-thread-ready";
      return false;
    }
    window.__codexappFastThreadShellStarted = threadId;
    codexappLoadMarks.fastShellRequestedAt = performance.now();
    rawFetch("/codexapp-thread-fast?threadId=" + encodeURIComponent(threadId), {
      headers: { "accept": "application/json" },
      cache: "no-store",
    })
      .then((response) => {
        codexappLoadMarks.fastShellResponseAt = performance.now();
        codexappLoadMarks.fastShellStatus = response.status;
        return response.ok ? response.json() : null;
      })
      .then((payload) => {
        if (payload) {
          const rendered = codexappRenderFastThreadShell(payload);
          codexappLoadMarks.fastShellRendered = rendered;
          if (!rendered) {
            setTimeout(() => { codexappLoadMarks.fastShellRendered = codexappRenderFastThreadShell(payload); }, 50);
            setTimeout(() => { codexappLoadMarks.fastShellRendered = codexappRenderFastThreadShell(payload); }, 250);
          }
        }
      })
      .catch((error) => {
        codexappLoadMarks.fastShellError = String(error?.message || error || "unknown");
      });
    return true;
  }
  function scheduleCodexappFastThreadShell() {
    setTimeout(installCodexappFastThreadShell, 0);
    setTimeout(installCodexappFastThreadShell, 100);
    setTimeout(installCodexappFastThreadShell, 500);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installCodexappFastThreadShell, { once: true });
    } else {
      installCodexappFastThreadShell();
    }
  }
  scheduleCodexappFastThreadShell();

  try {
    const rawSendBeacon = navigator.sendBeacon?.bind(navigator);
    if (rawSendBeacon) {
      navigator.sendBeacon = (url, data) => isStatsigEventUrl(url) ? true : rawSendBeacon(url, data);
    }
  } catch {}

  function isUsageRemainingNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    const text = (node.textContent || "").replace(/\\s+/g, "");
    if (!text.includes("%")) return false;
    return /(5小时|5h)/i.test(text) && /(1周|Weekly|week)/i.test(text);
  }

  function styleUsageRemaining() {
    const candidates = document.querySelectorAll(".composer-footer__label--sm, .composer-footer span, span");
    for (const candidate of candidates) {
      if (!isUsageRemainingNode(candidate)) continue;
      candidate.dataset.codexappUsageStyled = "1";
      candidate.classList.remove("rounded-full", "border", "border-token-border-light", "shadow-sm");
      Object.assign(candidate.style, {
        marginLeft: "auto",
        border: "0px",
        background: "transparent",
        boxShadow: "none",
        borderRadius: "0px",
        padding: "0px",
        marginRight: "8px",
        fontWeight: "400",
        minWidth: "max-content",
        order: "99"
      });
      const parent = candidate.parentElement;
      if (parent instanceof HTMLElement) {
        parent.style.width = "100%";
      }
    }
  }

  function managedPermissionLabel() {
    return managedSandboxFallbackMode === "read-only" ? "Read only" : "Workspace";
  }

  function managedWorkspaceLabel() {
    return managedSandboxFallbackMode === "read-only" ? "read-only" : "workspace-write";
  }

  function replaceManagedPermissionText(text) {
    if (typeof text !== "string") return text;
    if (!/(完全访问|Full access|danger-full-access)/i.test(text)) return text;
    const exact = text.trim();
    if (/^(完全访问|Full access)$/i.test(exact)) return managedPermissionLabel();
    if (/^danger-full-access$/i.test(exact)) return managedWorkspaceLabel();
    return text
      .replace(/完全访问/g, managedPermissionLabel())
      .replace(/Full access/gi, managedPermissionLabel())
      .replace(/danger-full-access/gi, managedWorkspaceLabel());
  }

  function managedPermissionUiHost(element) {
    let node = element;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const text = (node.textContent || "").trim();
      if (/完全访问|Full access|danger-full-access/i.test(text)) return node;
      if (node.getAttribute?.("role") === "button" || node.tagName === "BUTTON") return node;
    }
    return element;
  }

  function styleManagedPermissionState() {
    return;
  }

  function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function isDangerFullAccessValue(value) {
    if (typeof value !== "string") return false;
    const normalized = value.trim();
    const compact = normalized.replace(/^:/, "").replace(/[-_\s]/g, "").toLowerCase();
    return normalized === "danger-full-access"
      || normalized === "dangerFullAccess"
      || normalized === "danger_full_access"
      || normalized === ":danger-full-access"
      || compact === "dangerfullaccess"
      || compact === "fullaccess";
  }

  function normalizedManagedConfigKey(key) {
    return String(key || "").split(".").pop().replace(/[-_]/g, "").toLowerCase();
  }

  function managedWorkspaceSandboxPolicy(previousPolicy = {}) {
    if (managedSandboxFallbackMode === "read-only") {
      return { type: "readOnly", networkAccess: false };
    }
    return {
      type: "workspaceWrite",
      writableRoots: Array.isArray(previousPolicy && previousPolicy.writableRoots) ? previousPolicy.writableRoots : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }

  function sanitizeManagedPermissionTree(value, parentKey = "") {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const sanitized = sanitizeManagedPermissionTree(item, parentKey);
        if (sanitized !== item) changed = true;
        return sanitized;
      });
      return changed ? next : value;
    }
    if (!isPlainObject(value)) return value;
    const parentNormalized = normalizedManagedConfigKey(parentKey);
    if (parentNormalized === "sandboxpolicy" && isDangerFullAccessValue(value.type)) {
      return managedWorkspaceSandboxPolicy(value);
    }
    let changed = false;
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedManagedConfigKey(key);
      const compactKey = String(key || "").replace(/[-_]/g, "").toLowerCase();
      if (normalized === "approvalsreviewer") {
        changed = true;
        continue;
      }
      if (normalized === "approvalpolicy") {
        next[key] = "never";
        if (child !== "never") changed = true;
        continue;
      }
      if (normalized === "sandbox" || normalized === "sandboxmode") {
        next[key] = managedSandboxFallbackMode;
        if (child !== managedSandboxFallbackMode) changed = true;
        continue;
      }
      if (normalized === "sandboxpolicy") {
        next[key] = managedWorkspaceSandboxPolicy(child);
        if (JSON.stringify(next[key]) !== JSON.stringify(child)) changed = true;
        continue;
      }
      if (normalized === "sandboxworkspacewrite" || normalized === "sandboxpermissions" || compactKey.startsWith("sandboxworkspacewrite.")) {
        changed = true;
        continue;
      }
      if (normalized === "defaultpermissions" || normalized === "permissionprofile" || normalized === "permissionprofileid") {
        next[key] = managedPermissionProfile;
        if (child !== managedPermissionProfile) changed = true;
        continue;
      }
      if (normalized === "activepermissionprofile") {
        if (isDangerFullAccessValue(child) || isDangerFullAccessValue(child?.id) || isDangerFullAccessValue(child?.type)) {
          next[key] = null;
          changed = true;
        } else {
          const sanitized = sanitizeManagedPermissionTree(child, key);
          next[key] = sanitized;
          if (sanitized !== child) changed = true;
        }
        continue;
      }
      const sanitized = sanitizeManagedPermissionTree(child, key);
      next[key] = sanitized;
      if (sanitized !== child) changed = true;
    }
    return changed ? next : value;
  }

  function sanitizeManagedConfigWriteValue(keyPath, value) {
    const normalized = normalizedManagedConfigKey(keyPath);
    if (normalized === "defaultpermissions" || normalized === "permissionprofile" || normalized === "permissionprofileid") {
      return managedPermissionProfile;
    }
    if (normalized === "activepermissionprofile"
      && (isDangerFullAccessValue(value) || isDangerFullAccessValue(value?.id) || isDangerFullAccessValue(value?.type))) {
      return null;
    }
    if (normalized === "sandbox" || normalized === "sandboxmode") return managedSandboxFallbackMode;
    if (normalized === "sandboxpolicy") return managedWorkspaceSandboxPolicy(value);
    return sanitizeManagedPermissionTree(value, keyPath);
  }

  function sanitizeManagedConfigWriteParams(method, params = {}) {
    if (!isPlainObject(params)) return params;
    if (method === "config/value/write") {
      return { ...params, value: sanitizeManagedConfigWriteValue(params.keyPath, params.value) };
    }
    if (method === "config/batchWrite" && Array.isArray(params.edits)) {
      return {
        ...params,
        edits: params.edits.map((edit) => {
          if (!isPlainObject(edit)) return edit;
          return { ...edit, value: sanitizeManagedConfigWriteValue(edit.keyPath, edit.value) };
        })
      };
    }
    return params;
  }

  function sanitizeManagedClientRequest(request) {
    if (!request || typeof request.method !== "string") return request;
    const method = String(request.method || "");
    const params = method === "config/value/write" || method === "config/batchWrite"
      ? sanitizeManagedConfigWriteParams(method, request.params || {})
      : sanitizeManagedPermissionTree(request.params || {}, method);
    return { ...request, params };
  }

  function sanitizeManagedPersistedAtomValue(key, value) {
    if (key === "composer-permission-mode-visibility" && isPlainObject(value)) {
      return { ...value, "guardian-approvals": true, "full-access": true };
    }
    return value;
  }

  function sanitizeManagedClientMessage(message) {
    return message;
  }

  const threadHistoryLoadState = new Map();

  function threadIdFromLocationPath() {
    const parts = String(location.pathname || "").split("/").filter(Boolean);
    const index = parts.indexOf("local");
    const value = index >= 0 ? parts[index + 1] : null;
    return value ? decodeURIComponent(value) : null;
  }

  function activeThreadIdFallback() {
    const fromPath = threadIdFromLocationPath();
    if (fromPath) return fromPath;
    const resolver = window.__codexappResolveActiveThreadId;
    const resolved = typeof resolver === "function" ? resolver() : null;
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  }

  const routeThreadHydrationState = new Map();

  function threadHistoryManagers() {
    const managers = window.__codexappHistoryManagers;
    return managers instanceof Set ? Array.from(managers) : [];
  }

  function managerConversation(manager, threadId) {
    if (!manager || !threadId) return null;
    try {
      if (typeof manager.getConversation === "function") {
        const conversation = manager.getConversation(threadId);
        if (conversation != null) return conversation;
      }
      return manager.conversations?.get?.(threadId) ?? null;
    } catch {
      return null;
    }
  }

  function historyManagerForThreadId(threadId) {
    const managers = threadHistoryManagers();
    for (const manager of managers) {
      if (managerConversation(manager, threadId) != null) return manager;
    }
    for (const manager of managers) {
      if (typeof manager?.readThread === "function") return manager;
    }
    return null;
  }

  function routeThreadNeedsHydration(conversation) {
    if (!conversation) return true;
    const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
    const pagination = conversation.turnsPagination ?? null;
    if (conversation.resumeState !== "resumed") return true;
    if (turns.length <= 1) return true;
    if (!pagination) return true;
    if (pagination.hasLoadedOldest === true && turns.length <= 1) return true;
    if (pagination.olderCursor == null && pagination.hasLoadedOldest !== true) return true;
    return false;
  }

  function normalizeRouteTurnForManager(turn, fallbackCwd) {
    if (!isPlainObject(turn)) return turn;
    return {
      ...turn,
      turnId: turn.turnId || turn.id || null,
      params: isPlainObject(turn.params) ? turn.params : { cwd: fallbackCwd ?? null },
      items: Array.isArray(turn.items) ? turn.items : []
    };
  }

  function normalizeRouteThreadForManager(thread, previous, threadId) {
    const fallbackCwd = thread?.cwd || previous?.cwd || thread?.latestThreadSettings?.cwd || previous?.latestThreadSettings?.cwd || null;
    const turns = (Array.isArray(thread?.turns)
      ? thread.turns
      : (Array.isArray(previous?.turns) ? previous.turns : []))
      .map((turn) => normalizeRouteTurnForManager(turn, fallbackCwd));
    const requests = Array.isArray(thread?.requests)
      ? thread.requests.map((request) => ({
        ...(isPlainObject(request) ? request : {}),
        params: isPlainObject(request?.params) ? request.params : { cwd: null },
        items: Array.isArray(request?.items) ? request.items : []
      }))
      : [];
    const currentPermissions = thread?.currentPermissions || previous?.currentPermissions || null;
    const latestModel = thread?.latestModel || previous?.latestModel || thread?.model || "";
    const latestReasoningEffort = thread?.latestReasoningEffort ?? previous?.latestReasoningEffort ?? null;
    return {
      ...(previous || {}),
      ...(thread || {}),
      id: thread?.id || previous?.id || threadId,
      sessionId: thread?.sessionId || previous?.sessionId || thread?.id || threadId,
      hostId: thread?.hostId || previous?.hostId || "local",
      title: thread?.title || thread?.name || previous?.title || previous?.name || "",
      name: thread?.name || thread?.title || previous?.name || previous?.title || "",
      turns,
      requests,
      resumeState: "resumed",
      threadRuntimeStatus: thread?.threadRuntimeStatus || thread?.status || previous?.threadRuntimeStatus || { type: "idle" },
      turnsPagination: thread?.turnsPagination || previous?.turnsPagination || {
        olderCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: true
      },
      rolloutPath: thread?.rolloutPath || thread?.path || previous?.rolloutPath || previous?.path || null,
      latestModel,
      latestReasoningEffort,
      previousTurnModel: thread?.previousTurnModel ?? previous?.previousTurnModel ?? null,
      latestCollaborationMode: thread?.latestCollaborationMode || previous?.latestCollaborationMode || {
        mode: "default",
        settings: {
          reasoning_effort: latestReasoningEffort,
          model: latestModel,
          developer_instructions: null
        }
      },
      hasUnreadTurn: Boolean(thread?.hasUnreadTurn ?? previous?.hasUnreadTurn ?? false),
      threadGoal: thread?.threadGoal ?? previous?.threadGoal ?? null,
      latestTokenUsageInfo: thread?.latestTokenUsageInfo ?? previous?.latestTokenUsageInfo ?? null,
      workspaceKind: thread?.workspaceKind || previous?.workspaceKind || "project",
      workspaceBrowserRoot: thread?.workspaceBrowserRoot ?? previous?.workspaceBrowserRoot ?? null,
      projectlessOutputDirectory: thread?.projectlessOutputDirectory ?? previous?.projectlessOutputDirectory ?? null,
      currentPermissions,
      latestThreadSettings: thread?.latestThreadSettings || previous?.latestThreadSettings || null
    };
  }

  function applyRouteThreadConversation(manager, threadId, conversation) {
    if (!manager || !conversation) return false;
    try {
      if (typeof manager.setConversation === "function") {
        manager.setConversation(conversation);
        return true;
      }
      if (typeof manager.applyConversationState === "function") {
        manager.applyConversationState(threadId, conversation);
        return true;
      }
      if (manager.conversations instanceof Map) {
        manager.conversations.set(threadId, conversation);
        return true;
      }
    } catch (error) {
      rawConsoleWarn("[codexapp] route thread apply failed", threadId, error);
    }
    return false;
  }

  function hydrateCurrentRouteThread() {
    const threadId = threadIdFromLocationPath();
    if (!threadId) return;
    const manager = historyManagerForThreadId(threadId);
    if (!manager || typeof manager.readThread !== "function") return;
    const current = managerConversation(manager, threadId);
    const now = Date.now();
    const state = routeThreadHydrationState.get(threadId) || {
      inFlight: false,
      lastAttemptAt: 0,
      completedAt: 0
    };
    if (!routeThreadNeedsHydration(current)) {
      state.completedAt = now;
      routeThreadHydrationState.set(threadId, state);
      return;
    }
    if (state.inFlight && now - state.lastAttemptAt < 15000) return;
    if (!state.inFlight && now - state.lastAttemptAt < 1500) return;
    state.inFlight = true;
    state.lastAttemptAt = now;
    routeThreadHydrationState.set(threadId, state);
    Promise.resolve(manager.readThread(threadId, { includeTurns: true }))
      .then((result) => {
        const thread = result?.thread || result?.conversation || result;
        if (!isPlainObject(thread)) return;
        const previous = managerConversation(manager, threadId);
        const next = normalizeRouteThreadForManager(thread, previous, threadId);
        if (applyRouteThreadConversation(manager, threadId, next)) {
          state.completedAt = Date.now();
        }
      })
      .catch((error) => rawConsoleWarn("[codexapp] route thread hydrate failed", threadId, error))
      .finally(() => {
        state.inFlight = false;
      });
  }

  function conversationIdFromThreadContainer(container) {
    const ownThreadId = container?.getAttribute?.("data-codexapp-conversation-id") || "";
    if (ownThreadId.length > 0) return ownThreadId;
    const node = container?.querySelector?.("[data-codexapp-conversation-id]");
    const threadId = node?.getAttribute?.("data-codexapp-conversation-id") || "";
    return threadId.length > 0 ? threadId : activeThreadIdFallback();
  }

  function elementLooksLikeThreadHistoryScroller(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const overflow = String(style.overflowY || "") + " " + String(style.overflow || "");
    const className = typeof element.className === "string" ? element.className : "";
    return /(auto|scroll|overlay)/.test(overflow)
      || /\b(thread-scroll-container|overflow-y-auto|overflow-auto)\b/.test(className);
  }

  function nearestThreadHistoryScroller(root) {
    let node = root instanceof HTMLElement ? root : root?.parentElement;
    while (node && node instanceof HTMLElement && node !== document.body) {
      if (elementLooksLikeThreadHistoryScroller(node) && conversationIdFromThreadContainer(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function threadHistoryScrollerCandidates() {
    const containers = new Set();
    for (const container of document.querySelectorAll(".thread-scroll-container")) {
      if (container instanceof HTMLElement) containers.add(container);
    }
    for (const root of document.querySelectorAll("[data-codexapp-conversation-id], [data-thread-find-target='conversation']")) {
      const container = nearestThreadHistoryScroller(root);
      if (container) containers.add(container);
    }
    return containers;
  }

  function threadHistoryDistanceFromBottom(container) {
    const style = getComputedStyle(container);
    if (/reverse/.test(style.flexDirection || "")) return Math.max(0, -container.scrollTop);
    return Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
  }

  function isNearThreadHistoryHead(container) {
    const maxDistance = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxDistance < 256) return true;
    const distance = threadHistoryDistanceFromBottom(container);
    return maxDistance - distance <= Math.max(640, Math.round(container.clientHeight * 0.75));
  }

  function isNearThreadHistoryTail(container) {
    return threadHistoryDistanceFromBottom(container) <= Math.max(640, Math.round(container.clientHeight * 0.75));
  }

  let threadScrollAnchorCounter = 0;

  function visibleTextElement(element, containerRect, container) {
    if (!(element instanceof HTMLElement)) return false;
    if (element === container) return false;
    const text = (element.innerText || element.textContent || "").trim();
    if (text.length < 8) return false;
    const rect = element.getBoundingClientRect();
    if (rect.height < 8 || rect.width < 40) return false;
    return rect.bottom > containerRect.top + 24 && rect.top < containerRect.bottom - 24;
  }

  function captureThreadScrollAnchor(container) {
    if (!(container instanceof HTMLElement)) return null;
    const containerRect = container.getBoundingClientRect();
    const targetY = containerRect.top + Math.min(
      Math.max(96, Math.round(container.clientHeight * 0.35)),
      Math.max(96, container.clientHeight - 96),
    );
    const candidates = Array.from(container.querySelectorAll("[data-testid], article, [role='article'], [data-message-id], [data-turn-id], div, p"))
      .filter((element) => visibleTextElement(element, containerRect, container));
    if (candidates.length === 0) return {
      id: null,
      top: null,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const distance = Math.abs(ar.top - targetY) - Math.abs(br.top - targetY);
      if (distance !== 0) return distance;
      return (ar.height * ar.width) - (br.height * br.width);
    });
    const element = candidates[0];
    const id = "anchor-" + (++threadScrollAnchorCounter) + "-" + Math.random().toString(16).slice(2);
    try { element.dataset.codexappScrollAnchor = id; } catch {}
    return {
      id,
      top: element.getBoundingClientRect().top,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
  }

  function restoreThreadScrollAnchor(container, anchor) {
    if (!(container instanceof HTMLElement) || !anchor) return;
    let attempts = 0;
    const fallback = () => {
      const delta = container.scrollHeight - Number(anchor.scrollHeight || 0);
      if (Math.abs(delta) > 1) container.scrollTop = Number(anchor.scrollTop || 0) + delta;
      else container.scrollTop = Number(anchor.scrollTop || 0);
    };
    const apply = () => {
      attempts += 1;
      let restored = false;
      if (anchor.id) {
        const element = container.querySelector("[data-codexapp-scroll-anchor='" + anchor.id + "']");
        if (element instanceof HTMLElement) {
          const delta = element.getBoundingClientRect().top - Number(anchor.top || 0);
          if (Math.abs(delta) > 1) container.scrollTop += delta;
          try { delete element.dataset.codexappScrollAnchor; } catch {}
          restored = true;
        }
      }
      if (!restored && attempts >= 2) fallback();
      if (attempts < 3) requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
  }

  function canLoadOlderThreadHistory(threadId) {
    const getter = window.__codexappGetThreadHistoryPagination;
    const pagination = typeof getter === "function" ? getter(threadId) : null;
    if (!pagination) return true;
    if (pagination.isLoadingOlder === true) return false;
    if (pagination.hasLoadedOldest === true) return false;
    return pagination.olderCursor != null;
  }

  function maybeLoadOlderThreadHistory(container, reason) {
    if (!(container instanceof HTMLElement)) return;
    if (!isNearThreadHistoryHead(container)) return;
    const threadId = conversationIdFromThreadContainer(container);
    if (!threadId) return;
    const shifter = window.__codexappShiftThreadHistoryWindow;
    let anchor = null;
    if (typeof shifter === "function") {
      anchor = captureThreadScrollAnchor(container);
      if (shifter(threadId, "older")) {
        restoreThreadScrollAnchor(container, anchor);
        return;
      }
    }
    if (!canLoadOlderThreadHistory(threadId)) return;
    const loader = window.__codexappLoadOlderThreadHistory;
    if (typeof loader !== "function") return;
    const now = Date.now();
    const state = threadHistoryLoadState.get(threadId) || { loading: false, lastStartedAt: 0 };
    if (state.loading && now - state.lastStartedAt < 10000) return;
    if (state.loading) {
      state.loading = false;
      rawConsoleWarn("[codexapp] older history load lock recovered", reason, threadId);
    }
    if (now - state.lastStartedAt < 700) return;
    state.loading = true;
    state.lastStartedAt = now;
    threadHistoryLoadState.set(threadId, state);
    const startedAt = state.lastStartedAt;
    anchor = anchor || captureThreadScrollAnchor(container);
    setTimeout(() => {
      if (state.loading && state.lastStartedAt === startedAt) state.loading = false;
    }, 12000);
    Promise.resolve(loader(threadId))
      .then(() => {
        restoreThreadScrollAnchor(container, anchor);
      })
      .catch((error) => rawConsoleWarn("[codexapp] older history load failed", reason, error))
      .finally(() => {
        state.loading = false;
      });
  }

  function maybeLoadNewerThreadHistory(container, reason) {
    if (!(container instanceof HTMLElement)) return;
    if (!isNearThreadHistoryTail(container)) return;
    const threadId = conversationIdFromThreadContainer(container);
    if (!threadId) return;
    const shifter = window.__codexappShiftThreadHistoryWindow;
    if (typeof shifter !== "function") return;
    const anchor = captureThreadScrollAnchor(container);
    if (!shifter(threadId, "newer")) return;
    restoreThreadScrollAnchor(container, anchor);
  }

  function installThreadHistoryLoader(container) {
    if (!(container instanceof HTMLElement)) return;
    if (container.dataset.codexappHistoryLoaderInstalled === "1") return;
    container.dataset.codexappHistoryLoaderInstalled = "1";
    const onScroll = () => {
      maybeLoadOlderThreadHistory(container, "scroll");
      maybeLoadNewerThreadHistory(container, "scroll");
    };
    const onWheel = (event) => {
      if (event.deltaY < 0) setTimeout(() => maybeLoadOlderThreadHistory(container, "wheel-up"), 0);
      if (event.deltaY > 0) setTimeout(() => maybeLoadNewerThreadHistory(container, "wheel-down"), 0);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    setTimeout(() => maybeLoadOlderThreadHistory(container, "install"), 0);
  }

  function installThreadHistoryLoaders() {
    for (const container of threadHistoryScrollerCandidates()) {
      installThreadHistoryLoader(container);
      maybeLoadOlderThreadHistory(container, "tick");
      maybeLoadNewerThreadHistory(container, "tick");
    }
  }

  function installUiShim() {
    const tick = () => {
      styleUsageRemaining();
      styleManagedPermissionState();
      hydrateCurrentRouteThread();
      installThreadHistoryLoaders();
    };
    tick();
    const observer = new MutationObserver(tick);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(tick, 2000);
  }

  function randomBridgeId() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  function bridgeClientId() {
    try {
      const tabClientIdKey = clientIdKey + ":tab";
      let value = sessionStorage.getItem(tabClientIdKey);
      if (!value) {
        value = randomBridgeId();
        sessionStorage.setItem(tabClientIdKey, value);
      }
      return value;
    } catch {
      return randomBridgeId();
    }
  }
  const tabClientIdKey = clientIdKey + ":tab";
  const reloadMarkerKey = tabClientIdKey + ":reload-marker";
  const reloadHandoffGraceMs = 10000;
  const bridgeInstanceNonce = randomBridgeId();
  let currentBridgeClientId = bridgeClientId();
  let bridgeChannel = null;

  function bridgeAckStorageKey(clientId = currentBridgeClientId) {
    return clientIdKey + ":last-ack:" + clientId;
  }

  function readLastBridgeAck(clientId = currentBridgeClientId) {
    try {
      const value = Number(sessionStorage.getItem(bridgeAckStorageKey(clientId)) || 0);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function rememberBridgeDispatch(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
    try {
      if (sequence > readLastBridgeAck()) {
        sessionStorage.setItem(bridgeAckStorageKey(), String(sequence));
      }
    } catch {}
  }

  function bridgeUrl() {
    const lastAck = readLastBridgeAck();
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "${bridgePath}?clientId=" + encodeURIComponent(currentBridgeClientId) + "&ack=" + encodeURIComponent(String(lastAck)) + "&version=" + encodeURIComponent(bridgeScriptVersion);
  }

  function rotateBridgeClientId(reason) {
    currentBridgeClientId = randomBridgeId();
    try { sessionStorage.setItem(tabClientIdKey, currentBridgeClientId); } catch {}
    try { bridgeChannel?.postMessage({ type: "codexapp-bridge-client-id", clientId: currentBridgeClientId, nonce: bridgeInstanceNonce, reason }); } catch {}
    if (socket) {
      try { socket.close(); } catch {}
    } else {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 50);
    }
  }

  function announceBridgeClientId(reason) {
    try { bridgeChannel?.postMessage({ type: "codexapp-bridge-client-id", clientId: currentBridgeClientId, nonce: bridgeInstanceNonce, reason }); } catch {}
  }

  function markReloadHandoff() {
    try { sessionStorage.setItem(reloadMarkerKey, String(Date.now())); } catch {}
  }

  function hasRecentReloadHandoff() {
    try {
      const markedAt = Number(sessionStorage.getItem(reloadMarkerKey) || 0);
      return Number.isFinite(markedAt) && markedAt > 0 && Date.now() - markedAt < reloadHandoffGraceMs;
    } catch {
      return false;
    }
  }

  function clearOldReloadHandoff() {
    try {
      const markedAt = Number(sessionStorage.getItem(reloadMarkerKey) || 0);
      if (!Number.isFinite(markedAt) || markedAt <= 0 || Date.now() - markedAt >= reloadHandoffGraceMs) {
        sessionStorage.removeItem(reloadMarkerKey);
      }
    } catch {}
  }

  function reloadForBridgeUpgrade(serverVersion) {
    if (typeof serverVersion !== "string" || serverVersion.length === 0 || serverVersion === bridgeScriptVersion) return false;
    try {
      const key = clientIdKey + ":bridge-version-reload";
      if (sessionStorage.getItem(key) === serverVersion) return true;
      sessionStorage.setItem(key, serverVersion);
    } catch {}
    setTimeout(() => location.reload(), 50);
    return true;
  }

  window.addEventListener("pagehide", markReloadHandoff);
  window.addEventListener("beforeunload", markReloadHandoff);
  setTimeout(clearOldReloadHandoff, reloadHandoffGraceMs + 250);

  try {
    bridgeChannel = new BroadcastChannel("codexapp-bridge-client-ids-v1");
    bridgeChannel.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type !== "codexapp-bridge-client-id") return;
      if (message.clientId !== currentBridgeClientId || message.nonce === bridgeInstanceNonce) return;
      if (hasRecentReloadHandoff()) return;
      if (String(bridgeInstanceNonce) > String(message.nonce || "")) {
        rotateBridgeClientId("duplicate-tab");
      } else {
        announceBridgeClientId("duplicate-tab-seen");
      }
    });
    setTimeout(() => announceBridgeClientId("startup"), 0);
  } catch {}

  const sharedObjects = ${JSON.stringify(initialSharedObjectSnapshot())};
  const noopDisposable = {
    dispose() {},
    [Symbol.dispose]() {},
  };
  const noopAsync = () => Promise.resolve();
  const unsupportedPrimaryRuntime = {
    installed: false,
    instructions: null,
  };
  const codexappHostServices = {
    appshotHotkeys: {
      getState: async () => ({ supported: false, configuredHotkey: null, isActive: false }),
      setHotkey: async () => ({ success: false, error: "Appshot hotkeys are unavailable on web.", state: { supported: false, configuredHotkey: null, isActive: false } }),
    },
    chromeNativeHost: {
      install: noopAsync,
      uninstall: noopAsync,
    },
    codexMicro: null,
    customAvatars: {
      load: async () => null,
    },
    debug: null,
    fileAttachments: {
      countFolderFiles: async (value) => {
        if (Array.isArray(value?.files)) return value.files.length;
        if (value instanceof FileList) return value.length;
        return 0;
      },
    },
    hotkeyWindowHotkeys: {
      collapseToHome: noopAsync,
      dismiss: noopAsync,
      homeDragEnd: noopAsync,
      homeDragMove: noopAsync,
      homeDragStart: noopAsync,
      homeLayoutChanged: noopAsync,
      homePointerInteractionChanged: noopAsync,
      open: noopAsync,
      setEnabled: noopAsync,
      transitionDone: noopAsync,
    },
    notifications: {
      hide: noopAsync,
      show: () => noopDisposable,
    },
    owlFeatures: {
      isOwlFeatureEnabled: async () => false,
      setEnabledFeatureNames: noopAsync,
    },
    primaryRuntime: {
      cancelInstall: noopAsync,
      diagnoseDependencies: async () => unsupportedPrimaryRuntime,
      finishInstall: noopAsync,
      loadDependencies: async () => unsupportedPrimaryRuntime,
      runUpdateNow: async () => unsupportedPrimaryRuntime,
    },
    projectWritableRoots: {
      addRoot: async (params = {}) => requestServer("codexapp-project-writable-root-add", params, 30000),
      clearRoots: async (params = {}) => requestServer("codexapp-project-writable-roots-clear", params, 30000),
    },
    systemPermissions: {
      openAccessibilitySettings: noopAsync,
      openScreenRecordingSettings: noopAsync,
      requestMicrophoneAccess: noopAsync,
      startPermissionSettingsAppDrag: noopAsync,
    },
    threadArchive: {
      archiveInactiveThread: async () => ({ success: false }),
    },
  };
  window.codexappHostServices = codexappHostServices;
  window.codexappHost = { services: codexappHostServices };
  const workerListeners = new Map();
  let socket = null;
  let connected = false;
  let reconnectTimer = null;
  let lastServerMessageAt = Date.now();
  const browserStaleMs = ${bridgeBrowserStaleMs};
  const mcpRequests = new Map();
  const pendingTurnSubmissions = new Map();
  const turnSubmitLockMs = ${browserTurnSubmitLockMs};
  const queue = [];
  const browserRequests = new Map();
  const uploadMaxFilesPerBatch = 8;
  const uploadMaxBase64BytesPerBatch = 32 * 1024 * 1024;
  const uploadReadConcurrency = 3;

  function textFromClientTurnInput(input) {
    if (typeof input === "string") return input.trim();
    if (!Array.isArray(input)) return "";
    return input.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (Array.isArray(item.content)) return textFromClientTurnInput(item.content);
      return "";
    }).filter((part) => part.length > 0).join("\\n").trim();
  }

  function clientHashText(text) {
    let hash = 2166136261;
    const value = String(text || "");
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function clientTurnSignature(threadId, inputOrText) {
    const id = typeof threadId === "string" && threadId.length > 0 ? threadId : activeThreadIdFromDocument();
    const text = typeof inputOrText === "string" ? inputOrText.trim() : textFromClientTurnInput(inputOrText);
    if (!id || !text) return null;
    return id + ":" + clientHashText(text);
  }

  function cleanupPendingTurnSubmissions(now = Date.now()) {
    for (const [signature, entry] of pendingTurnSubmissions) {
      if (now - Number(entry?.storedAt || 0) > turnSubmitLockMs) pendingTurnSubmissions.delete(signature);
    }
  }

  function rememberPendingTurnSubmission(signature, requestId = null, source = "request") {
    if (!signature) return;
    cleanupPendingTurnSubmissions();
    pendingTurnSubmissions.set(signature, { requestId: requestId == null ? null : String(requestId), storedAt: Date.now(), source });
  }

  function releasePendingTurnSubmission(signature) {
    if (signature) pendingTurnSubmissions.delete(signature);
  }

  function hasPendingTurnSubmission(signature) {
    if (!signature) return false;
    cleanupPendingTurnSubmissions();
    return pendingTurnSubmissions.has(signature);
  }

  function activeThreadIdFromDocument() {
    const node = document.querySelector("[data-codexapp-conversation-id]");
    const id = node?.getAttribute?.("data-codexapp-conversation-id") || "";
    return id || activeThreadIdFallback();
  }

  function activeComposer() {
    return Array.from(document.querySelectorAll("[contenteditable='true']")).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).at(-1) || null;
  }

  function activeComposerText() {
    return (activeComposer()?.innerText || "").trim();
  }

  function isLikelySubmitButton(button) {
    if (!(button instanceof HTMLButtonElement)) return false;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    const label = ((button.innerText || button.textContent || "") + " " + (button.getAttribute("aria-label") || "")).trim();
    if (/发送|send|submit/i.test(label)) return true;
    const className = String(button.className || "");
    return className.includes("size-token-button-composer") && className.includes("bg-token-foreground");
  }

  function activeSubmitSignature() {
    return clientTurnSignature(activeThreadIdFromDocument(), activeComposerText());
  }

  function preventDuplicateSubmitGesture(event, reason) {
    const signature = activeSubmitSignature();
    if (!signature || !hasPendingTurnSubmission(signature)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    rawConsoleWarn("[codexapp] duplicate submit gesture blocked", reason);
    return true;
  }

  function installSubmitDeduper() {
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (!isLikelySubmitButton(button)) return;
      const signature = activeSubmitSignature();
      if (!signature) return;
      if (hasPendingTurnSubmission(signature)) {
        preventDuplicateSubmitGesture(event, "click");
        return;
      }
      rememberPendingTurnSubmission(signature, null, "click");
      setTimeout(() => {
        const entry = pendingTurnSubmissions.get(signature);
        if (entry?.source === "click" && entry.requestId == null) pendingTurnSubmissions.delete(signature);
      }, 5000);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "Enter") return;
      const composer = activeComposer();
      if (!composer || !(event.target instanceof Node) || !composer.contains(event.target)) return;
      const signature = activeSubmitSignature();
      if (!signature) return;
      if (hasPendingTurnSubmission(signature)) {
        preventDuplicateSubmitGesture(event, "enter");
        return;
      }
      rememberPendingTurnSubmission(signature, null, "enter");
      setTimeout(() => {
        const entry = pendingTurnSubmissions.get(signature);
        if (entry?.source === "enter" && entry.requestId == null) pendingTurnSubmissions.delete(signature);
      }, 5000);
    }, true);
  }

  function postToView(message) {
    window.postMessage(message, location.origin);
  }

  function sendFetchSuccessToView(requestId, body, status = 200) {
    postToView({
      type: "fetch-response",
      responseType: "success",
      requestId,
      status,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify(body ?? null)
    });
  }

  function sendFetchErrorToView(requestId, status, error) {
    postToView({
      type: "fetch-response",
      responseType: "error",
      requestId,
      status,
      error: error || "Request failed"
    });
  }

  function settleBrowserRequest(message) {
    const pending = browserRequests.get(message.requestId);
    if (!pending) return false;
    browserRequests.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return true;
  }

  function requestServer(type, params = {}, timeoutMs = 120000) {
    const requestId = "browser-" + randomBridgeId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!browserRequests.delete(requestId)) return;
        reject(new Error(type + " timed out"));
      }, timeoutMs);
      browserRequests.set(requestId, { resolve, reject, timeout });
      sendToServer({ type, requestId, params });
    });
  }

  function pickFilesWithInput({ directory = false, imagesOnly = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      if (imagesOnly) input.accept = "image/*";
      if (directory) {
        input.webkitdirectory = true;
        input.directory = true;
      }
      input.style.position = "fixed";
      input.style.left = "-10000px";
      input.style.top = "-10000px";
      input.style.opacity = "0";
      let settled = false;
      const cleanup = () => {
        window.removeEventListener("focus", onFocus, true);
        try { input.remove(); } catch {}
      };
      const finish = (files) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Array.from(files || []));
      };
      const onFocus = () => {
        setTimeout(() => {
          if (!settled && (!input.files || input.files.length === 0)) finish([]);
        }, 500);
      };
      input.addEventListener("change", () => finish(input.files), { once: true });
      document.body.appendChild(input);
      window.addEventListener("focus", onFocus, true);
      input.click();
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
      };
      reader.onerror = () => reject(reader.error || new Error("Unable to read file"));
      reader.readAsDataURL(file);
    });
  }

  function firstFolderName(files, fallback = "Imported project") {
    for (const file of files) {
      const relative = file.webkitRelativePath || file.__codexappRelativePath || "";
      const first = relative.split(/[\\\\/]/).find(Boolean);
      if (first) return first;
    }
    return fallback;
  }

  function rememberUploadedFilePath(file, uploaded) {
    if (!file || !uploaded?.fsPath) return;
    try { Object.defineProperty(file, "__codexappUploadedPath", { value: uploaded.fsPath, configurable: true }); } catch {}
    try { Object.defineProperty(file, "path", { value: uploaded.fsPath, configurable: true }); } catch {}
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const values = Array.from(items || []);
    const results = new Array(values.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(limit || 1, values.length || 1));
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
        if (index % uploadReadConcurrency === uploadReadConcurrency - 1) await yieldToBrowser();
      }
    }));
    return results;
  }

  function estimatedBase64Bytes(file) {
    const size = Number(file?.size || 0);
    return Math.ceil(Math.max(0, size) * 4 / 3) + 256;
  }

  function uploadBatchTimeoutMs(entries) {
    const totalSize = entries.reduce((sum, entry) => sum + Number(entry.file?.size || 0), 0);
    return totalSize > 8 * 1024 * 1024 ? 300000 : 120000;
  }

  function uploadFileBatches(files) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const file of files) {
      const entryBytes = estimatedBase64Bytes(file);
      if (current.length > 0 && (current.length >= uploadMaxFilesPerBatch || currentBytes + entryBytes > uploadMaxBase64BytesPerBatch)) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += entryBytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  async function uploadEntryForFile(file) {
    const contentsBase64 = await fileToBase64(file);
    return {
      file,
      payload: {
        name: file.name || "file",
        type: file.type || null,
        size: file.size || 0,
        lastModified: file.lastModified || null,
        relativePath: file.webkitRelativePath || file.__codexappRelativePath || file.name || "file",
        contentsBase64
      }
    };
  }

  async function uploadBrowserFiles(files, options = {}) {
    const fileList = Array.from(files || []);
    const groupId = randomBridgeId();
    const uploadedFiles = [];
    let root = null;
    const label = options.label || firstFolderName(fileList);
    for (const fileBatch of uploadFileBatches(fileList)) {
      const batch = await mapWithConcurrency(fileBatch, uploadReadConcurrency, uploadEntryForFile);
      const result = await requestServer("codexapp-upload-browser-files", {
        purpose: options.purpose || "attachment",
        groupId,
        label,
        files: batch.map((entry) => entry.payload)
      }, uploadBatchTimeoutMs(batch));
      root = result?.root || root;
      const written = Array.isArray(result?.files) ? result.files : [];
      written.forEach((uploaded, index) => rememberUploadedFilePath(batch[index]?.file, uploaded));
      uploadedFiles.push(...written);
      await yieldToBrowser();
    }
    return { root, files: uploadedFiles };
  }

  function droppedFiles(event) {
    const files = event?.dataTransfer?.files;
    if (!files || files.length === 0) return [];
    return Array.from(files).filter((file) => file instanceof File && file.name);
  }

  function fileHasServerPath(file) {
    return !!(file?.__codexappUploadedPath || file?.path);
  }

  function targetForReplayDrop(event) {
    if (event.target instanceof EventTarget && (!(event.target instanceof Node) || event.target.isConnected)) {
      return event.target;
    }
    const element = document.elementFromPoint(event.clientX || 0, event.clientY || 0);
    return element || document.body || document.documentElement;
  }

  function replayDropEvent(originalEvent, files) {
    if (typeof DataTransfer !== "function" || typeof DragEvent !== "function") {
      throw new Error("Browser does not support replaying file drops");
    }
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(file);
    const replay = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
      altKey: originalEvent.altKey,
      ctrlKey: originalEvent.ctrlKey,
      metaKey: originalEvent.metaKey,
      shiftKey: originalEvent.shiftKey,
      clientX: originalEvent.clientX,
      clientY: originalEvent.clientY,
      screenX: originalEvent.screenX,
      screenY: originalEvent.screenY,
      button: originalEvent.button,
      buttons: originalEvent.buttons,
    });
    try { Object.defineProperty(replay, "__codexappUploadedDrop", { value: true }); } catch {}
    targetForReplayDrop(originalEvent).dispatchEvent(replay);
  }

  async function handleBrowserFileDrop(event) {
    if (event.__codexappUploadedDrop) return;
    const files = droppedFiles(event);
    if (files.length === 0 || files.every(fileHasServerPath)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    try {
      await uploadBrowserFiles(files, { purpose: "attachment", label: firstFolderName(files, "Dropped files") });
      replayDropEvent(event, files);
    } catch (error) {
      rawConsoleError("[codexapp] dropped file upload failed", error);
    }
  }

  function installBrowserFileDropUploadShim() {
    document.addEventListener("drop", (event) => {
      void handleBrowserFileDrop(event);
    }, true);
  }

  async function handlePickFilesFetch(message) {
    try {
      let params = {};
      try { params = message.body ? JSON.parse(message.body) : {}; } catch {}
      const files = await pickFilesWithInput({ imagesOnly: params.imagesOnly === true });
      if (files.length === 0) {
        sendFetchSuccessToView(message.requestId, { files: [] });
        return;
      }
      const uploaded = await uploadBrowserFiles(files, { purpose: "attachment" });
      sendFetchSuccessToView(message.requestId, { files: uploaded.files });
    } catch (error) {
      sendFetchErrorToView(message.requestId, 500, error.message || "Unable to upload file");
    }
  }

  async function handleWorkspaceRootPicker(message) {
    try {
      const files = await pickFilesWithInput({ directory: true });
      if (files.length > 0) {
        const label = firstFolderName(files);
        const uploaded = await uploadBrowserFiles(files, { purpose: "workspace", label });
        await requestServer("codexapp-register-workspace-root", {
          root: uploaded.root,
          label,
          setActive: message.setActive !== false,
          picked: true,
          create: true
        });
        return;
      }
      const serverPath = window.prompt("Enter an existing server folder path");
      if (serverPath && serverPath.trim()) {
        await requestServer("codexapp-register-workspace-root", {
          root: serverPath.trim(),
          label: serverPath.trim().split(/[\\\\/]/).filter(Boolean).at(-1) || serverPath.trim(),
          setActive: message.setActive !== false,
          picked: true,
          create: false
        });
      }
    } catch (error) {
      rawConsoleError("[codexapp] workspace picker failed", error);
    }
  }

  function installRunningTranscriptStyles() {
    const oldStyle = document.getElementById("codexapp-transcript-no-truncate-style");
    try { oldStyle?.remove(); } catch {}
    if (document.getElementById("codexapp-running-transcript-style")) return;
    const style = document.createElement("style");
    style.id = "codexapp-running-transcript-style";
    style.textContent = \`
      .thread-scroll-container .codexapp-active-running-card [class*="line-clamp-"] {
        -webkit-line-clamp: unset !important;
        line-clamp: unset !important;
        display: block !important;
        max-height: none !important;
        overflow: visible !important;
      }
      .thread-scroll-container .codexapp-active-running-card code[class*="line-clamp-"] {
        white-space: pre-wrap !important;
      }
    \`;
    (document.head || document.documentElement)?.appendChild(style);
  }

  function activeTranscriptRoot() {
    return document.querySelector("[data-thread-find-target='conversation']") || document;
  }

  function hasActiveTurns(result) {
    return Array.isArray(result?.data) && result.data.some((turn) => turn?.status === "inProgress");
  }

  function takeBridgeSequence(message) {
    const sequence = Number(message?.codexappBridgeSequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
    delete message.codexappBridgeSequence;
    return sequence;
  }

  function acknowledgeBridgeSequence(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
    const activeSocket = socket;
    const sendAck = () => {
      rememberBridgeDispatch(sequence);
      if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
      try {
        activeSocket.send(JSON.stringify({ type: "codexapp-bridge-ack", sequence }));
      } catch {}
    };
    const delayAck = () => setTimeout(sendAck, 0);
    if (typeof queueMicrotask === "function") queueMicrotask(delayAck);
    else delayAck();
  }

  function rememberMcpRequest(message) {
    const request = message?.request;
    if (!request || request.id == null || typeof request.method !== "string") return;
    const signature = /^(turn\\/start|turn\\/steer)$/.test(request.method)
      ? clientTurnSignature(request.params?.threadId, request.params?.input)
      : null;
    mcpRequests.set(String(request.id), {
      method: request.method,
      params: request.params || {},
      signature,
      storedAt: Date.now()
    });
    if (signature) {
      if (hasPendingTurnSubmission(signature)) {
        const existing = pendingTurnSubmissions.get(signature);
        if (existing?.requestId != null && existing.requestId !== String(request.id)) {
          rawConsoleWarn("[codexapp] duplicate turn request observed; server will coalesce", request.method);
        }
      }
      rememberPendingTurnSubmission(signature, request.id, "mcp-request");
    }
    if (mcpRequests.size <= 500) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, entry] of mcpRequests) {
      if (entry.storedAt < cutoff || mcpRequests.size > 500) mcpRequests.delete(key);
    }
  }

  function visibleElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function runningButtonText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function isRunningButton(element) {
    return /^(正在运行|Running\\b)/.test(runningButtonText(element));
  }

  function runningCardContainer(button) {
    let current = button;
    for (let depth = 0; current instanceof HTMLElement && depth < 8; depth += 1, current = current.parentElement) {
      const text = runningButtonText(current);
      const hasRunningText = /^(正在运行|Running\\b)/.test(text) || /\\b(正在运行|Running)\\b/.test(text);
      const hasClampedContent = current.querySelector("[class*='line-clamp-']");
      if (depth > 0 && hasRunningText && hasClampedContent) {
        return current;
      }
    }
    return button instanceof HTMLElement ? button.parentElement || button : null;
  }

  function collapseAutoExpandedCompletedCards(root) {
    for (const element of root.querySelectorAll("[data-codexapp-auto-expanded='1']")) {
      if (isRunningButton(element)) continue;
      delete element.dataset.codexappAutoExpanded;
      const expanded = element.getAttribute("aria-expanded");
      if (expanded === "true") {
        try { element.click(); } catch {}
      }
    }
  }

  function expandActiveRunningCard() {
    const root = activeTranscriptRoot();
    collapseAutoExpandedCompletedCards(root);
    for (const element of root.querySelectorAll(".codexapp-active-running-card")) {
      element.classList.remove("codexapp-active-running-card");
    }
    const runningButtons = Array.from(root.querySelectorAll("button,[role='button']"))
      .filter((element) => isRunningButton(element) && visibleElement(element));
    const element = runningButtons.at(-1);
    if (!element) return false;
    const container = runningCardContainer(element);
    try { container?.classList.add("codexapp-active-running-card"); } catch {}
    if (element.dataset?.codexappAutoExpanded !== "1" && element.getAttribute("aria-expanded") !== "true") {
      element.dataset.codexappAutoExpanded = "1";
      try { element.click(); } catch {}
    } else {
      element.dataset.codexappAutoExpanded = "1";
    }
    return true;
  }

  function activeTranscriptHasRunningCard() {
    const root = activeTranscriptRoot();
    for (const element of root.querySelectorAll("button,[role='button']")) {
      if (isRunningButton(element) && visibleElement(element)) return true;
    }
    return false;
  }

  function scrollTailTop(container) {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const style = getComputedStyle(container);
    return /reverse/.test(style.flexDirection || "") ? 0 : maxScrollTop;
  }

  function isNearThreadTail(container) {
    const target = scrollTailTop(container);
    return Math.abs(container.scrollTop - target) <= 96;
  }

  function installThreadTailFollower(container) {
    if (container.dataset.codexappTailFollowerInstalled === "1") return;
    container.dataset.codexappTailFollowerInstalled = "1";
    container.dataset.codexappFollowTail = isNearThreadTail(container) ? "1" : "0";
    container.addEventListener("scroll", () => {
      container.dataset.codexappFollowTail = isNearThreadTail(container) ? "1" : "0";
    }, { passive: true });
  }

  function keepActiveTranscriptAtTail() {
    for (const container of document.querySelectorAll(".thread-scroll-container")) {
      if (!(container instanceof HTMLElement)) continue;
      installThreadTailFollower(container);
      if (container.dataset.codexappFollowTail !== "1" && !isNearThreadTail(container)) continue;
      container.scrollTop = scrollTailTop(container);
      container.dataset.codexappFollowTail = "1";
    }
  }

  function repairActiveTranscript(reason) {
    installRunningTranscriptStyles();
    expandActiveRunningCard();
    keepActiveTranscriptAtTail();
    try { window.dispatchEvent(new Event("resize")); } catch {}
  }

  function scheduleActiveTranscriptRepair(reason) {
    const delays = [0, 120, 400, 1000, 2000];
    for (const delayMs of delays) {
      setTimeout(() => repairActiveTranscript(reason), delayMs);
    }
  }

  installRunningTranscriptStyles();
  setInterval(() => {
    if (activeTranscriptHasRunningCard()) repairActiveTranscript("running-card-watchdog");
  }, 3000);

  function scheduleReconnect(delayMs = 1000) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delayMs);
  }

  function forceReconnect(activeSocket, delayMs = 50) {
    if (socket === activeSocket) {
      connected = false;
      socket = null;
    }
    try { activeSocket?.close(); } catch {}
    scheduleReconnect(delayMs);
  }

  function sendSocketMessage(message) {
    const activeSocket = socket;
    if (!connected || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return false;
    try {
      activeSocket.send(JSON.stringify(message));
      return true;
    } catch {
      forceReconnect(activeSocket);
      return false;
    }
  }

  function flushQueue() {
    while (queue.length > 0) {
      if (!sendSocketMessage(queue[0])) return;
      queue.shift();
    }
  }

  function sendToServer(message) {
    if (!message || typeof message.type !== "string") return Promise.resolve();
    message = sanitizeManagedClientMessage(message);
    if (message.type === "tabs:outgoing.message.ready") return Promise.resolve();
    if (message.type === "fetch" && String(message.url || "").startsWith("vscode://codex/pick-files")) {
      void handlePickFilesFetch(message);
      return Promise.resolve();
    }
    if (message.type === "electron-pick-workspace-root-option" || message.type === "electron-add-new-workspace-root-option") {
      void handleWorkspaceRootPicker(message);
      return Promise.resolve();
    }
    if (message.type === "mcp-request") {
      rememberMcpRequest(message);
      if (/^(turn\\/start|turn\\/steer|turn\\/interrupt)$/.test(String(message.request?.method || ""))) {
        scheduleActiveTranscriptRepair("turn-request");
      }
    }
    if (message.type === "open-in-browser" && message.url) {
      window.open(message.url, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    }
    if ((message.type === "open-in-new-window" || message.type === "open-in-main-window") && (message.url || message.path)) {
      const target = message.url || message.path;
      if (/^https?:\\/\\//.test(String(target))) window.open(target, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    }
    if (message.type === "show-settings" || message.type === "open-keyboard-shortcuts") {
      const target = message.type === "open-keyboard-shortcuts" ? "/settings/keyboard-shortcuts" : "/settings";
      if (location.pathname !== target) location.assign(target);
      return Promise.resolve();
    }
    if (message.type === "shared-object-set") {
      if (message.key === "statsig_default_enable_features" && message.value && typeof message.value === "object" && !Array.isArray(message.value)) {
        message = { ...message, value: { ...message.value, guardian_approval: true } };
      }
      sharedObjects[message.key] = message.value;
      postToView({ type: "shared-object-updated", key: message.key, value: message.value });
    }
    if (!sendSocketMessage(message)) {
      queue.push(message);
    }
    return Promise.resolve();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const activeSocket = new WebSocket(bridgeUrl());
    socket = activeSocket;
    activeSocket.addEventListener("open", () => {
      if (socket !== activeSocket) return;
      connected = true;
      lastServerMessageAt = Date.now();
      flushQueue();
    });
    activeSocket.addEventListener("message", (event) => {
      lastServerMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const bridgeSequence = takeBridgeSequence(message);
      if (message.type === "codexapp-bridge-heartbeat") {
        acknowledgeBridgeSequence(bridgeSequence);
        reloadForBridgeUpgrade(message.bridgeScriptVersion);
        return;
      }
      if (message.type === "codexapp-browser-request-result") {
        settleBrowserRequest(message);
        acknowledgeBridgeSequence(bridgeSequence);
        return;
      }
      if (message.type === "mcp-response") {
        const responseId = message.message?.id;
        const request = responseId == null ? null : mcpRequests.get(String(responseId));
        if (request) mcpRequests.delete(String(responseId));
        if (request?.signature) releasePendingTurnSubmission(request.signature);
        if (request?.method === "thread/turns/list" && hasActiveTurns(message.message?.result)) {
          scheduleActiveTranscriptRepair("active-thread-open");
        }
      }
      if (
        message.type === "fetch-stream-event"
        || message.type === "fetch-stream-complete"
        || message.type === "mcp-notification"
        || message.type === "thread-stream-state-changed"
        || message.type === "thread-read-state-changed"
        || message.type === "local-thread-activity-changed"
      ) {
        scheduleActiveTranscriptRepair(message.type);
      }
      if (message.type === "worker-message") {
        const listeners = workerListeners.get(message.workerId);
        if (listeners) {
          for (const listener of listeners) listener(message.message);
        }
        acknowledgeBridgeSequence(bridgeSequence);
        return;
      }
      if (message.type === "shared-object-updated") {
        sharedObjects[message.key] = message.value;
      }
      if (message.type === "codexapp-account-switch") {
        window.dispatchEvent(new CustomEvent("codexapp-account-switch", { detail: message }));
        if (message.reload) {
          setTimeout(() => location.reload(), Math.max(0, Number(message.reloadAfterMs || 250)));
        }
        acknowledgeBridgeSequence(bridgeSequence);
        return;
      }
      postToView(message);
      acknowledgeBridgeSequence(bridgeSequence);
    });
    activeSocket.addEventListener("close", () => {
      if (socket !== activeSocket) return;
      connected = false;
      socket = null;
      scheduleReconnect(1000);
    });
    activeSocket.addEventListener("error", () => {
      forceReconnect(activeSocket);
    });
  }

  setInterval(() => {
    if (!connected || !socket) return;
    if (Date.now() - lastServerMessageAt > browserStaleMs) {
      forceReconnect(socket);
    }
  }, Math.max(5000, Math.floor(browserStaleMs / 3)));

  window.electronBridge = {
    windowType: "main",
    getSharedObjectSnapshotValue(key) {
      return Object.prototype.hasOwnProperty.call(sharedObjects, key) ? sharedObjects[key] : null;
    },
    sendMessageFromView(message) {
      return sendToServer(message);
    },
    getPathForFile() {
      return arguments[0]?.__codexappUploadedPath || arguments[0]?.path || null;
    },
    sendWorkerMessageFromView(workerId, message) {
      return sendToServer({ type: "worker-message", workerId, message });
    },
    subscribeToWorkerMessages(workerId, listener) {
      let listeners = workerListeners.get(workerId);
      if (!listeners) {
        listeners = new Set();
        workerListeners.set(workerId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) workerListeners.delete(workerId);
      };
    },
    showContextMenu() {
      return Promise.resolve();
    },
    showApplicationMenu() {
      return Promise.resolve();
    }
  };

  window.addEventListener("codex-message-from-view", (event) => {
    if (event.__codexForwardedViaBridge) return;
    sendToServer(event.detail);
  });

  installSubmitDeduper();
  installUiShim();
  installBrowserFileDropUploadShim();
  connect();
})();`;
}

function sharedObjectValue(key) {
  switch (key) {
    case "host_config":
      return { id: "local", display_name: "Local", kind: "local" };
    case "local_app_server_feature_enablement":
      return readHostState("local_app_server_feature_enablement") || defaultHostStateValue("local_app_server_feature_enablement");
    case "remote_connections":
      return readRemoteSshConnections();
    case "remote_control_connections":
      return readHostState("remote_control_connections") || [];
    case "remote_control_connections_state":
      return readHostState("remote_control_connections_state") || defaultHostStateValue("remote_control_connections_state");
    case "codex-mobile-has-connected-device":
      return readHostState("codex-mobile-has-connected-device") === true;
    case "statsig_default_enable_features":
      return normalizeSharedObjectSetValue(
        key,
        readHostState("statsig_default_enable_features") ?? defaultHostStateValue("statsig_default_enable_features") ?? null
      );
    default:
      return null;
  }
}

function isRemoteControlSharedObjectKey(key) {
  return key === "local_app_server_feature_enablement"
    || key === "remote_control_connections"
    || key === "remote_control_connections_state";
}

function readRemoteSshConnections() {
  const connections = Array.isArray(readHostState("remote_connections"))
    ? readHostState("remote_connections")
    : [];
  return normalizeRemoteSshConnections(connections);
}

function normalizeRemoteSshConnections(connections) {
  return (Array.isArray(connections) ? connections : [])
    .filter((connection) => isPlainObject(connection) && connection.source !== "remote-control")
    .map((connection) => {
      const displayName = typeof connection.displayName === "string"
        ? connection.displayName
        : (typeof connection.display_name === "string" ? connection.display_name : "");
      const sshHost = typeof connection.sshHost === "string"
        ? connection.sshHost
        : (typeof connection.hostname === "string" ? connection.hostname : "");
      const sshAlias = typeof connection.sshAlias === "string"
        ? connection.sshAlias
        : (typeof connection.alias === "string" ? connection.alias : null);
      return {
        ...connection,
        displayName,
        hostId: typeof connection.hostId === "string" && connection.hostId.length > 0
          ? connection.hostId
          : crypto.createHash("sha256").update(`${displayName}\0${sshHost}\0${sshAlias || ""}`).digest("hex").slice(0, 16),
        source: connection.source === "discovered" ? "discovered" : "codex-managed",
        sshHost,
        sshAlias,
        sshPort: connection.sshPort == null ? "" : String(connection.sshPort),
      };
    })
    .filter((connection) => connection.displayName.trim().length > 0 && (
      connection.sshHost.trim().length > 0 || (connection.sshAlias || "").trim().length > 0
    ));
}

function readChatGptAccessToken() {
  const auth = readJsonFile(path.join(codexHome, "auth.json"), {});
  const token = auth?.tokens?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function readRemoteControlDesiredEnabled() {
  const desired = readJsonObjectFile(remoteControlDesiredPath, {});
  if (typeof desired.enabled === "boolean") return desired.enabled;
  return readHostState("remote_control_desired_enabled") === true;
}

function writeRemoteControlDesiredEnabled(enabled) {
  writeJsonFile(remoteControlDesiredPath, {
    enabled: enabled === true,
    updatedAt: new Date().toISOString(),
  });
  writeHostState("remote_control_desired_enabled", enabled === true);
}

function remoteControlStateFromStatus(status = {}, overrides = {}) {
  const currentStatus = typeof status.status === "string" ? status.status : "unknown";
  const connected = currentStatus === "connected";
  const enabled = connected || currentStatus === "connecting" || currentStatus === "errored";
  return {
    available: true,
    accessRequired: false,
    authRequired: false,
    clientAuthorized: connected,
    enabled,
    status: currentStatus,
    serverName: status.serverName ?? null,
    installationId: status.installationId ?? null,
    environmentId: status.environmentId ?? null,
    ...overrides,
  };
}

function readRemoteControlEnrollments() {
  if (!fs.existsSync(codexStateDbPath)) return [];
  try {
    const sql = [
      "select websocket_url, account_id, app_server_client_name, server_id,",
      "environment_id, server_name, updated_at",
      "from remote_control_enrollments",
      "order by updated_at desc",
    ].join(" ");
    const output = execFileSync("sqlite3", ["-cmd", `.timeout ${sqliteBusyTimeoutMs}`, "-json", codexStateDbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.max(3000, sqliteBusyTimeoutMs + 1000),
    }).trim();
    const rows = output ? JSON.parse(output) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function isoDateFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

function remoteControlConnectionsFromStatus(status = {}) {
  const rows = readRemoteControlEnrollments();
  const statusEnvId = typeof status.environmentId === "string" && status.environmentId.length > 0
    ? status.environmentId
    : null;
  const statusServerName = typeof status.serverName === "string" && status.serverName.length > 0
    ? status.serverName
    : os.hostname();
  const statusInstallationId = typeof status.installationId === "string" && status.installationId.length > 0
    ? status.installationId
    : null;
  const sourceRows = rows.length > 0
    ? rows
    : (statusEnvId ? [{
        environment_id: statusEnvId,
        server_name: statusServerName,
        server_id: null,
        updated_at: Math.floor(Date.now() / 1000),
      }] : []);

  const seen = new Set();
  const connections = [];
  const autoConnectByHostId = readHostState("remote-connection-auto-connect-by-host-id") || {};
  for (const row of sourceRows) {
    const envId = typeof row.environment_id === "string" && row.environment_id.length > 0
      ? row.environment_id
      : null;
    if (!envId || seen.has(envId)) continue;
    seen.add(envId);
    const displayName = (typeof row.server_name === "string" && row.server_name.length > 0)
      ? row.server_name
      : statusServerName;
    const online = status.status === "connected" && (!statusEnvId || statusEnvId === envId);
    connections.push({
      source: "remote-control",
      envId,
      hostId: envId,
      displayName,
      hostName: displayName,
      os: "Linux",
      arch: os.arch(),
      appServerVersion: codexUiVersion,
      clientType: "CODEX_DESKTOP_APP",
      installationId: statusInstallationId || row.server_id || null,
      online,
      busy: false,
      autoConnect: typeof autoConnectByHostId[envId] === "boolean" ? autoConnectByHostId[envId] : online,
      lastSeenAt: isoDateFromUnixSeconds(row.updated_at),
    });
  }
  return connections;
}

function writeRemoteControlSharedState(status = {}, overrides = {}) {
  const state = remoteControlStateFromStatus(status, overrides);
  const connections = remoteControlConnectionsFromStatus(status);
  const featureEnablement = {
    ...(readHostState("local_app_server_feature_enablement") || {}),
    remote_control: state.enabled === true,
  };
  writeHostState("local_app_server_feature_enablement", featureEnablement);
  writeHostState("remote_control_connections_state", state);
  writeHostState("remote_control_connections", connections);
  broadcastBridgeMessage({
    type: "global-state-updated",
    keys: [
      "local_app_server_feature_enablement",
      "remote_control_connections_state",
    ],
  });
  broadcastBridgeMessage({
    type: "shared-object-updated",
    key: "local_app_server_feature_enablement",
    value: featureEnablement,
  });
  broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections_state", value: state });
  broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections", value: connections });
  return { state, connections };
}

function normalizeRemoteControlClient(client) {
  if (!isPlainObject(client)) return client;
  const clientId = client.client_id || client.clientId || client.id || null;
  const displayName = client.display_name || client.displayName || client.name || client.device_name || client.deviceName || null;
  const enrollmentStatus = client.enrollment_status || client.enrollmentStatus || client.status || null;
  const lastSeenAt = client.last_seen_at || client.lastSeenAt || null;
  return {
    ...client,
    ...(clientId ? { client_id: clientId } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(enrollmentStatus ? { enrollment_status: enrollmentStatus } : {}),
    ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
  };
}

function normalizeRemoteControlClientsResponse(response) {
  if (!isPlainObject(response)) return response;
  const items = Array.isArray(response.items)
    ? response.items.map(normalizeRemoteControlClient)
    : [];
  return { ...response, items };
}

function remoteControlClientsHaveEnrolledDevice(response) {
  const items = Array.isArray(response?.items) ? response.items : [];
  return items.some((item) => {
    if (!isPlainObject(item)) return false;
    const status = item.enrollment_status || item.enrollmentStatus || item.status || "";
    return status !== "pending_enrollment";
  });
}

function writeCodexMobileCompletedFromClients(response) {
  if (!Array.isArray(response?.items)) return false;
  const completed = remoteControlClientsHaveEnrolledDevice(response);
  if (readHostState("codex-mobile-has-connected-device") !== completed) {
    writeHostState("codex-mobile-has-connected-device", completed);
    broadcastBridgeMessage({
      type: "global-state-updated",
      keys: ["codex-mobile-has-connected-device"],
    });
    broadcastBridgeMessage({
      type: "shared-object-updated",
      key: "codex-mobile-has-connected-device",
      value: completed,
    });
  }
  return completed;
}

class AppServerProcess {
  constructor() {
    this.child = null;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async stop(reason = "restart") {
    if (externalAppServer) {
      this.startPromise = null;
      return;
    }
    const child = this.child;
    this.startPromise = null;
    if (!child || child.killed) {
      await stopManagedAppServerPids(reason);
      return;
    }
    log("stopping codex app-server", { reason, pid: child.pid });
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = setTimeout(() => {
        if (!settled) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 3000);
      killer.unref?.();
      child.once("exit", () => {
        clearTimeout(killer);
        finish();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killer);
        finish();
      }
    });
    await stopManagedAppServerPids(reason);
  }

  async restart(reason = "restart") {
    if (externalAppServer) {
      log("external codex app-server restart requested; keeping process under systemd", { reason });
      await this.waitForHealth();
      return;
    }
    await this.stop(reason);
    await delay(250);
    await this.ensureStarted();
  }

  async start() {
    if (externalAppServer) {
      log("using external codex app-server", `ws://127.0.0.1:${appServerPort}`);
      await this.waitForHealth();
      return;
    }
    if (this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null) return;
    const listenUrl = `ws://127.0.0.1:${appServerPort}`;
    await stopManagedAppServerPids("pre-start cleanup");
    const configArgs = [];
    const configOverrides = {};
    if (appServerSandboxModeOverride) {
      configArgs.push("--config", `sandbox_mode=${JSON.stringify(appServerSandboxModeOverride)}`);
      configOverrides.sandbox_mode = appServerSandboxModeOverride;
    }
    if (appServerDefaultPermissionsOverride) {
      configArgs.push("--config", `default_permissions=${JSON.stringify(appServerDefaultPermissionsOverride)}`);
      configOverrides.default_permissions = appServerDefaultPermissionsOverride;
    }
    const args = [
      "app-server",
      "--remote-control",
      ...configArgs,
      "--listen",
      listenUrl,
      "--analytics-default-enabled",
    ];
    log("starting codex app-server", listenUrl, Object.keys(configOverrides).length ? { configOverrides } : {});
    this.child = spawn(codexCli, args, {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("exit", (code, signal) => {
      log("codex app-server exited", { code, signal });
      this.child = null;
      this.startPromise = null;
    });
    await this.waitForHealth();
  }

  async waitForHealth() {
    const url = `http://127.0.0.1:${appServerPort}/healthz`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!externalAppServer && (!this.child || this.child.exitCode !== null || this.child.signalCode !== null)) {
        throw new Error("codex app-server exited before becoming healthy");
      }
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("codex app-server did not become healthy");
  }
}

const appServerProcess = new AppServerProcess();

class RemoteControlKeeper {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.startPromise = null;
    this.nextId = 1;
    this.keepaliveTimer = null;
    this.keepaliveInFlight = false;
    this.reconnectTimer = null;
    this.closed = false;
  }

  desiredEnabled() {
    return readRemoteControlDesiredEnabled() === true;
  }

  markDesired(enabled) {
    writeRemoteControlDesiredEnabled(enabled === true);
  }

  async ensureSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = this.openSocket();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async openSocket() {
    await appServerProcess.ensureStarted();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("timeout connecting remote-control keeper to app-server"));
      }, 10000);
      ws.on("open", () => {
        this.ws = ws;
        ws.on("message", (data) => this.handleMessage(data));
        ws.on("close", () => {
          if (this.ws === ws) this.ws = null;
          this.rejectAllPending(new Error("remote-control keeper app-server socket closed"));
          if (!this.closed && this.desiredEnabled()) this.scheduleReconnect();
        });
        ws.on("error", (error) => log("remote-control keeper websocket error", error.message || String(error)));
        this.request("initialize", {
          clientInfo: { name: `${clientName}-remote-control`, title: `${appDisplayName} Remote Control`, version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }, { timeoutMs: 30000 }).then(() => {
          clearTimeout(timeout);
          resolve();
        }, (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "remote-control keeper request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "remoteControl/status/changed") {
      writeRemoteControlSharedState(message.params || {});
      if (message.params?.status === "disabled" && this.desiredEnabled()) {
        this.scheduleReconnect(250);
      }
    }
  }

  request(method, params = {}, options = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("remote-control keeper app-server socket is not connected"));
    }
    const id = `remote-control-keeper-${this.nextId++}`;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("remote-control keeper request timed out"));
      }, options.timeoutMs || 30000);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  scheduleReconnect(delayMs = 1000) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.desiredEnabled()) {
        this.enable().catch((error) => log("remote-control keeper reconnect failed", error.message || String(error)));
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      if (!this.desiredEnabled()) return;
      if (this.keepaliveInFlight) return;
      this.keepaliveInFlight = true;
      this.readStatus({ autoEnable: true })
        .catch((error) => {
          log("remote-control keeper keepalive failed", error.message || String(error));
          this.scheduleReconnect();
        })
        .finally(() => {
          this.keepaliveInFlight = false;
        });
    }, remoteControlKeepaliveIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive() {
    this.keepaliveInFlight = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async enable() {
    this.closed = false;
    this.markDesired(true);
    await this.ensureSocket();
    let status = await this.request("remoteControl/enable", {}, { timeoutMs: 60000 });
    if (!status || typeof status.status !== "string") {
      status = await this.request("remoteControl/status/read", {}, { timeoutMs: 30000 });
    }
    const { state, connections } = writeRemoteControlSharedState(status || {});
    this.startKeepalive();
    return {
      success: true,
      enabled: state.enabled === true,
      status: status?.status ?? state.status,
      remoteControlStatus: status,
      remoteControlConnectionsState: state,
      remoteControlConnections: connections,
      connections,
      items: connections,
    };
  }

  async disable() {
    this.markDesired(false);
    this.stopKeepalive();
    let status = null;
    try {
      await this.ensureSocket();
      status = await this.request("remoteControl/disable", {}, { timeoutMs: 60000 });
    } finally {
      this.closed = true;
      this.rejectAllPending(new Error("remote-control keeper disabled"));
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
    }
    const { state, connections } = writeRemoteControlSharedState(status || {
      status: "disabled",
      serverName: os.hostname(),
      installationId: null,
      environmentId: null,
    });
    return {
      success: true,
      enabled: false,
      status: status?.status ?? state.status,
      remoteControlStatus: status,
      remoteControlConnectionsState: state,
      remoteControlConnections: connections,
      connections,
      items: connections,
    };
  }

  async readStatus({ autoEnable = false } = {}) {
    await this.ensureSocket();
    let status = await this.request("remoteControl/status/read", {}, { timeoutMs: 30000 });
    if (autoEnable && status?.status === "disabled" && this.desiredEnabled()) {
      return (await this.enable()).remoteControlStatus;
    }
    writeRemoteControlSharedState(status || {});
    if (this.desiredEnabled()) this.startKeepalive();
    return status || {};
  }
}

const remoteControlKeeper = new RemoteControlKeeper();
const bridgeSessions = new Set();
const bridgeSessionsByClientId = new Map();
const terminalSessions = new Map();
const terminalSessionsByKey = new Map();
let accountSwitchInFlight = null;
let lastAccountSwitchAttemptAt = 0;
let accountSwitchGeneration = 0;

function broadcastAccountSwitch(payload) {
  const message = {
    type: "codexapp-account-switch",
    timestamp: new Date().toISOString(),
    ...payload,
  };
  for (const session of bridgeSessions) {
    session.sendToBrowser(message);
  }
}

function broadcastBridgeMessage(message) {
  for (const session of bridgeSessions) {
    session.sendToBrowser(message);
  }
}

function setActiveWorkspaceRoot(root) {
  const normalized = typeof root === "string" && root.length > 0 ? path.resolve(root) : null;
  writeHostState("active-workspace-roots", normalized ? [normalized] : []);
  if (normalized) {
    writeHostState("electron-saved-workspace-roots", uniqueStrings([
      normalized,
      ...uniqueStrings(readHostState("electron-saved-workspace-roots")),
    ]));
  }
  broadcastBridgeMessage({ type: "active-workspace-roots-updated" });
  broadcastBridgeMessage({ type: "workspace-root-options-updated" });
}

function addWorkspaceRootOption(root, label = null, setActive = false) {
  const normalized = typeof root === "string" && root.length > 0 ? path.resolve(root) : null;
  if (!normalized) return false;
  writeHostState("electron-saved-workspace-roots", uniqueStrings([
    normalized,
    ...uniqueStrings(readHostState("electron-saved-workspace-roots")),
  ]));
  if (typeof label === "string" && label.length > 0) {
    writeHostState("electron-workspace-root-labels", {
      ...(readHostState("electron-workspace-root-labels") || {}),
      [normalized]: label,
    });
  }
  if (setActive) {
    writeHostState("active-workspace-roots", [normalized]);
    broadcastBridgeMessage({ type: "active-workspace-roots-updated" });
  }
  broadcastBridgeMessage({ type: "workspace-root-options-updated" });
  return true;
}

function resetBridgeAppSockets(reason) {
  for (const session of bridgeSessions) {
    session.resetAppSocket(reason);
  }
}

async function requestAccountSwitch(reason, details = {}) {
  if (!autoAccountSwitchEnabled) return { state: "disabled" };
  if (accountSwitchInFlight) return accountSwitchInFlight;
  const now = Date.now();
  if (now - lastAccountSwitchAttemptAt < accountSwitchMinIntervalMs) {
    return { state: "cooldown" };
  }
  lastAccountSwitchAttemptAt = now;

  accountSwitchInFlight = (async () => {
    const generation = ++accountSwitchGeneration;
    const payload = {
      reason,
      source: "codex-app-web-gateway",
      generation,
      timestamp: new Date().toISOString(),
      account: compactProviderPayload(details.account),
      rateLimits: compactProviderPayload(details.rateLimits),
      error: compactProviderPayload(details.error),
      method: details.method || null,
    };
    broadcastAccountSwitch({ phase: "started", reason, generation, reload: false });

    try {
      if (!looksLikeAuthInvalidated(details.error || details.rateLimits || details)) {
        await accountProviderJson("POST", "/mark-quota-exhausted", payload).catch((error) => {
          log("account provider mark-quota-exhausted failed", error.message);
        });
      }

      const lease = await accountProviderJson("POST", "/lease", payload);
      const accepted = lease && lease.ok !== false && (
        lease.accepted === true
        || lease.switched === true
        || lease.switchPending === true
        || lease.account
        || ["queued", "switching", "switched", "completed"].includes(String(lease.state || ""))
      );
      if (!accepted) {
        broadcastAccountSwitch({ phase: "declined", reason, generation, reload: false });
        return { state: "declined", provider: lease };
      }

      const settleMs = Number.isFinite(Number(lease.retryAfterMs ?? lease.settleMs))
        ? Math.max(0, Math.min(60000, Number(lease.retryAfterMs ?? lease.settleMs)))
        : accountSwitchSettleMs;
      if (settleMs > 0) await delay(settleMs);

      resetBridgeAppSockets("account switch");
      await appServerProcess.stop("account switch");
      if (accountSwitchRestartDelayMs > 0) await delay(accountSwitchRestartDelayMs);
      await appServerProcess.ensureStarted();
      resetBridgeAppSockets("account switch completed");

      const reload = accountSwitchForceReload || lease.requiresRefresh === true || lease.reload === true;
      broadcastAccountSwitch({
        phase: "completed",
        reason,
        generation,
        reload,
        reloadAfterMs: reload ? 250 : 0,
      });
      return { state: "switched", provider: lease, reload };
    } catch (error) {
      log("account switch failed", error.stack || error.message);
      broadcastAccountSwitch({
        phase: "failed",
        reason,
        generation,
        reload: accountSwitchForceReload,
        reloadAfterMs: accountSwitchForceReload ? 250 : 0,
      });
      return { state: "failed", error: error.message || String(error) };
    } finally {
      accountSwitchInFlight = null;
    }
  })();

  return accountSwitchInFlight;
}

function terminalShellPath() {
  const candidates = [
    process.env.CODEXAPP_TERMINAL_SHELL,
    "/bin/bash",
    process.env.SHELL,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "/bin/bash";
}

function terminalCwd(value) {
  if (typeof value === "string" && value.length > 0) {
    try {
      if (fs.statSync(value).isDirectory()) return value;
    } catch {}
  }
  return process.cwd();
}

function appendTerminalSessionBuffer(entry, data) {
  const compact = compactTerminalBuffer(`${entry.buffer || ""}${data}`);
  entry.buffer = compact.buffer;
  entry.truncated = compact.truncated;
}

function emitTerminalMessage(entry, type, payload = {}) {
  if (!entry || !entry.owner || entry.owner.closed) return;
  entry.owner.sendToBrowser({
    type,
    sessionId: entry.sessionId,
    ...payload,
  });
}

function terminalSessionKey(owner, cwd, message = {}) {
  const threadId = typeof message.threadId === "string" && message.threadId.length > 0
    ? message.threadId
    : (typeof message.conversationId === "string" && message.conversationId.length > 0 ? message.conversationId : "default");
  return `${owner.clientId}:${cwd}:${threadId}`;
}

function attachExistingTerminalSession(owner, entry, requestedSessionId) {
  entry.owner = owner;
  if (requestedSessionId && requestedSessionId !== entry.sessionId) {
    entry.aliases.add(requestedSessionId);
    terminalSessions.set(requestedSessionId, entry);
    entry.sessionId = requestedSessionId;
  }
  if (entry.buffer) emitTerminalMessage(entry, "terminal-init-log", { log: entry.buffer });
  emitTerminalMessage(entry, "terminal-attached", { cwd: entry.cwd, shell: entry.shell });
  return entry;
}

function forgetTerminalEntry(entry) {
  if (!entry) return;
  for (const alias of entry.aliases || [entry.sessionId]) {
    if (terminalSessions.get(alias) === entry) terminalSessions.delete(alias);
  }
  if (entry.key && terminalSessionsByKey.get(entry.key) === entry) {
    terminalSessionsByKey.delete(entry.key);
  }
}

function closeTerminalSession(sessionId, signal = "SIGTERM") {
  const entry = terminalSessions.get(sessionId);
  if (!entry) return;
  forgetTerminalEntry(entry);
  try {
    if (entry.child && !entry.child.killed) {
      if (entry.child.pid) {
        try { process.kill(-entry.child.pid, signal); } catch {}
      }
      entry.child.kill(signal);
    }
  } catch {}
}

function closeTerminalSessionsForOwner(owner) {
  for (const entry of new Set(terminalSessions.values())) {
    if (entry.owner === owner) closeTerminalSession(entry.sessionId);
  }
}

function createTerminalSession(owner, message = {}) {
  const sessionId = typeof message.sessionId === "string" && message.sessionId.length > 0
    ? message.sessionId
    : crypto.randomUUID();

  const cwd = terminalCwd(message.cwd);
  const key = terminalSessionKey(owner, cwd, message);
  const existingById = terminalSessions.get(sessionId);
  if (existingById) return attachExistingTerminalSession(owner, existingById, sessionId);
  const existingByKey = terminalSessionsByKey.get(key);
  if (existingByKey) return attachExistingTerminalSession(owner, existingByKey, sessionId);

  const shell = terminalShellPath();
  const cols = Number.isFinite(Number(message.cols)) ? Math.max(2, Math.trunc(Number(message.cols))) : 120;
  const rows = Number.isFinite(Number(message.rows)) ? Math.max(1, Math.trunc(Number(message.rows))) : 30;
  const useScript = fs.existsSync("/usr/bin/script");
  const command = useScript ? "/usr/bin/script" : shell;
  const args = useScript
    ? ["-q", "-f", "-e", "-c", `${shellQuote(shell)} -l`, "/dev/null"]
    : ["-l"];
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
      DISABLE_AUTO_UPDATE: "true",
      DISABLE_UPDATE_PROMPT: "true",
      ZSH_DISABLE_COMPFIX: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const entry = {
    sessionId,
    owner,
    child,
    cwd,
    shell,
    cols,
    rows,
    key,
    aliases: new Set([sessionId]),
    buffer: "",
    truncated: false,
  };
  terminalSessions.set(sessionId, entry);
  terminalSessionsByKey.set(key, entry);

  const intro = `Starting ${path.basename(shell)} in ${cwd}\r\n`;
  appendTerminalSessionBuffer(entry, intro);
  emitTerminalMessage(entry, "terminal-init-log", { log: intro });
  emitTerminalMessage(entry, "terminal-attached", { cwd, shell });

  const onData = (chunk) => {
    const data = chunk.toString("utf8");
    appendTerminalSessionBuffer(entry, data);
    emitTerminalMessage(entry, "terminal-data", { data });
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (error) => {
    emitTerminalMessage(entry, "terminal-error", { message: error.message || String(error) });
    forgetTerminalEntry(entry);
  });
  child.on("exit", (code, signal) => {
    emitTerminalMessage(entry, "terminal-exit", { code, signal });
    forgetTerminalEntry(entry);
  });

  return entry;
}

function attachTerminalSession(owner, message = {}) {
  const sessionId = typeof message.sessionId === "string" && message.sessionId.length > 0
    ? message.sessionId
    : crypto.randomUUID();
  let entry = terminalSessions.get(sessionId);
  if (!entry) {
    entry = createTerminalSession(owner, { ...message, sessionId });
  } else {
    attachExistingTerminalSession(owner, entry, sessionId);
  }
  return entry;
}

function handleTerminalBridgeMessage(owner, message) {
  switch (message.type) {
    case "terminal-create":
      createTerminalSession(owner, message);
      return true;
    case "terminal-attach":
      attachTerminalSession(owner, message);
      return true;
    case "terminal-write": {
      const entry = terminalSessions.get(message.sessionId);
      if (entry?.child?.stdin?.writable && typeof message.data === "string") {
        entry.child.stdin.write(message.data);
      }
      return true;
    }
    case "terminal-run-action": {
      const entry = terminalSessions.get(message.sessionId);
      const command = typeof message.command === "string" ? message.command.trim() : "";
      if (entry?.child?.stdin?.writable && command.length > 0) {
        const cwd = terminalCwd(message.cwd || entry.cwd);
        entry.child.stdin.write(`cd ${shellQuote(cwd)} && ${command}\r`);
      }
      return true;
    }
    case "terminal-resize": {
      const entry = terminalSessions.get(message.sessionId);
      if (entry) {
        entry.cols = Number.isFinite(Number(message.cols)) ? Math.max(2, Math.trunc(Number(message.cols))) : entry.cols;
        entry.rows = Number.isFinite(Number(message.rows)) ? Math.max(1, Math.trunc(Number(message.rows))) : entry.rows;
      }
      return true;
    }
    case "terminal-close":
      closeTerminalSession(message.sessionId);
      return true;
    default:
      return false;
  }
}

class BridgeSession {
  constructor(browserSocket, clientId) {
    this.clientId = clientId;
    this.browserSocket = null;
    this.browserQueue = [];
    this.browserReplayBuffer = [];
    this.nextBrowserSequence = 1;
    this.browserLastAckSequence = 0;
    this.disposeTimer = null;
    this.appSocket = null;
    this.pending = new Map();
    this.forwardedRequests = new Map();
    this.ackedDeferredTurnRequestIds = new Set();
    this.abortControllers = new Map();
    this.recentTurnInputSubmissions = new Map();
    this.pendingTurnInputSubmissions = new Map();
    this.promptHistoryRecoveryTimers = new Map();
    this.promptHistoryEligibleThreads = new Map();
    this.activeTurnWatchdogs = new Map();
    this.ephemeralThreads = new Map();
    this.largeThreadAppResumePromises = new Map();
    this.closed = false;
    bridgeSessions.add(this);
    bridgeSessionsByClientId.set(this.clientId, this);
    this.attachBrowserSocket(browserSocket);
  }

  attachBrowserSocket(browserSocket) {
    if (this.closed) {
      try { browserSocket.close(); } catch {}
      return;
    }
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    const previous = this.browserSocket;
    this.browserSocket = browserSocket;
    if (previous && previous.readyState === WebSocket.OPEN) {
      try { previous.close(); } catch {}
    }
    browserSocket.on("message", (data) => this.handleBrowserMessage(data).catch((error) => {
      log("browser message error", error.stack || error.message);
    }));
    browserSocket.on("close", () => this.detachBrowserSocket(browserSocket));
    const replayedSequences = this.replayUnackedBrowserMessages();
    if (replayedSequences.size > 0) {
      this.browserQueue = this.browserQueue.filter((message) => !replayedSequences.has(message?.codexappBridgeSequence));
    }
    this.flushBrowserQueue();
    this.sendBrowserHeartbeat();
    this.sendInitialSharedObjects();
  }

  detachBrowserSocket(browserSocket) {
    if (this.browserSocket !== browserSocket) return;
    this.browserSocket = null;
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = setTimeout(() => {
      this.close("orphan retention expired");
    }, bridgeOrphanRetentionMs);
    this.disposeTimer.unref?.();
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    bridgeSessions.delete(this);
    if (bridgeSessionsByClientId.get(this.clientId) === this) {
      bridgeSessionsByClientId.delete(this.clientId);
    }
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    closeTerminalSessionsForOwner(this);
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("bridge session closed"));
    }
    this.pending.clear();
    this.forwardedRequests.clear();
    this.ackedDeferredTurnRequestIds.clear();
    this.recentTurnInputSubmissions.clear();
    this.pendingTurnInputSubmissions.clear();
    this.largeThreadAppResumePromises.clear();
    for (const timer of this.promptHistoryRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.promptHistoryRecoveryTimers.clear();
    this.promptHistoryEligibleThreads.clear();
    for (const state of this.activeTurnWatchdogs.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.activeTurnWatchdogs.clear();
    this.ephemeralThreads.clear();
    if (this.appSocket) {
      try { this.appSocket.close(); } catch {}
      this.appSocket = null;
    }
    if (this.browserSocket) {
      try { this.browserSocket.close(); } catch {}
      this.browserSocket = null;
    }
    debugLog("bridge session disposed", this.clientId, reason);
  }

  resetAppSocket(reason) {
    if (this.appSocket) {
      try { this.appSocket.close(); } catch {}
      this.appSocket = null;
    }
    const error = new Error(`app-server connection reset: ${reason}`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.largeThreadAppResumePromises.clear();
  }

  queueBrowserMessage(message, front = false) {
    if (bridgeBrowserQueueLimit <= 0) return;
    if (front) {
      this.browserQueue.unshift(message);
      if (this.browserQueue.length > bridgeBrowserQueueLimit) {
        this.browserQueue.splice(bridgeBrowserQueueLimit);
      }
    } else {
      this.browserQueue.push(message);
      if (this.browserQueue.length > bridgeBrowserQueueLimit) {
        this.browserQueue.splice(0, this.browserQueue.length - bridgeBrowserQueueLimit);
      }
    }
  }

  trimBrowserReplayBuffer() {
    while (this.browserReplayBuffer.length > 0 && this.browserReplayBuffer[0].sequence <= this.browserLastAckSequence) {
      this.browserReplayBuffer.shift();
    }
    while (this.browserReplayBuffer.length > bridgeBrowserReplayLimit) {
      this.browserReplayBuffer.shift();
    }
  }

  prepareBrowserMessage(message, { replay = true } = {}) {
    if (!replay) return message;
    const sequence = this.nextBrowserSequence;
    this.nextBrowserSequence += 1;
    const sequencedMessage = { ...message, codexappBridgeSequence: sequence };
    this.browserReplayBuffer.push({ sequence, message: sequencedMessage });
    this.trimBrowserReplayBuffer();
    return sequencedMessage;
  }

  acknowledgeBrowserSequence(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= this.browserLastAckSequence) return;
    if (sequence >= this.nextBrowserSequence) return;
    this.browserLastAckSequence = sequence;
    this.trimBrowserReplayBuffer();
  }

  terminateBrowserSocket(browserSocket, reason) {
    if (this.browserSocket !== browserSocket) return;
    debugLog("browser websocket terminated", this.clientId, reason);
    try {
      if (typeof browserSocket.terminate === "function") browserSocket.terminate();
      else browserSocket.close();
    } catch {}
  }

  sendPreparedToBrowser(message, { queueOnFailure = true } = {}) {
    if (this.closed) return;
    const browserSocket = this.browserSocket;
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
      if (queueOnFailure) this.queueBrowserMessage(message);
      return;
    }
    let payload;
    try {
      payload = JSON.stringify(message);
    } catch (error) {
      log("browser message serialization failed", error.stack || error.message);
      return;
    }
    try {
      browserSocket.send(payload, (error) => {
        if (!error) return;
        if (queueOnFailure) this.queueBrowserMessage(message, true);
        this.terminateBrowserSocket(browserSocket, error.message || "browser send failed");
      });
    } catch (error) {
      if (queueOnFailure) this.queueBrowserMessage(message, true);
      this.terminateBrowserSocket(browserSocket, error.message || "browser send threw");
    }
  }

  sendToBrowser(message) {
    if (this.closed) return;
    this.sendPreparedToBrowser(this.prepareBrowserMessage(sanitizeGeneratedImagesForWeb(message)));
  }

  sendInitialSharedObjects() {
    const snapshot = initialSharedObjectSnapshot();
    for (const [key, value] of Object.entries(snapshot)) {
      this.sendToBrowser({ type: "shared-object-updated", key, value });
    }
  }

  flushBrowserQueue() {
    if (!this.browserSocket || this.browserSocket.readyState !== WebSocket.OPEN) return;
    const queued = this.browserQueue.splice(0);
    for (let index = 0; index < queued.length; index += 1) {
      const message = queued[index];
      if (!this.browserSocket || this.browserSocket.readyState !== WebSocket.OPEN) {
        this.browserQueue.unshift(message, ...queued.slice(index + 1));
        break;
      }
      this.sendPreparedToBrowser(message);
    }
  }

  replayUnackedBrowserMessages() {
    const replayedSequences = new Set();
    if (!this.browserSocket || this.browserSocket.readyState !== WebSocket.OPEN) return replayedSequences;
    this.trimBrowserReplayBuffer();
    for (const entry of this.browserReplayBuffer) {
      if (entry.sequence <= this.browserLastAckSequence) continue;
      this.sendPreparedToBrowser(entry.message, { queueOnFailure: false });
      replayedSequences.add(entry.sequence);
    }
    return replayedSequences;
  }

  sendBrowserHeartbeat() {
    if (this.closed) return;
    const browserSocket = this.browserSocket;
    if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) return;
    try {
      browserSocket.send(JSON.stringify({ type: "codexapp-bridge-heartbeat", serverTime: Date.now(), bridgeScriptVersion }), (error) => {
        if (error) this.terminateBrowserSocket(browserSocket, error.message || "browser heartbeat failed");
      });
    } catch (error) {
      this.terminateBrowserSocket(browserSocket, error.message || "browser heartbeat threw");
    }
  }

  async ensureAppSocket() {
    if (this.appSocket && this.appSocket.readyState === WebSocket.OPEN) return;
    await appServerProcess.ensureStarted();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
      const timeout = setTimeout(() => reject(new Error("timeout connecting to app-server websocket")), 10000);
      ws.on("open", () => {
        clearTimeout(timeout);
        this.appSocket = ws;
        ws.on("message", (data) => this.handleAppMessage(data));
        ws.on("close", () => {
          if (this.appSocket === ws) this.appSocket = null;
        });
        ws.on("error", (error) => log("app-server websocket error", error.message));
        resolve();
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await this.appRequest("initialize", {
      clientInfo: { name: clientName, title: appDisplayName, version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, { internal: true });
  }

  handleAppMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        debugLog("app-server internal error", message.id, message.error.message || message.error);
        if (looksLikeSwitchableAccountFailure(message.error)) {
          void requestAccountSwitch("app-server-internal-quota-error", { error: message.error });
        }
        pending.reject(new Error(message.error.message || "app-server request failed"));
      } else {
        debugLog("app-server internal response", message.id);
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      debugLog("app-server response", message.id, "error" in message ? "error" : "result");
      const forwarded = this.forwardedRequests.get(message.id);
      const deferredAcked = this.ackedDeferredTurnRequestIds.delete(String(message.id));
      let result = message.result;
      if (forwarded) {
        this.forwardedRequests.delete(message.id);
        if (forwarded.method === "thread/list" && "result" in message) {
          result = canonicalizeThreadListProjectCwds(message.result);
        }
        if (forwarded.method === "thread/read" && "result" in message) {
          result = canonicalizeThreadReadResult(message.result);
          if (result?.thread?.ephemeral === true) {
            this.rememberEphemeralThread(
              result.thread.id || result.thread.sessionId || forwarded.params?.threadId,
              "thread/read-forwarded",
              result.thread.turns,
            );
          }
        }
        if (forwarded.method === "thread/turns/list" && "result" in message) {
          result = normalizeThreadTurnsResult(message.result, { threadId: forwarded.params?.threadId || null });
          setCachedThreadTurns(forwarded.params, result);
        }
        if (forwarded.method === "thread/turns/list" && "error" in message && looksLikeEphemeralThreadTurnsUnsupported(message.error)) {
          this.rememberEphemeralThread(forwarded.params?.threadId, "thread/turns/list-forwarded-error");
        }
      }
      if (forwarded && "result" in message) {
        this.observeActiveTurnFromRequest(forwarded.method, forwarded.params || {}, result);
      }
      if ("error" in message && looksLikeSwitchableAccountFailure(message.error)) {
        void requestAccountSwitch("app-server-quota-error", {
          error: message.error,
          method: message.method || null,
        });
      }
      if (deferredAcked) {
        if ("error" in message) {
          const threadId = threadIdFromParams(forwarded?.params || {});
          if (threadId) {
            this.broadcastThreadActivity(threadId, {
              reason: "large-thread-deferred-turn-error",
              status: "errored",
              error: message.error?.message || "Deferred turn failed",
            });
          }
          log("deferred turn request failed after browser ack", {
            requestId: message.id,
            method: forwarded?.method || null,
            threadId: threadId || null,
            error: message.error?.message || String(message.error || "unknown error"),
          });
        }
        return;
      }
      const browserResponseMessage = {
        id: message.id,
        ...("result" in message ? { result } : {}),
        ...("error" in message ? { error: message.error } : {}),
      };
      this.sendToBrowser({
        type: "mcp-response",
        hostId: "local",
        message: browserResponseMessage,
      });
      if (forwarded) this.finishPendingTurnInputSubmission(message.id, browserResponseMessage);
      return;
    }

    if (message.id !== undefined && message.method) {
      debugLog("app-server request", message.method, message.id);
      this.sendToBrowser({
        type: "mcp-request",
        hostId: "local",
        request: {
          id: message.id,
          method: message.method,
          params: message.params,
        },
      });
      return;
    }

    if (message.method) {
      debugLog("app-server notification", message.method);
      if (message.method === "remoteControl/status/changed") {
        try {
          writeRemoteControlSharedState(message.params || {});
        } catch (error) {
          log("failed to apply remote control status notification", error.message || String(error));
        }
      }
      if (shouldInvalidateThreadTurns(message.method, message.params)) {
        invalidateThreadTurnsCache(message.params.threadId);
        if (message.params?.threadId) {
          this.broadcastThreadActivity(message.params.threadId, {
            reason: `notification:${message.method}`,
            status: "changed",
          });
        }
      }
      if (rateLimitsExhausted(message.params) || looksLikeSwitchableAccountFailure(message.params)) {
        void requestAccountSwitch("app-server-quota-notification", {
          rateLimits: message.params,
          method: message.method,
        });
      }
      this.sendToBrowser({
        type: "mcp-notification",
        hostId: "local",
        method: message.method,
        params: message.params,
      });
    }
  }

  async appRequest(method, params, options = {}) {
    await this.ensureAppSocket();
    const id = options.id || `${options.internal ? "bridge" : "fetch"}-${crypto.randomUUID()}`;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (options.timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error("app-server request timed out"));
        }, options.timeoutMs).unref?.();
      }
    });
    this.appSocket.send(JSON.stringify(payload));
    return promise;
  }

  async appSend(message) {
    await this.ensureAppSocket();
    this.appSocket.send(JSON.stringify(message));
  }

  ensureLargeThreadLoadedInAppServer(threadId, params = {}, options = {}) {
    if (typeof threadId !== "string" || threadId.length === 0) return null;
    if (selectedLocalFullAccessEnabled()) persistFullAccessThreadPolicy(threadId, "large-thread-app-resume");
    const resumeParams = largeThreadAppResumeParams({ ...params, threadId });
    if (!resumeParams) return null;
    const existing = this.largeThreadAppResumePromises.get(threadId);
    if (existing) return existing;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const loaded = await this.appRequest("thread/loaded/list", {}, { timeoutMs: 5000, internal: true }).catch(() => null);
        if (Array.isArray(loaded?.data) && loaded.data.includes(threadId)) return { loaded: true, alreadyLoaded: true };
        const result = await this.appRequest("thread/resume", resumeParams, {
          timeoutMs: options.timeoutMs || largeThreadAppResumeTimeoutMs,
          internal: true,
        });
        log("large thread resumed in app-server", {
          threadId,
          durationMs: Date.now() - startedAt,
          excludeTurns: true,
          returnedTurns: Array.isArray(result?.thread?.turns) ? result.thread.turns.length : null,
        });
        return { loaded: true, alreadyLoaded: false };
      } catch (error) {
        this.largeThreadAppResumePromises.delete(threadId);
        log("large thread app-server resume failed", {
          threadId,
          durationMs: Date.now() - startedAt,
          error: error.message || String(error),
        });
        throw error;
      }
    })();
    this.largeThreadAppResumePromises.set(threadId, promise);
    return promise;
  }

  prewarmLargeThreadInAppServer(threadId, params = {}) {
    const promise = this.ensureLargeThreadLoadedInAppServer(threadId, params, {
      timeoutMs: largeThreadAppResumeTimeoutMs,
    });
    if (promise) promise.catch(() => {});
  }

  async waitForLargeThreadSubmitResume(threadId, params = {}) {
    const promise = this.ensureLargeThreadLoadedInAppServer(threadId, params, {
      timeoutMs: largeThreadAppResumeTimeoutMs,
    });
    if (!promise) return { ready: true, promise: null };
    let timeout = null;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`large thread submit resume timed out after ${largeThreadSubmitResumeTimeoutMs}ms`));
          }, largeThreadSubmitResumeTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      return { ready: true, promise };
    } catch (error) {
      log("large thread submit resume deferred; waiting for app-server resume", {
        threadId,
        error: error.message || String(error),
      });
      this.broadcastThreadActivity(threadId, {
        reason: "large-thread-submit-resume-pending",
        status: "inProgress",
        message: "Connecting long thread before sending",
      });
      return { ready: false, promise, error };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  sendMcpErrorResponse(requestId, message, code = -32603) {
    if (requestId === undefined || requestId === null) return;
    const errorMessage = {
      id: requestId,
      error: {
        code,
        message,
      },
    };
    this.sendToBrowser({
      type: "mcp-response",
      hostId: "local",
      message: errorMessage,
    });
    this.finishPendingTurnInputSubmission(requestId, errorMessage);
  }

  async sendMcpRequestToAppServer(request, params = {}) {
    debugLog("to app-server", request.method, request.id);
    this.forwardedRequests.set(request.id, { method: request.method, params: params || {} });
    await this.appSend({
      jsonrpc: "2.0",
      id: request.id,
      method: request.method,
      params,
    });
    this.recordTurnInputSubmission(request.method, params || {});
    this.observeActiveTurnFromRequest(request.method, params || {}, null);
  }

  sendDeferredTurnAck(request, params = {}) {
    if (!request || request.id === undefined || request.id === null) return;
    const responseMessage = {
      id: request.id,
      result: {},
    };
    this.ackedDeferredTurnRequestIds.add(String(request.id));
    this.sendToBrowser({
      type: "mcp-response",
      hostId: "local",
      message: responseMessage,
    });
    this.finishPendingTurnInputSubmission(request.id, responseMessage);
    this.recordTurnInputSubmission(request.method, params || {});
    this.observeActiveTurnFromRequest(request.method, params || {}, null);
  }

  deferLargeThreadTurnRequest(request, params = {}, resumeState = {}) {
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return false;
    this.sendDeferredTurnAck(request, params || {});
    this.broadcastThreadActivity(threadId, {
      reason: "large-thread-submit-queued",
      status: "inProgress",
      message: "Connecting long thread before sending",
    });
    void (async () => {
      try {
        await resumeState.promise;
        if (this.closed) return;
        const nextParams = request.method === "turn/steer"
          ? await this.withLatestExpectedTurnId(request.method, params)
          : params;
        await this.sendMcpRequestToAppServer(request, nextParams || {});
      } catch (error) {
        log("large thread deferred turn request failed", {
          method: request.method,
          threadId,
          requestId: request.id ?? null,
          error: error.message || String(error),
        });
        const wasAcked = request.id !== undefined && request.id !== null
          ? this.ackedDeferredTurnRequestIds.delete(String(request.id))
          : false;
        if (!wasAcked) {
          this.sendMcpErrorResponse(
            request.id,
            "Long thread is still connecting. The message was not sent; please retry after the thread status updates.",
          );
        }
        this.broadcastThreadActivity(threadId, {
          reason: "large-thread-submit-queue-failed",
          status: "errored",
          error: error.message || String(error),
        });
      }
    })();
    return true;
  }

  async readCurrentAccountForProvider() {
    try {
      return await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000, internal: true });
    } catch {
      return null;
    }
  }

  async readRemoteControlStatus({ write = true } = {}) {
    const status = await remoteControlKeeper.readStatus({ autoEnable: false });
    if (write) writeRemoteControlSharedState(status || {});
    return status || {};
  }

  async setRemoteControlEnabled(enabled, params = {}) {
    if (!enabled && readRemoteControlDesiredEnabled() === true && readRemoteControlEnrollments().length > 0 && params.forceDisable !== true) {
      log("ignoring non-forced remote-control disable while desired state is enabled");
      return remoteControlKeeper.enable();
    }
    return enabled ? remoteControlKeeper.enable() : remoteControlKeeper.disable();
  }

  async refreshRemoteControlSharedObjects() {
    try {
      const status = await remoteControlKeeper.readStatus({ autoEnable: true });
      const { state, connections } = writeRemoteControlSharedState(status || {});
      return { status, state, connections };
    } catch (error) {
      const state = remoteControlStateFromStatus({}, {
        available: true,
        authRequired: looksLikeAuthInvalidated(error),
        clientAuthorized: false,
        enabled: false,
        status: "errored",
        error: error.message || String(error),
      });
      writeHostState("remote_control_connections_state", state);
      broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections_state", value: state });
      return { status: null, state, connections: readHostState("remote_control_connections") || [] };
    }
  }

  async refreshCodexMobileCompletedSharedObject() {
    try {
      const result = normalizeRemoteControlClientsResponse(
        await this.chatGptBackendJson("/wham/remote/control/clients", { method: "GET" }),
      );
      return writeCodexMobileCompletedFromClients(result);
    } catch (error) {
      log("codex mobile connected-device refresh failed", error.message || String(error));
      return readHostState("codex-mobile-has-connected-device") === true;
    }
  }

  async chatGptBackendJson(localPath, message = {}, fallback = undefined) {
    const attempt = async () => {
      const token = readChatGptAccessToken();
      if (!token) {
        const error = new Error("ChatGPT auth token is unavailable");
        error.status = 401;
        throw error;
      }
      const target = new URL(String(localPath || "/").replace(/^\/+/, ""), "https://chatgpt.com/backend-api/");
      const method = String(message.method || "GET").toUpperCase();
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      };
      if (method !== "GET" && method !== "HEAD" && message.body != null) {
        headers["content-type"] = "application/json";
      }
      const response = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : message.body || undefined,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        const error = new Error(text || response.statusText || `ChatGPT backend returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    };

    try {
      return await attempt();
    } catch (error) {
      if (error?.status === 401) {
        try {
          await this.appRequest("account/read", { refreshToken: true }, { timeoutMs: 30000, internal: true });
          return await attempt();
        } catch {}
      }
      if (fallback !== undefined) return fallback;
      throw error;
    }
  }

  async preflightAccountSwitchForRequest(request) {
    if (!autoAccountSwitchEnabled || !request || request.method !== "turn/start") return;
    try {
      const providerCurrent = await accountProviderJson("GET", "/current").catch(() => null);
      if (providerCurrentExhausted(providerCurrent)) {
        await requestAccountSwitch("turn-start-provider-preflight", {
          method: request.method,
          rateLimits: providerCurrent,
          account: providerCurrent?.account || await this.readCurrentAccountForProvider(),
        });
        return;
      }
      const rateLimits = await this.appRequest("account/rateLimits/read", {}, { timeoutMs: 30000, internal: true });
      if (!rateLimitsExhausted(rateLimits)) return;
      await requestAccountSwitch("turn-start-preflight", {
        method: request.method,
        rateLimits,
        account: await this.readCurrentAccountForProvider(),
      });
    } catch (error) {
      if (looksLikeSwitchableAccountFailure(error)) {
        await requestAccountSwitch("turn-start-preflight-error", {
          method: request.method,
          error,
          account: await this.readCurrentAccountForProvider(),
        });
      }
    }
  }

  async handleBrowserMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case "codexapp-bridge-ack":
        this.acknowledgeBrowserSequence(Number(message.sequence));
        break;
      case "mcp-request":
      case "thread-prewarm-start":
        debugLog("browser request", message.request?.method, message.request?.id);
        try {
          await this.forwardClientRequest(message);
        } catch (error) {
          const requestId = message.request?.id;
          log("browser request forwarding failed", {
            method: message.request?.method || null,
            requestId: requestId ?? null,
            error: error.stack || error.message || String(error),
          });
          if (requestId !== undefined) {
            const errorMessage = {
              id: requestId,
              error: {
                code: -32603,
                message: error.message || "request forwarding failed",
              },
            };
            this.sendToBrowser({
              type: "mcp-response",
              hostId: "local",
              message: errorMessage,
            });
            this.finishPendingTurnInputSubmission(requestId, errorMessage);
          }
        }
        break;
      case "mcp-notification":
        debugLog("browser notification", message.request?.method);
        await this.forwardClientNotification(message);
        break;
      case "mcp-response":
        debugLog("browser response", message.response?.id);
        await this.forwardClientResponse(message);
        break;
      case "fetch":
        debugLog("browser fetch", message.url, message.requestId);
        await this.handleFetch(message);
        break;
      case "fetch-stream":
        await this.handleFetchStream(message);
        break;
      case "cancel-fetch":
      case "cancel-fetch-stream":
        this.cancelFetch(message.requestId);
        break;
      case "shared-object-subscribe":
        if (isRemoteControlSharedObjectKey(message.key)) {
          await this.refreshRemoteControlSharedObjects();
        }
        if (message.key === "codex-mobile-has-connected-device") {
          await this.refreshCodexMobileCompletedSharedObject();
        }
        this.sendToBrowser({ type: "shared-object-updated", key: message.key, value: sharedObjectValue(message.key) });
        break;
      case "shared-object-set":
        if (message.key === "statsig_default_enable_features") {
          const value = normalizeSharedObjectSetValue(message.key, message.value);
          writeHostState(message.key, value);
          this.sendToBrowser({ type: "shared-object-updated", key: message.key, value });
        }
        break;
      case "shared-object-unsubscribe":
        break;
      case "persisted-atom-sync-request":
        debugLog("persisted atom sync request");
        ensureManagedPersistedPermissionState("persisted-atom-sync");
        this.sendToBrowser({ type: "persisted-atom-sync", state: persistedAtomState });
        break;
      case "persisted-atom-update":
        debugLog("persisted atom update", message.key);
        this.updatePersistedAtom(message);
        break;
      case "persisted-atom-reset":
        persistedAtomState = {};
        savePersistedAtomState();
        this.sendToBrowser({ type: "persisted-atom-sync", state: persistedAtomState });
        break;
      case "log-message":
      case "desktop-notification-hide":
      case "desktop-notification-show":
      case "electron-app-state-snapshot-trigger":
      case "electron-app-state-snapshot-response":
      case "electron-window-focus-request":
      case "hotkey-window-enabled-changed":
      case "global-dictation-enabled-changed":
      case "heartbeat-automations-enabled-changed":
      case "codex-runtimes-config-changed":
      case "electron-avatar-overlay-restore-ready":
      case "local-thread-activity-changed":
      case "set-telemetry-user":
      case "electron-set-badge-count":
      case "electron-window-zoom-changed":
      case "tray-menu-threads-changed":
      case "keyboard-layout-map-changed":
      case "mac-menu-bar-enabled-changed":
      case "electron-desktop-features-changed":
      case "electron-set-window-mode":
      case "power-save-blocker-set":
      case "avatar-overlay-open-state-request":
      case "browser-sidebar-owner-sync":
      case "browser-sidebar-tweaks-enabled-changed":
      case "browser-use-non-local-sites-allowed-changed":
      case "browser-use-session-route-capture":
      case "browser-use-session-activity-ended":
      case "browser-use-turn-route-capture":
      case "browser-use-turn-route-release":
      case "computer-use-turn-route-capture":
      case "computer-use-turn-route-release":
      case "app-shell-shortcut-state-changed":
      case "codex-mobile-sidebar-nav-item-clicked-v1":
      case "thread-stream-state-changed":
      case "heartbeat-automation-thread-state-changed":
      case "thread-read-state-changed":
      case "update-diff-if-open":
      case "tabs:outgoing.message.ready":
      case "query-cache-invalidate":
      case "ready":
      case "view-focused":
        break;
      case "electron-set-active-workspace-root":
        setActiveWorkspaceRoot(message.root);
        break;
      case "electron-clear-active-workspace-root":
        setActiveWorkspaceRoot(null);
        break;
      case "electron-add-new-workspace-root-option":
      case "electron-pick-workspace-root-option":
      case "codexapp-register-workspace-root": {
        try {
          const payload = message.params || message;
          const result = registerWorkspaceRoot(payload.root, {
            label: payload.label,
            setActive: payload.setActive !== false,
            picked: payload.picked !== false,
            added: true,
            create: payload.create !== false,
          });
          if (message.requestId) {
            this.sendToBrowser({
              type: "codexapp-browser-request-result",
              requestId: message.requestId,
              result,
            });
          }
        } catch (error) {
          if (message.requestId) {
            this.sendToBrowser({
              type: "codexapp-browser-request-result",
              requestId: message.requestId,
              error: error.message || "workspace root registration failed",
            });
          } else {
            log("workspace root registration failed", error.message || String(error));
          }
        }
        break;
      }
      case "electron-create-new-workspace-root-option": {
        const created = createManagedWorkspaceRoot(message);
        registerWorkspaceRoot(created.root, {
          label: created.label,
          setActive: true,
          picked: true,
          added: true,
        });
        break;
      }
      case "electron-onboarding-pick-workspace-or-create-default": {
        const created = createManagedWorkspaceRoot(message);
        registerWorkspaceRoot(created.root, {
          label: created.label,
          setActive: true,
          picked: true,
          added: true,
          onboardingResult: true,
        });
        break;
      }
      case "electron-onboarding-skip-workspace": {
        const created = createManagedWorkspaceRoot(message);
        registerWorkspaceRoot(created.root, {
          label: created.label,
          setActive: true,
          picked: true,
          added: true,
        });
        broadcastBridgeMessage({
          type: "electron-onboarding-skip-workspace-result",
          success: true,
          root: created.root,
          label: created.label,
        });
        break;
      }
      case "electron-rename-workspace-root-option":
        renameWorkspaceRootOption(message.root, message.label);
        break;
      case "electron-update-workspace-root-options":
        updateWorkspaceRootOptions(message.roots, message.labels);
        break;
      case "codexapp-project-writable-root-add":
        this.sendToBrowser({
          type: "codexapp-browser-request-result",
          requestId: message.requestId,
          result: addProjectWritableRoot(message.params || message),
        });
        break;
      case "codexapp-project-writable-roots-clear":
        this.sendToBrowser({
          type: "codexapp-browser-request-result",
          requestId: message.requestId,
          result: clearProjectWritableRoots(message.params || message),
        });
        break;
      case "codexapp-upload-browser-files":
        try {
          this.sendToBrowser({
            type: "codexapp-browser-request-result",
            requestId: message.requestId,
            result: writeBrowserUploadedFiles(message.params || message),
          });
        } catch (error) {
          this.sendToBrowser({
            type: "codexapp-browser-request-result",
            requestId: message.requestId,
            error: error.message || "upload failed",
          });
        }
        break;
      case "thread-queued-followups-changed":
        broadcastBridgeMessage({
          type: "thread-queued-followups-changed",
          params: {
            conversationId: message.conversationId ?? message.params?.conversationId,
            messages: Array.isArray(message.messages)
              ? message.messages
              : (Array.isArray(message.params?.messages) ? message.params.messages : []),
          },
        });
        break;
      case "worker-message":
        this.sendToBrowser(message);
        break;
      default:
        if (handleTerminalBridgeMessage(this, message)) break;
        log("unhandled browser bridge message", message.type);
        break;
    }
  }

  updatePersistedAtom(message) {
    if (!message || typeof message.key !== "string") return;
    reloadPersistedAtomStateIfChanged();
    const previousValue = persistedAtomState[message.key];
    const normalized = normalizeManagedPermissionAtomValue(message.key, message.value);
    if (message.deleted || message.value === undefined) {
      delete persistedAtomState[message.key];
    } else {
      persistedAtomState[message.key] = normalized.value;
    }
    savePersistedAtomState();
    this.sendToBrowser({
      type: "persisted-atom-updated",
      key: message.key,
      value: message.deleted ? null : normalized.value,
      deleted: !!message.deleted,
    });
    if (!message.deleted && message.key === "prompt-history") {
      this.schedulePromptHistorySteerRecoveries(previousValue, message.value);
    }
  }

  cleanupRecentTurnInputSubmissions(now = Date.now()) {
    for (const [signature, storedAt] of this.recentTurnInputSubmissions) {
      if (now - storedAt > turnInputSubmissionTtlMs) this.recentTurnInputSubmissions.delete(signature);
    }
  }

  cleanupPromptHistoryEligibleThreads(now = Date.now()) {
    for (const [threadId, storedAt] of this.promptHistoryEligibleThreads) {
      if (now - storedAt > promptHistoryThreadEligibilityTtlMs) {
        this.promptHistoryEligibleThreads.delete(threadId);
      }
    }
  }

  rememberPromptHistoryEligibleThread(threadId) {
    if (typeof threadId !== "string" || threadId.length === 0) return;
    this.cleanupPromptHistoryEligibleThreads();
    this.promptHistoryEligibleThreads.set(threadId, Date.now());
  }

  rememberPromptHistoryEligibleThreadFromRequest(method, params = {}) {
    if (!["thread/read", "thread/turns/list", "turn/start", "turn/steer"].includes(method)) return;
    this.rememberPromptHistoryEligibleThread(params.threadId);
  }

  isPromptHistoryRecoveryEligibleThread(threadId) {
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    this.cleanupPromptHistoryEligibleThreads();
    return this.promptHistoryEligibleThreads.has(threadId);
  }

  recordTurnInputSubmission(method, params = {}) {
    if (method !== "turn/start" && method !== "turn/steer") return;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    const signature = turnInputSignature(threadId, params.input);
    if (!signature) return;
    this.cleanupRecentTurnInputSubmissions();
    this.recentTurnInputSubmissions.set(signature, Date.now());
  }

  hasRecentTurnInputSubmission(signature) {
    if (!signature) return false;
    this.cleanupRecentTurnInputSubmissions();
    return this.recentTurnInputSubmissions.has(signature);
  }

  cleanupPendingTurnInputSubmissions(now = Date.now()) {
    for (const [signature, entry] of this.pendingTurnInputSubmissions) {
      if (now - Number(entry?.storedAt || 0) > turnInputCoalesceTtlMs) this.pendingTurnInputSubmissions.delete(signature);
    }
  }

  registerPendingTurnInputSubmission(method, params = {}, requestId = null) {
    if (method !== "turn/start" && method !== "turn/steer") return null;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const signature = turnInputSignature(threadId, params.input);
    if (!signature || requestId == null) return null;
    this.cleanupPendingTurnInputSubmissions();
    const existing = this.pendingTurnInputSubmissions.get(signature);
    if (existing) {
      const duplicateId = String(requestId);
      if (duplicateId !== existing.primaryRequestId && !existing.duplicateRequestIds.includes(duplicateId)) {
        existing.duplicateRequestIds.push(duplicateId);
      }
      log("coalesced duplicate turn submission", {
        method,
        threadId,
        primaryRequestId: existing.primaryRequestId,
        duplicateRequestId: duplicateId,
      });
      return { duplicate: true, signature };
    }
    this.pendingTurnInputSubmissions.set(signature, {
      method,
      threadId,
      primaryRequestId: String(requestId),
      duplicateRequestIds: [],
      storedAt: Date.now(),
    });
    return { duplicate: false, signature };
  }

  finishPendingTurnInputSubmission(requestId, responseMessage = null) {
    if (requestId == null) return;
    const id = String(requestId);
    for (const [signature, entry] of this.pendingTurnInputSubmissions) {
      if (entry?.primaryRequestId !== id) continue;
      this.pendingTurnInputSubmissions.delete(signature);
      const duplicateIds = Array.isArray(entry.duplicateRequestIds) ? entry.duplicateRequestIds.slice() : [];
      if (!responseMessage || duplicateIds.length === 0) return;
      for (const duplicateId of duplicateIds) {
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: {
            ...responseMessage,
            id: duplicateId,
          },
        });
      }
      return;
    }
  }

  cleanupEphemeralThreads(now = Date.now()) {
    for (const [threadId, entry] of this.ephemeralThreads) {
      if (now - Number(entry?.rememberedAt || 0) > ephemeralThreadMemoryTtlMs) {
        this.ephemeralThreads.delete(threadId);
      }
    }
  }

  rememberEphemeralThread(threadId, reason = "ephemeral", turns = null) {
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    this.cleanupEphemeralThreads();
    if (threadRecord(threadId)) {
      this.ephemeralThreads.delete(threadId);
      debugLog("ignored persisted thread ephemeral classification", { threadId, reason });
      return false;
    }
    const existing = this.ephemeralThreads.get(threadId);
    const normalizedTurns = Array.isArray(turns)
      ? normalizeThreadTurnsResult({ data: turns }, { threadId }).data
      : (Array.isArray(existing?.turns) ? existing.turns : null);
    this.ephemeralThreads.set(threadId, {
      rememberedAt: Date.now(),
      turns: normalizedTurns,
    });

    const state = this.activeTurnWatchdogs.get(threadId);
    if (state?.timer) clearTimeout(state.timer);
    this.activeTurnWatchdogs.delete(threadId);

    if (!existing) {
      log("remembered ephemeral thread; skipping turns list/watchdog", { threadId, reason });
    }
    return true;
  }

  isKnownEphemeralThread(threadId) {
    if (typeof threadId !== "string" || threadId.length === 0) return false;
    this.cleanupEphemeralThreads();
    if (this.ephemeralThreads.has(threadId) && threadRecord(threadId)) {
      this.ephemeralThreads.delete(threadId);
      return false;
    }
    return this.ephemeralThreads.has(threadId);
  }

  ephemeralThreadTurnsResponse(threadId) {
    if (!this.isKnownEphemeralThread(threadId)) return null;
    const entry = this.ephemeralThreads.get(threadId);
    return {
      data: Array.isArray(entry?.turns) ? entry.turns : [],
      nextCursor: null,
      backwardsCursor: null,
    };
  }

  observeActiveTurnFromRequest(method, params = {}, result = null) {
    if (!activeTurnWatchdogEnabled) return;
    const threadId = threadIdFromTurnPayload(params, result);
    if (!threadId) return;
    const ephemeralThreadId = ephemeralThreadIdFromResult(method, params, result);
    if (ephemeralThreadId) {
      this.rememberEphemeralThread(ephemeralThreadId, method, result.thread.turns);
      return;
    }
    if (this.isKnownEphemeralThread(threadId)) return;
    if (method === "turn/start" || method === "turn/steer") {
      this.startActiveTurnWatchdog(threadId, method, result);
      return;
    }
    if (method === "thread/turns/list" && threadTurnsResultHasInProgress(result)) {
      this.startActiveTurnWatchdog(threadId, method, result);
    }
  }

  startActiveTurnWatchdog(threadId, reason = "active-turn", result = null) {
    if (!activeTurnWatchdogEnabled || this.closed || typeof threadId !== "string" || threadId.length === 0) return;
    if (this.isKnownEphemeralThread(threadId)) return;
    const now = Date.now();
    let state = this.activeTurnWatchdogs.get(threadId);
    if (!state) {
      state = {
        threadId,
        startedAt: now,
        lastSignature: null,
        seenInProgress: false,
        doneConfirmations: 0,
        polling: false,
        timer: null,
        errorCount: 0,
      };
      this.activeTurnWatchdogs.set(threadId, state);
    }
    const hasResultInProgress = result && threadTurnsResultHasInProgress(result);
    if (hasResultInProgress) {
      state.seenInProgress = true;
      state.lastSignature = threadTurnsResultSignature(result) || state.lastSignature;
      state.doneConfirmations = 0;
    }
    this.scheduleActiveTurnWatchdog(threadId, hasResultInProgress ? 0 : activeTurnWatchdogFastIntervalMs, reason);
  }

  scheduleActiveTurnWatchdog(threadId, delayMs = null, reason = "scheduled") {
    const state = this.activeTurnWatchdogs.get(threadId);
    if (!state || this.closed) return;
    if (state.timer) clearTimeout(state.timer);
    const elapsedMs = Date.now() - state.startedAt;
    const nextDelayMs = delayMs == null
      ? (elapsedMs >= activeTurnWatchdogSlowAfterMs ? activeTurnWatchdogSlowIntervalMs : activeTurnWatchdogFastIntervalMs)
      : delayMs;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.pollActiveTurnWatchdog(threadId, reason).catch((error) => {
        log("active turn watchdog poll failed", { threadId, reason, error: error.message || String(error) });
      });
    }, Math.max(0, nextDelayMs));
    state.timer.unref?.();
  }

  async pollActiveTurnWatchdog(threadId, reason = "poll") {
    const state = this.activeTurnWatchdogs.get(threadId);
    if (!state || this.closed) return;
    if (this.isKnownEphemeralThread(threadId)) {
      this.activeTurnWatchdogs.delete(threadId);
      return;
    }
    if (state.polling) {
      this.scheduleActiveTurnWatchdog(threadId, activeTurnWatchdogSlowIntervalMs, "poll-in-flight");
      return;
    }
    if (Date.now() - state.startedAt > activeTurnWatchdogMaxDurationMs) {
      this.activeTurnWatchdogs.delete(threadId);
      log("active turn watchdog stopped after max duration", { threadId, reason });
      return;
    }

    state.polling = true;
    try {
      const completeResult = await this.completeThreadTurnsResponse({
        threadId,
        cursor: null,
        limit: activeTurnWatchdogPageLimit,
      });
      if (this.isKnownEphemeralThread(threadId)) {
        this.activeTurnWatchdogs.delete(threadId);
        return;
      }
      const result = completeResult || await this.appRequest("thread/turns/list", {
        threadId,
        cursor: null,
        limit: activeTurnWatchdogPageLimit,
      }, {
        timeoutMs: 30000,
        internal: true,
      });
      const normalized = normalizeThreadTurnsResult(result, { threadId });
      const signature = threadTurnsResultSignature(normalized);
      const hasInProgress = threadTurnsResultHasInProgress(normalized);
      const changed = signature && signature !== state.lastSignature;
      state.errorCount = 0;
      if (hasInProgress) state.seenInProgress = true;
      const startupGraceElapsed = Date.now() - state.startedAt >= activeTurnWatchdogSlowAfterMs;
      const completionIsAuthoritative = state.seenInProgress || startupGraceElapsed;

      if (changed || !hasInProgress) {
        state.lastSignature = signature || state.lastSignature;
        invalidateThreadTurnsCache(threadId);
        this.broadcastThreadActivity(threadId, {
          reason,
          status: hasInProgress ? "inProgress" : "idle",
          final: !hasInProgress && completionIsAuthoritative,
        });
      }

      if (hasInProgress) {
        state.doneConfirmations = 0;
      } else if (completionIsAuthoritative) {
        state.doneConfirmations += 1;
      } else {
        state.doneConfirmations = 0;
      }

      if (state.doneConfirmations >= activeTurnWatchdogDoneConfirmations) {
        this.activeTurnWatchdogs.delete(threadId);
        return;
      }
    } catch (error) {
      if (looksLikeEphemeralThreadTurnsUnsupported(error)) {
        this.rememberEphemeralThread(threadId, "active-turn-watchdog-error");
        return;
      }
      state.errorCount += 1;
      if (state.errorCount === 5) {
        log("active turn watchdog repeated errors", { threadId, error: error.message || String(error) });
      }
    } finally {
      state.polling = false;
    }

    if (this.activeTurnWatchdogs.has(threadId)) {
      this.scheduleActiveTurnWatchdog(threadId);
    }
  }

  broadcastThreadActivity(threadId, details = {}) {
    if (typeof threadId !== "string" || threadId.length === 0) return;
    const params = {
      threadId,
      conversationId: threadId,
      source: "codexapp-active-turn-watchdog",
      updatedAt: Date.now(),
      ...details,
    };
    for (const type of ["local-thread-activity-changed", "thread-stream-state-changed", "thread-read-state-changed"]) {
      this.sendToBrowser({ type, ...params, params });
    }
  }

  schedulePromptHistorySteerRecoveries(previousValue, nextValue) {
    if (!promptHistorySteerRecoveryEnabled) return;
    const entries = appendedPromptHistoryEntries(previousValue, nextValue);
    for (const entry of entries) {
      this.schedulePromptHistorySteerRecovery(entry.threadId, entry.text, {
        delayMs: promptHistorySteerRecoveryImmediateDelayMs,
        retryDelayMs: promptHistorySteerRecoveryDelayMs,
      });
    }
  }

  schedulePromptHistorySteerRecovery(threadId, text, options = {}) {
    if (!this.isPromptHistoryRecoveryEligibleThread(threadId)) return;
    const signature = turnInputSignature(threadId, text);
    if (!signature || this.hasRecentTurnInputSubmission(signature)) return;
    if (this.promptHistoryRecoveryTimers.has(signature)) return;
    const delayMs = Math.max(0, Number(options.delayMs ?? promptHistorySteerRecoveryDelayMs) || 0);
    const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) ? Math.max(0, Number(options.retryDelayMs)) : null;
    const timer = setTimeout(() => {
      this.promptHistoryRecoveryTimers.delete(signature);
      this.recoverPromptHistorySteer(threadId, text, signature)
        .then((status) => {
          if (status !== "not-ready" || retryDelayMs == null || this.hasRecentTurnInputSubmission(signature)) return;
          this.schedulePromptHistorySteerRecovery(threadId, text, { delayMs: retryDelayMs, retryDelayMs: null });
        })
        .catch((error) => {
          debugLog("prompt-history steer recovery failed", threadId, error.message || String(error));
          if (retryDelayMs == null || this.hasRecentTurnInputSubmission(signature)) return;
          this.schedulePromptHistorySteerRecovery(threadId, text, { delayMs: retryDelayMs, retryDelayMs: null });
        });
    }, delayMs);
    timer.unref?.();
    this.promptHistoryRecoveryTimers.set(signature, timer);
  }

  async latestActiveTurnId(threadId) {
    if (this.isKnownEphemeralThread(threadId)) return null;
    const params = {
      threadId,
      cursor: null,
      limit: activeTurnWatchdogPageLimit,
    };
    const completeResult = await this.completeThreadTurnsResponse(params);
    if (this.isKnownEphemeralThread(threadId)) return null;
    const result = completeResult || await this.appRequest("thread/turns/list", params, {
      timeoutMs: 30000,
      internal: true,
    });
    const turn = Array.isArray(result?.data)
      ? result.data.find((item) => item?.status === "inProgress")
      : null;
    if (!turn) return null;
    return typeof turn.id === "string" ? turn.id : (typeof turn.turnId === "string" ? turn.turnId : null);
  }

  async latestActiveTurnIdWithRetry(threadId, timeoutMs = 1500) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        const turnId = await this.latestActiveTurnId(threadId);
        if (turnId) return turnId;
      } catch (error) {
        lastError = error;
      }
      await delay(150);
    }
    if (lastError) debugLog("latest active turn lookup failed", threadId, lastError.message || String(lastError));
    return null;
  }

  async withLatestExpectedTurnId(method, params) {
    if (method !== "turn/steer" || !params || typeof params !== "object" || Array.isArray(params)) return params;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return params;
    const expectedTurnId = await this.latestActiveTurnIdWithRetry(threadId);
    if (!expectedTurnId || params.expectedTurnId === expectedTurnId) return params;
    log("normalized turn/steer expectedTurnId", {
      threadId,
      hadExpectedTurnId: typeof params.expectedTurnId === "string" && params.expectedTurnId.length > 0,
    });
    return { ...params, expectedTurnId };
  }

  async recoverPromptHistorySteer(threadId, text, signature) {
    if (this.closed || this.hasRecentTurnInputSubmission(signature)) return "already-submitted";
    const expectedTurnId = await this.latestActiveTurnId(threadId);
    if (!expectedTurnId) return "not-ready";
    if (this.hasRecentTurnInputSubmission(signature)) return "already-submitted";
    const input = textInputFromPromptHistory(text);
    if (input.length === 0) return "empty";
    const params = { threadId, input, expectedTurnId };
    try {
      await this.appRequest("turn/steer", params, { timeoutMs: 120000, internal: true });
    } catch (error) {
      const replacementTurnId = String(error?.message || "").match(/expected active turn id `[^`]+` but found `([^`]+)`/)?.[1];
      if (!replacementTurnId) throw error;
      await this.appRequest("turn/steer", {
        ...params,
        expectedTurnId: replacementTurnId,
      }, {
        timeoutMs: 120000,
        internal: true,
      });
    }
    this.recentTurnInputSubmissions.set(signature, Date.now());
    invalidateThreadTurnsCache(threadId);
    this.observeActiveTurnFromRequest("turn/steer", params, null);
    this.broadcastThreadActivity(threadId, { reason: "prompt-history-steer-recovered", status: "inProgress" });
    log("recovered prompt-history steer submission", { threadId, textHash: signature.split(":").pop() });
    return "submitted";
  }

  async forwardClientRequest(message) {
    const request = message.request;
    if (!request || request.id === undefined || !request.method) return;
    const params = await this.withLatestExpectedTurnId(
      request.method,
      forceLocalManagedWorkspacePermissions(request.method, request.params),
    );
    const effectiveRequest = params === request.params ? request : { ...request, params };
    this.rememberPromptHistoryEligibleThreadFromRequest(effectiveRequest.method, params || {});
    persistSelectedPermissionModeForParams(request.method, params || {});
    if (request.method === "thread/list") {
      const fastResult = canonicalizeThreadListProjectCwds(await this.fastThreadListResponse(params));
      if (fastResult) {
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: fastResult },
        });
        return;
      }
    }
    if (request.method === "thread/read") {
      const completeResult = await this.completeThreadReadResponse(params);
      if (completeResult) {
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: completeResult },
        });
        return;
      }
    }
    if (request.method === "thread/resume") {
      const resumeResult = largeThreadResumeFastPathResponse(params);
      if (resumeResult) {
        const threadId = params?.threadId || resumeResult.thread?.id;
        if (threadId && largeThreadPrewarmOnResumeEnabled) this.prewarmLargeThreadInAppServer(threadId, params || {});
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: resumeResult },
        });
        if (threadId) {
          this.sendToBrowser({
            type: "mcp-notification",
            hostId: "local",
            method: "thread/status/changed",
            params: { threadId, status: { type: "idle" } },
          });
        }
        return;
      }
    }
    if (request.method === "thread/status") {
      const statusResult = largeThreadStatusFastPathResponse(params);
      if (statusResult) {
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: statusResult },
        });
        return;
      }
    }
    if (request.method === "thread/settings/update") {
      const settingsResult = largeThreadSettingsUpdateFastPathResponse(params);
      if (settingsResult) {
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: settingsResult },
        });
        return;
      }
    }
    if (request.method === "thread/turns/list") {
      const completeResult = await this.completeThreadTurnsResponse(params);
      if (completeResult) {
        this.observeActiveTurnFromRequest(request.method, params || {}, completeResult);
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: completeResult },
        });
        return;
      }
      const cachedResult = getCachedThreadTurns(params);
      if (cachedResult) {
        this.observeActiveTurnFromRequest(request.method, params || {}, cachedResult);
        this.sendToBrowser({
          type: "mcp-response",
          hostId: "local",
          message: { id: request.id, result: cachedResult },
        });
        return;
      }
    }
    const turnSubmission = this.registerPendingTurnInputSubmission(request.method, params || {}, request.id);
    if (turnSubmission?.duplicate) {
      this.observeActiveTurnFromRequest(request.method, params || {}, null);
      return;
    }
    if (shouldInvalidateThreadTurns(request.method, params)) {
      invalidateThreadTurnsCache(params.threadId);
    }
    const hostResult = await this.handleCodexHostMethod(request.method, params || {});
    if (hostResult !== HOST_METHOD_NOT_HANDLED) {
      this.sendToBrowser({
        type: "mcp-response",
        hostId: "local",
        message: { id: request.id, result: hostResult },
      });
      debugLog("host request success", request.method, request.id);
      return;
    }
    await this.preflightAccountSwitchForRequest(effectiveRequest);
    if ((request.method === "turn/start" || request.method === "turn/steer")
      && typeof params?.threadId === "string"
      && largeThreadFastPathInfo(params.threadId)) {
      const resumeState = await this.waitForLargeThreadSubmitResume(params.threadId, params || {});
      if (!resumeState.ready) {
        this.deferLargeThreadTurnRequest({ ...request, params }, params || {}, resumeState);
        return;
      }
    }
    await this.sendMcpRequestToAppServer(request, params || {});
  }

  async fastThreadListResponse(params = {}) {
    if (!fastThreadListEnabled) return null;
    try {
      let loadedThreadIds = new Set();
      try {
        const loaded = await this.appRequest("thread/loaded/list", {}, { timeoutMs: threadLoadedListTimeoutMs, internal: true });
        if (Array.isArray(loaded?.data)) loadedThreadIds = new Set(loaded.data);
      } catch (error) {
        debugLog("fast thread list loaded-state fallback", error.message || String(error));
      }
      const result = fastThreadListFromDb(params, loadedThreadIds);
      if (result) this.prewarmThreadTurns(result.data);
      return result;
    } catch (error) {
      log("fast thread list failed; falling back to app-server", error.stack || error.message);
      return null;
    }
  }

  prewarmThreadTurns(threads = []) {
    if (!threadTurnsCacheEnabled || threadTurnsPrewarmCount <= 0 || !Array.isArray(threads)) return;
    const candidates = threads
      .filter((thread) => thread?.id)
      .filter((thread) => !largeThreadFastPathInfo(thread.id))
      .slice(0, threadTurnsPrewarmCount);
    if (candidates.length === 0) return;
    const timer = setTimeout(() => {
      this.runThreadTurnsPrewarm(candidates);
    }, 0);
    timer.unref?.();
  }

  runThreadTurnsPrewarm(candidates = []) {
    for (const thread of candidates) {
      const params = { threadId: thread.id, cursor: null, limit: 5 };
      const info = threadTurnsCacheInfo(params);
      if (!info || threadTurnsCache.has(info.key) || threadTurnsInflightPrewarm.has(info.key)) continue;
      const promise = this.completeThreadTurnsResponse(params, { fromPrewarm: true })
        .catch((error) => debugLog("thread turns prewarm failed", thread.id, error.message || String(error)))
        .finally(() => threadTurnsInflightPrewarm.delete(info.key));
      threadTurnsInflightPrewarm.set(info.key, promise);
    }
  }

  async loadedThreadIds() {
    try {
      const result = await this.appRequest("thread/loaded/list", {}, { timeoutMs: 5000, internal: true });
      return new Set(Array.isArray(result?.data) ? result.data.filter((id) => typeof id === "string") : []);
    } catch (error) {
      debugLog("loaded thread list unavailable", error.message || String(error));
      return new Set();
    }
  }

  async completeThreadReadResponse(params = {}) {
    if (!params || typeof params.threadId !== "string" || params.threadId.length === 0) return null;
    const largeFastPathResult = largeThreadReadFastPathResponse(params);
    if (largeFastPathResult) return largeFastPathResult;
    try {
      const readResult = await this.appRequest("thread/read", params, {
        timeoutMs: 60000,
        internal: true,
      });
      const canonicalResult = canonicalizeThreadReadResult(readResult);
      const thread = canonicalResult?.thread;
      const threadId = typeof thread?.id === "string"
        ? thread.id
        : (typeof thread?.sessionId === "string" ? thread.sessionId : params.threadId);
      if (!thread || typeof threadId !== "string" || threadId.length === 0) return canonicalResult;
      if (thread.ephemeral === true) {
        const turns = Array.isArray(thread.turns)
          ? normalizeThreadTurnsResult({ data: thread.turns }, { threadId }).data
          : null;
        this.rememberEphemeralThread(threadId, "thread/read", turns);
        return turns ? { ...canonicalResult, thread: { ...thread, turns } } : canonicalResult;
      }

      const turnsResult = await this.completeThreadTurnsResponse({
        threadId,
        cursor: null,
        limit: threadReadInitialTurnsLimit(params),
        ...(params.itemsView !== undefined ? { itemsView: params.itemsView } : {}),
        ...(params.sortDirection !== undefined ? { sortDirection: params.sortDirection } : {}),
      });
      if (!turnsResult || !Array.isArray(turnsResult.data)) return canonicalResult;
      const windowTurns = chronologicalTurnsFromTurnsPage(turnsResult);
      return {
        ...canonicalResult,
        thread: {
          ...thread,
          turns: windowTurns,
          turnsPagination: turnsPaginationFromTurnsPage(turnsResult, windowTurns),
        },
        initialTurnsPage: initialTurnsPageFromTurnsResult(turnsResult),
      };
    } catch (error) {
      log("complete thread read failed; falling back to app-server", params.threadId, error.message || String(error));
      return null;
    }
  }

  async completeThreadTurnsResponse(params = {}, options = {}) {
    if (!completeThreadTurnsEnabled) return null;
    if (!params || typeof params.threadId !== "string" || params.threadId.length === 0) return null;
    const largeFastPathResult = largeThreadTurnsFastPathResponse(params);
    if (largeFastPathResult) return largeFastPathResult;
    if (this.isKnownEphemeralThread(params.threadId)) return this.ephemeralThreadTurnsResponse(params.threadId);
    if (params.cursor != null) return null;

    const cachedResult = getCachedThreadTurns(params);
    if (cachedResult) return cachedResult;
    const info = threadTurnsCacheInfo(params);
    const inflight = info ? threadTurnsInflightPrewarm.get(info.key) : null;
    if (!options.fromPrewarm && inflight) {
      const inflightResult = await inflight.catch(() => null);
      if (inflightResult) return inflightResult;
      const cachedAfterInflight = getCachedThreadTurns(params);
      if (cachedAfterInflight) return cachedAfterInflight;
    }

    try {
      const requestedLimit = boundedTurnPageLimit(params.limit, threadTurnsWindowDefaultLimit);
      const firstParams = {
        ...params,
        cursor: null,
        limit: requestedLimit,
      };
      const firstResult = await this.appRequest("thread/turns/list", firstParams, {
        timeoutMs: 60000,
        internal: true,
      });
      if (!firstResult || !Array.isArray(firstResult.data)) return null;

      const completeResult = normalizeThreadTurnsResult({
        ...firstResult,
        data: firstResult.data,
        nextCursor: firstResult.nextCursor ?? null,
      }, {
        preserveLatestInProgress: true,
        threadId: params.threadId,
      });
      setCachedThreadTurns(params, completeResult);
      return completeResult;
    } catch (error) {
      if (looksLikeEphemeralThreadTurnsUnsupported(error)) {
        if (this.rememberEphemeralThread(params.threadId, "thread/turns/list-error")) {
          return this.ephemeralThreadTurnsResponse(params.threadId);
        }
        return null;
      }
      log("complete thread turns failed; falling back to app-server", params.threadId, error.message || String(error));
      return null;
    }
  }

  async forwardClientNotification(message) {
    const request = message.request;
    if (!request || !request.method) return;
    const params = forceLocalManagedWorkspacePermissions(request.method, request.params);
    persistSelectedPermissionModeForParams(request.method, params || {});
    await this.appSend({
      jsonrpc: "2.0",
      method: request.method,
      params,
    });
  }

  async forwardClientResponse(message) {
    const response = message.response;
    if (!response || response.id === undefined) return;
    await this.appSend({
      jsonrpc: "2.0",
      id: response.id,
      ...("error" in response ? { error: response.error } : { result: response.result }),
    });
  }

  cancelFetch(requestId) {
    const controller = this.abortControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(requestId);
    }
  }

  async handleCodexHostMethod(method, params = {}) {
    switch (method) {
      case "list-collaboration-modes":
        return this.appRequest("collaborationMode/list", {}, { timeoutMs: 30000 });
      case "update-thread-settings-for-next-turn": {
        const threadId = typeof params.conversationId === "string" ? params.conversationId : params.threadId;
        const threadSettings = selectedLocalFullAccessEnabled()
          ? fullAccessThreadSettings(params.threadSettings)
          : (isPlainObject(params.threadSettings) ? params.threadSettings : {});
        if (typeof threadId !== "string" || threadId.length === 0) {
          return { success: false };
        }
        if (selectedLocalFullAccessEnabled()) persistFullAccessThreadPolicy(threadId, "update-thread-settings-for-next-turn");
        const result = await this.appRequest("thread/settings/update", { threadId, threadSettings }, { timeoutMs: 30000 });
        return result ?? { success: true };
      }
      case "get-settings":
        return { values: readHostSettings() };
      case "get-setting":
        return { value: readHostSetting(params.key) };
      case "set-setting":
        return writeHostSetting(params.key, params.value);
      case "settings-read":
        return { settings: readHostSettings() };
      case "settings-write": {
        const settings = isPlainObject(params.settings) ? params.settings : {};
        writeHostState("settings", { ...readHostSettings(), ...settings });
        return { settings: readHostSettings() };
      }
      case "app-server-connection-state":
        return appServerConnectionState(params);
      case "open-in-targets":
        return openInTargetsResponse(params);
      case "account-info": {
        const account = await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000 });
        const chatgptAccount = account?.account?.type === "chatgpt" ? account.account : null;
        return {
          accountId: null,
          userId: null,
          plan: chatgptAccount?.planType ?? null,
          email: chatgptAccount?.email ?? null,
        };
      }
      case "get-auth-status": {
        return this.appRequest("getAuthStatus", {}, { timeoutMs: 30000 });
      }
      case "locale-info": {
        const locale = readHostState("localeOverride") || Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
        return {
          ideLocale: locale,
          systemLocale: locale,
        };
      }
      case "get-global-state":
        if (params.key === "local_app_server_feature_enablement" || params.key === "remote_control_connections_state") {
          await this.refreshRemoteControlSharedObjects();
        }
        return { value: readHostState(params.key) };
      case "set-global-state":
        writeHostState(params.key, params.value);
        broadcastBridgeMessage({ type: "global-state-updated", keys: [params.key] });
        return { success: true };
      case "get-configuration":
        return { value: readHostState(params.key) };
      case "set-configuration":
        writeHostState(params.key, params.value);
        return { success: true };
      case "active-workspace-roots":
        return { roots: uniqueStrings(readHostState("active-workspace-roots")) };
      case "workspace-root-options":
        return {
          roots: uniqueStrings(readHostState("electron-saved-workspace-roots")),
          labels: readHostState("electron-workspace-root-labels") || {},
        };
      case "pick-files":
        return { files: [] };
      case "add-workspace-root-option": {
        const root = typeof params.root === "string" ? params.root : null;
        if (root) {
          registerWorkspaceRoot(root, {
            label: params.label,
            setActive: params.setActive === true,
            picked: params.picked === true,
            create: params.create !== false,
          });
        }
        return { success: true };
      }
      case "create-workspace-root-option": {
        const created = createManagedWorkspaceRoot(params);
        return registerWorkspaceRoot(created.root, {
          label: created.label,
          setActive: params.setActive !== false,
          picked: params.picked === true,
        });
      }
      case "rename-workspace-root-option":
        return renameWorkspaceRootOption(params.root, params.label);
      case "update-workspace-root-options":
        return updateWorkspaceRootOptions(params.roots, params.labels);
      case "remove-workspace-root-option": {
        const root = typeof params.root === "string" ? params.root : null;
        if (root) {
          const normalized = path.resolve(root);
          writeHostState("electron-saved-workspace-roots", uniqueStrings(readHostState("electron-saved-workspace-roots")).filter((item) => path.resolve(item) !== normalized));
          const labels = { ...(readHostState("electron-workspace-root-labels") || {}) };
          delete labels[normalized];
          writeHostState("electron-workspace-root-labels", labels);
          writeHostState("active-workspace-roots", uniqueStrings(readHostState("active-workspace-roots")).filter((item) => path.resolve(item) !== normalized));
          broadcastBridgeMessage({ type: "workspace-root-options-updated" });
          broadcastBridgeMessage({ type: "active-workspace-roots-updated" });
        }
        return { success: true };
      }
      case "add-project-writable-root":
        return addProjectWritableRoot(params);
      case "clear-project-writable-roots":
        return clearProjectWritableRoots(params);
      case "upload-browser-files":
        return writeBrowserUploadedFiles(params);
      case "codex-home":
        return {
          codexHome,
          worktreesSegment: path.join(codexHome, "worktrees"),
        };
      case "home-directory":
        return { homeDirectory: home };
      case "projectless-thread-cwd":
        return createProjectlessWorkspace(params);
      case "projectless-workspace-root":
        return { workspaceRoot: projectlessWorkspaceRoot() };
      case "ide-context":
        return { ideContext: null };
      case "read-file-metadata":
        return fileMetadataFor(params.path);
      case "read-file-binary":
        return fileBinaryFor(params.path);
      case "read-file":
        return fileTextFor(params.path);
      case "git-origins": {
        const dirs = Array.isArray(params.dirs) ? params.dirs : uniqueStrings(readHostState("active-workspace-roots"));
        return { origins: dirs.map(gitOriginForDir) };
      }
      case "generate-thread-title":
        return { title: generateThreadTitle(params.prompt) };
      case "thread-terminal-snapshot":
        return terminalSnapshotForThread(params.threadId);
      case "paths-exist":
        return { existingPaths: existingPaths(params.paths) };
      case "mcp-codex-config":
        return { config: {} };
      case "worktree-shell-environment-config":
        return { shellEnvironment: null };
      case "developer-instructions":
        return { instructions: typeof params.baseInstructions === "string" ? params.baseInstructions : "" };
      case "fast-mode-rollout-metrics":
        return { metrics: null };
      case "list-automations":
        return { items: [] };
      case "list-pending-automation-run-threads":
        return { threadIds: [] };
      case "inbox-items":
        return { items: [], unreadRunCounts: { total: 0 } };
      case "codex-command-keymap-state":
        return readCodexCommandKeymapState();
      case "set-codex-command-keybinding":
        return writeCodexCommandKeybinding(params);
      case "hotkey-window-hotkey-state":
        return { supported: false };
      case "hotkey-window-set-hotkey":
        return { success: false, error: "Global hotkeys are not available in the web deployment.", state: { supported: false } };
      case "global-dictation-hotkey-state":
        return { supported: false };
      case "ambient-suggestions":
        return { suggestions: [], items: [] };
      case "ambient-suggestions-generation-statuses":
        return { statuses: [] };
      case "ambient-suggestions-refresh":
        return { success: true, suggestions: [] };
      case "recommended-skills":
        return { skills: [], error: null };
      case "external-agent-imported-connectors":
        return { connectors: [] };
      case "list-pinned-threads":
        return { threadIds: uniqueStrings(readHostState("pinned-thread-ids")) };
      case "set-thread-pinned": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        if (threadId) {
          const current = uniqueStrings(readHostState("pinned-thread-ids")).filter((item) => item !== threadId);
          writeHostState("pinned-thread-ids", params.pinned ? [threadId, ...current] : current);
          broadcastBridgeMessage({ type: "pinned-threads-updated" });
        }
        return { success: true };
      }
      case "set-pinned-threads-order":
        writeHostState("pinned-thread-ids", uniqueStrings(params.threadIds));
        broadcastBridgeMessage({ type: "pinned-threads-updated" });
        return { success: true };
      case "set-local-app-server-feature-enablement": {
        const featureName = typeof params.featureName === "string" ? params.featureName : null;
        const enabled = Boolean(params.enabled);
        if (featureName === "remote_control") {
          return this.setRemoteControlEnabled(enabled, params);
        }
        const featureEnablement = {
          ...(readHostState("local_app_server_feature_enablement") || {}),
          ...(featureName ? { [featureName]: enabled } : {}),
        };
        writeHostState("local_app_server_feature_enablement", featureEnablement);
        broadcastBridgeMessage({ type: "global-state-updated", keys: ["local_app_server_feature_enablement"] });
        broadcastBridgeMessage({
          type: "shared-object-updated",
          key: "local_app_server_feature_enablement",
          value: featureEnablement,
        });
        return { success: true, enabled };
      }
      case "set-local-remote-control-enabled": {
        const enabled = Boolean(params.enabled ?? params.value);
        return this.setRemoteControlEnabled(enabled, params);
      }
      case "set-remote-control-connections-enabled": {
        const enabled = Boolean(params.enabled ?? params.value ?? params.remoteControl ?? params.remote_control);
        return this.setRemoteControlEnabled(enabled, params);
      }
      case "authorize-remote-control-connections": {
        return this.setRemoteControlEnabled(true);
      }
      case "refresh-remote-connections": {
        const remoteConnections = readRemoteSshConnections();
        broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_connections", value: remoteConnections });
        return { success: true, remoteConnections };
      }
      case "discover-remote-ssh-connections":
        return { success: true, discoveredRemoteConnections: [] };
      case "save-codex-managed-remote-ssh-connections": {
        const remoteConnections = normalizeRemoteSshConnections(params.remoteConnections);
        writeHostState("remote_connections", remoteConnections);
        broadcastBridgeMessage({ type: "global-state-updated", keys: ["remote_connections"] });
        broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_connections", value: remoteConnections });
        return { success: true, remoteConnections };
      }
      case "install-remote-codex":
        return {
          success: false,
          state: "error",
          error: {
            code: "unsupported-in-web-deployment",
            message: "Installing Codex over SSH is not available in this web deployment.",
          },
        };
      case "refresh-remote-control-connections": {
        const { status, state, connections } = await this.refreshRemoteControlSharedObjects();
        return {
          success: true,
          status,
          remoteControlConnectionsState: state,
          remoteControlConnections: connections,
          connections,
          items: connections,
        };
      }
      case "rename-remote-control-environment": {
        const envId = typeof params.envId === "string" ? params.envId : null;
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!envId || !name) return { success: false };
        const connections = (readHostState("remote_control_connections") || []).map((connection) => (
          connection?.envId === envId || connection?.hostId === envId
            ? { ...connection, displayName: name, hostName: name }
            : connection
        ));
        writeHostState("remote_control_connections", connections);
        broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections", value: connections });
        return { success: true, remoteControlConnections: connections, connections };
      }
      case "delete-remote-control-environment": {
        const envId = typeof params.envId === "string" ? params.envId : null;
        if (!envId) return { success: false };
        const current = readHostState("remote_control_connections") || [];
        const target = current.find((connection) => connection?.envId === envId || connection?.hostId === envId);
        if (target?.online) {
          throw new Error("Online remote control environments cannot be deleted");
        }
        const connections = current.filter((connection) => connection?.envId !== envId && connection?.hostId !== envId);
        writeHostState("remote_control_connections", connections);
        writeHostState("added-remote-control-env-ids", uniqueStrings(readHostState("added-remote-control-env-ids")).filter((item) => item !== envId));
        broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections", value: connections });
        broadcastBridgeMessage({ type: "global-state-updated", keys: ["added-remote-control-env-ids"] });
        return { success: true, remoteControlConnections: connections, connections };
      }
      case "set-remote-connection-auto-connect": {
        const hostId = typeof params.hostId === "string" ? params.hostId : null;
        const autoConnect = Boolean(params.autoConnect);
        if (!hostId) return { success: false, remoteConnections: readHostState("remote_control_connections") || [] };
        const autoConnectByHostId = {
          ...(readHostState("remote-connection-auto-connect-by-host-id") || {}),
          [hostId]: autoConnect,
        };
        writeHostState("remote-connection-auto-connect-by-host-id", autoConnectByHostId);
        const remoteControlConnections = (readHostState("remote_control_connections") || []).map((connection) => (
          connection?.hostId === hostId ? { ...connection, autoConnect } : connection
        ));
        writeHostState("remote_control_connections", remoteControlConnections);
        broadcastBridgeMessage({ type: "shared-object-updated", key: "remote_control_connections", value: remoteControlConnections });
        broadcastBridgeMessage({ type: "global-state-updated", keys: ["remote-connection-auto-connect-by-host-id"] });
        return {
          success: true,
          remoteConnections: [
            ...(readHostState("remote_connections") || []),
            ...remoteControlConnections,
          ],
          state: autoConnect ? "connected" : "disconnected",
          error: null,
        };
      }
      case "has-custom-cli-executable":
        return { hasCustomCliExecutable: false };
      case "is-copilot-api-available":
        return { available: false };
      case "get-copilot-api-proxy-info":
        return null;
      case "extension-info":
        return {
          version: codexUiVersion,
          buildNumber: null,
          buildFlavor: "prod",
          osName: "Linux",
          systemVersion: os.release(),
          appName: "Codex",
          appIconMedium: null,
        };
      case "third-party-notices":
        return { text: null };
      case "locale-info":
        return { ideLocale: "en-US", systemLocale: Intl.DateTimeFormat().resolvedOptions().locale || "en-US" };
      case "os-info":
        return {
          platform: process.platform,
          osVersion: os.version?.() || os.release(),
          osRelease: os.release(),
          hasWsl: false,
          isVsCodeRunningInsideWsl: false,
        };
      case "wsl-bash-availability":
        return { available: false };
      case "chronicle-permissions":
        return {
          accessibility: "not-determined",
          screenRecording: "not-determined",
          chronicleSidecarPresent: false,
          chronicleSidecarProcessState: "disabled",
        };
      case "computer-use-app-approvals-visibility":
        return { hasApprovalStore: false };
      case "computer-use-app-approvals-read":
        return { approvals: [] };
      case "computer-use-sound-mode-read":
        return { value: "off" };
      case "computer-use-background-auth-read":
        return { enabled: false };
      case "browser-browsing-data-clear":
        return { success: true };
      case "email-domain-mail-provider":
        return { provider: null };
      default:
        return HOST_METHOD_NOT_HANDLED;
    }
  }

  async handleLocalHttpFetch(message) {
    const url = String(message.url || "");
    if (url.startsWith("/wham/accounts/check")) {
      let email = null;
      let plan = null;
      try {
        const account = await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000 });
        const chatgptAccount = account?.account?.type === "chatgpt" ? account.account : null;
        email = chatgptAccount?.email ?? null;
        plan = chatgptAccount?.planType ?? null;
      } catch {}
      const accountId = "local";
      return {
        account_ordering: [accountId],
        accounts: [{
          id: accountId,
          email,
          plan_type: plan,
          profile_picture_url: null,
        }],
      };
    }
    if (url.startsWith("/accounts/check/")) {
      const accountId = "local";
      return {
        account_ordering: [accountId],
        accounts: {
          [accountId]: {
            id: accountId,
            entitlement: {
              billing_currency: "USD",
            },
          },
        },
      };
    }
    if (url.startsWith("/checkout_pricing_config/configs/")) {
      return {
        currency_config: {
          symbol_code: "USD",
          minor_unit_exponent: 2,
          amount_per_credit: 0.01,
          free: { month: { amount: 0 } },
          go: { month: { amount: null } },
          plus: { month: { amount: 20 } },
          prolite: { month: { amount: 100 } },
          pro: { month: { amount: 200 } },
          business: { year: { amount: null } },
        },
      };
    }
    if (url.startsWith("/subscriptions/auto_top_up/settings")) {
      return {
        is_enabled: false,
        recharge_threshold: null,
        recharge_target: null,
        recharge_monthly_limit: null,
      };
    }
    if (url.startsWith("/subscriptions/auto_top_up/enable") || url.startsWith("/subscriptions/auto_top_up/update")) {
      let body = {};
      try {
        body = message.body ? JSON.parse(message.body) : {};
      } catch {}
      return {
        is_enabled: true,
        recharge_threshold: body.recharge_threshold ?? null,
        recharge_target: body.recharge_target ?? null,
        recharge_monthly_limit: body.recharge_monthly_limit ?? null,
        immediate_top_up_status: "not_required",
      };
    }
    if (url.startsWith("/subscriptions/auto_top_up/disable")) {
      return {
        is_enabled: false,
        recharge_threshold: null,
        recharge_target: null,
        recharge_monthly_limit: null,
        immediate_top_up_status: "not_required",
      };
    }
    if (url.startsWith("/accounts/send_add_credits_nudge_email")) {
      return { ok: true };
    }
    if (url.startsWith("/accounts/mfa_info")) {
      return { mfa_enabled_v2: true };
    }
    if (url.startsWith("/wham/remote/control/mfa_requirement")) {
      return await this.chatGptBackendJson(url, message, { requirement: "not_required" });
    }
    if (url.startsWith("/wham/remote/control/clients")) {
      const method = String(message.method || "GET").toUpperCase();
      if (method === "GET") {
        try {
          const result = normalizeRemoteControlClientsResponse(await this.chatGptBackendJson(url, message));
          const completed = writeCodexMobileCompletedFromClients(result);
          log("remote-control clients loaded", {
            count: Array.isArray(result?.items) ? result.items.length : 0,
            completed,
          });
          return result;
        } catch (error) {
          log("remote-control clients load failed", error.message || String(error));
          return { items: [], cursor: null };
        }
      }
      const fallback = method === "DELETE" ? { success: true } : { items: [], cursor: null };
      return await this.chatGptBackendJson(url, message, fallback);
    }
    if (url.startsWith("/wham/tasks/list")) {
      return { items: [], cursor: null };
    }
    if (url.startsWith("/wham/tasks/")) {
      return { items: [], turns: [], task: null };
    }
    if (url.startsWith("/wham/usage")) {
      try {
        const usage = await this.appRequest("account/rateLimits/read", {}, { timeoutMs: 30000 });
        return whamUsageResponse(usage);
      } catch (error) {
        log("failed to read usage limits", error.message || String(error));
        return null;
      }
    }
    if (url.startsWith("/beacons/")) {
      return { ok: true };
    }
    return HOST_METHOD_NOT_HANDLED;
  }

  async handleFetch(message) {
    const controller = new AbortController();
    this.abortControllers.set(message.requestId, controller);
    try {
      if (String(message.url || "").startsWith("vscode://codex/")) {
        const method = message.url.slice("vscode://codex/".length);
        let params = forceLocalManagedWorkspacePermissions(
          method,
          message.body ? JSON.parse(message.body) : undefined,
        );
        const hostResult = await this.handleCodexHostMethod(method, params);
        if (hostResult !== HOST_METHOD_NOT_HANDLED) {
          this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, hostResult ?? null);
          debugLog("host fetch success", method, message.requestId);
          return;
        }
        debugLog("fetch to app-server", method, message.requestId);
        params = await this.withLatestExpectedTurnId(
          method,
          forceLocalManagedWorkspacePermissions(method, params),
        );
        this.rememberPromptHistoryEligibleThreadFromRequest(method, params || {});
        persistSelectedPermissionModeForParams(method, params || {});
        let result = null;
        if (method === "thread/read") {
          result = await this.completeThreadReadResponse(params);
        } else if (method === "thread/turns/list") {
          result = await this.completeThreadTurnsResponse(params);
        } else if (method === "thread/resume") {
          result = largeThreadResumeFastPathResponse(params);
        } else if (method === "thread/status") {
          result = largeThreadStatusFastPathResponse(params);
        } else if (method === "thread/settings/update") {
          result = largeThreadSettingsUpdateFastPathResponse(params);
        }
        if (!result) {
          result = await this.appRequest(method, params, {
            id: `fetch-${message.requestId}`,
            timeoutMs: 120000,
          });
        }
        if (method === "thread/read") {
          result = canonicalizeThreadReadResult(result);
        } else if (method === "thread/turns/list") {
          result = normalizeThreadTurnsResult(result, { threadId: params?.threadId || null });
          setCachedThreadTurns(params, result);
        }
        this.observeActiveTurnFromRequest(method, params || {}, result);
        this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, result ?? null);
        debugLog("fetch success", method, message.requestId);
        return;
      }

      const localHttpResult = await this.handleLocalHttpFetch(message);
      if (localHttpResult !== HOST_METHOD_NOT_HANDLED) {
        this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, localHttpResult ?? null);
        debugLog("local http fetch success", message.url, message.requestId);
        return;
      }

      const response = await fetch(message.url, {
        method: message.method || "GET",
        headers: message.headers || {},
        body: message.body || undefined,
        signal: controller.signal,
      });
      await this.sendHttpFetchResponse(message.requestId, response);
    } catch (error) {
      if (looksLikeSwitchableAccountFailure(error)) {
        void requestAccountSwitch("fetch-quota-error", { error, method: message.url || null });
      }
      this.sendFetchError(
        message.requestId,
        error.name === "AbortError" ? 499 : 500,
        error.message || "Fetch failed"
      );
    } finally {
      this.abortControllers.delete(message.requestId);
    }
  }

  async sendHttpFetchResponse(requestId, response) {
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    if (!response.ok) {
      const errorText = await response.text() || response.statusText;
      if (looksLikeSwitchableAccountFailure(errorText)) {
        void requestAccountSwitch("http-fetch-quota-error", { error: errorText });
      }
      this.sendFetchError(requestId, response.status, errorText);
      return;
    }
    const contentType = response.headers.get("content-type") || "";
    if (response.status === 204) {
      this.sendFetchSuccess(requestId, response.status, headers, null);
    } else if (contentType.includes("application/json")) {
      this.sendFetchSuccess(requestId, response.status, headers, await response.json());
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      this.sendFetchSuccess(requestId, response.status, headers, {
        base64: buffer.toString("base64"),
        contentType,
      });
    }
  }

  sendFetchSuccess(requestId, status, headers, body) {
    const sanitizedBody = sanitizeGeneratedImagesForWeb(body);
    this.sendToBrowser({
      type: "fetch-response",
      responseType: "success",
      requestId,
      status,
      headers,
      bodyJsonString: JSON.stringify(sanitizedBody),
    });
  }

  sendFetchError(requestId, status, error) {
    this.sendToBrowser({
      type: "fetch-response",
      responseType: "error",
      requestId,
      status,
      error,
    });
  }

  async handleFetchStream(message) {
    const controller = new AbortController();
    this.abortControllers.set(message.requestId, controller);
    try {
      const response = await fetch(message.url, {
        method: message.method || "GET",
        headers: message.headers || {},
        body: message.body || undefined,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const errorText = await response.text() || response.statusText;
        if (looksLikeSwitchableAccountFailure(errorText)) {
          void requestAccountSwitch("fetch-stream-quota-error", { error: errorText });
        }
        this.sendToBrowser({
          type: "fetch-stream-error",
          requestId: message.requestId,
          status: response.status,
          error: errorText,
        });
        return;
      }
      await this.pipeServerSentEvents(message.requestId, response.body, controller.signal);
      this.sendToBrowser({ type: "fetch-stream-complete", requestId: message.requestId });
    } catch (error) {
      if (looksLikeSwitchableAccountFailure(error)) {
        void requestAccountSwitch("fetch-stream-quota-exception", { error, method: message.url || null });
      }
      this.sendToBrowser({
        type: "fetch-stream-error",
        requestId: message.requestId,
        status: error.name === "AbortError" ? 499 : 500,
        error: error.message || "Fetch stream failed",
      });
    } finally {
      this.abortControllers.delete(message.requestId);
    }
  }

  async pipeServerSentEvents(requestId, body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(raw.includes("\r\n\r\n") ? boundary + 4 : boundary + 2);
          const event = this.parseSseEvent(raw);
          if (event && event.event !== "heartbeat") {
            this.sendToBrowser({ type: "fetch-stream-event", requestId, ...event });
          }
        }
      }
      if (!signal.aborted && buffer.trim().length > 0) {
        const event = this.parseSseEvent(buffer);
        if (event && event.event !== "heartbeat") {
          this.sendToBrowser({ type: "fetch-stream-event", requestId, ...event });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  parseSseEvent(raw) {
    const data = [];
    let event = undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return null;
    try {
      return { event, data: JSON.parse(data.join("\n")) };
    } catch {
      return null;
    }
  }
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      send(res, 200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=3600" });
      return;
    }
    if (url.pathname === "/auth/device/start" && req.method === "POST") {
      startDeviceAuthSession()
        .then((result) => send(res, 200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        }, JSON.stringify(result)))
        .catch((error) => send(res, 500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        }, JSON.stringify({ state: "failed", error: error.message || String(error) })));
      return;
    }
    if (url.pathname === "/auth/device/status" && req.method === "GET") {
      send(res, 200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      }, JSON.stringify(publicDeviceAuthSession()));
      return;
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      try {
        execFileSync("codex", ["logout"], {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        });
        if (deviceAuthSession?.process && deviceAuthSession.state === "pending") {
          try { deviceAuthSession.process.kill("SIGTERM"); } catch {}
        }
        deviceAuthSession = null;
        send(res, 200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        }, JSON.stringify({ ok: true, loginStatus: codexLoginStatus() }));
      } catch (error) {
        send(res, 500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        }, JSON.stringify({ ok: false, error: error.message || String(error) }));
      }
      return;
    }
    if (url.pathname === bridgeScriptPath) {
      sendStaticBody(req, res, 200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      }, browserBridgeScript(), `bridge:${bridgeScriptVersion}:${assetPatchVersion}`);
      return;
    }
    if (url.pathname === "/codexapp-thread-fast") {
      const threadId = url.searchParams.get("threadId") || "";
      const result = largeThreadReadFastPathResponse({ threadId });
      if (!result) {
        send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "thread fast path unavailable" }));
        return;
      }
      sendStaticBody(req, res, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }, JSON.stringify(result));
      return;
    }
    if (url.pathname === "/codexapp-thread-turns") {
      const threadId = url.searchParams.get("threadId") || "";
      const cursor = url.searchParams.get("cursor") || null;
      const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
      const result = largeThreadTurnsFastPathResponse({
        threadId,
        cursor,
        limit: Number.isFinite(limit) && limit > 0 ? limit : historyWindowMaxTurns,
      });
      if (!result) {
        send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "thread turns fast path unavailable" }));
        return;
      }
      sendStaticBody(req, res, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }, JSON.stringify(result));
      return;
    }
    if (url.pathname === "/codexapp-thread-status") {
      const threadId = url.searchParams.get("threadId") || "";
      const result = largeThreadStatusFastPathResponse({ threadId });
      if (!result) {
        send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ error: "thread status unavailable" }));
        return;
      }
      sendStaticBody(req, res, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }, JSON.stringify(result));
      return;
    }
    const filePath = safeJoin(webviewDir, url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      if (shouldServeSpaFallback(req, url.pathname)) {
        sendIndexHtml(req, res, url.pathname);
        return;
      }
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream",
      "Cache-Control": assetCacheControl(filePath, ext, url),
    };
    if (path.basename(filePath) === "index.html") {
      sendStaticBody(req, res, 200, headers, injectBridge(fs.readFileSync(filePath, "utf8")), `index:${assetPatchVersion}:root`);
      return;
    }
    if (ext === ".js" && shouldPatchJavaScript(filePath)) {
      sendStaticBody(req, res, 200, {
        ...headers,
      }, cachedPatchedJavaScript(filePath), staticFileCompressionCacheKey(filePath, url));
      return;
    }
    sendStaticFile(req, res, filePath, headers, url);
  } catch (error) {
    send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, error.stack || error.message);
  }
});

const wss = new WebSocketServer({ noServer: true });
const bridgeHeartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      debugLog("browser websocket heartbeat timed out");
      try { socket.terminate(); } catch {}
      continue;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch { try { socket.terminate(); } catch {} }
  }
  for (const session of bridgeSessions) {
    session.sendBrowserHeartbeat();
  }
}, bridgeHeartbeatIntervalMs);
bridgeHeartbeatTimer.unref?.();

wss.on("connection", (socket, req) => {
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const clientId = sanitizeBridgeClientId(url.searchParams.get("clientId"));
  const browserAckSequence = Number(url.searchParams.get("ack"));
  const browserBridgeVersion = String(url.searchParams.get("version") || "");
  socket.codexappBridgeVersion = browserBridgeVersion;
  const existing = bridgeSessionsByClientId.get(clientId);
  if (existing && !existing.closed) {
    debugLog("browser websocket reattached", clientId);
    existing.acknowledgeBrowserSequence(browserAckSequence);
    existing.attachBrowserSocket(socket);
    return;
  }
  debugLog("browser websocket connected", clientId);
  new BridgeSession(socket, clientId);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== bridgePath) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(port, host, () => {
  log(`${appDisplayName} web bridge listening on http://${host}:${port}`);
  setTimeout(prewarmPatchedJavaScriptCache, 0).unref?.();
  void (async () => {
    try {
      ensureManagedPersistedPermissionState("web-startup");
      if (!externalAppServer) await appServerProcess.stop("service startup cleanup");
      await prewarmAppServerCaches();
      log("codex app-server prewarmed");
      if (readRemoteControlDesiredEnabled() === true) {
        await remoteControlKeeper.enable();
        log("remote-control keeper enabled");
      }
    } catch (error) {
      log("startup app-server prewarm failed", error.stack || error.message);
    }
  })();
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log("shutting down codex app web gateway", { signal });
  clearInterval(bridgeHeartbeatTimer);
  remoteControlKeeper.stopKeepalive();
  for (const socket of wss.clients) {
    try { socket.close(); } catch {}
  }
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    delay(2000),
  ]);
  if (!externalAppServer) await appServerProcess.stop(`gateway ${signal}`);
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error) => {
    log("shutdown failed", error.stack || error.message);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").catch((error) => {
    log("shutdown failed", error.stack || error.message);
    process.exit(1);
  });
});
