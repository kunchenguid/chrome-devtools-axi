/**
 * Named sessions - per-session state, with optional pooled bridges.
 *
 * By default, setting `CHROME_DEVTOOLS_AXI_SESSION` to a non-default name binds
 * the bridge's port and on-disk state (PID file, snapshot-generation counter)
 * to that name, so multiple bridges can run concurrently - one per agent
 * session, worktree, or test worker - without sharing a single bridge or
 * stepping on each other's stale-ref tracking.
 *
 *   CHROME_DEVTOOLS_AXI_SESSION=worker-1 chrome-devtools-axi open ...
 *   CHROME_DEVTOOLS_AXI_SESSION=worker-2 chrome-devtools-axi open ...
 *
 * Setting `CHROME_DEVTOOLS_AXI_POOL_SIZE` changes only the bridge identity:
 * logical sessions keep their own state dirs and generation counters, but their
 * browser traffic hashes onto one of N pooled bridges. The bridge then routes
 * each logical session to a deterministic page within that browser.
 *
 * Precedence:
 *   logical state dir - always derived from CHROME_DEVTOOLS_AXI_SESSION
 *   bridge identity  - logical session by default, or pool slot when pooled
 *   bridge port      - CHROME_DEVTOOLS_AXI_PORT > deterministic bridge identity
 *
 * The default session name is "default", which preserves prior behavior: port
 * 9224 and the legacy `~/.chrome-devtools-axi/` state paths.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SESSION_NAME = "default";
export const DEFAULT_BASE_PORT = 9224;

const SESSION_PORT_RANGE = 1000; // 9225..10224 reserved for named sessions
const STATE_DIR_NAME = ".chrome-devtools-axi";
const POOL_SESSION_PREFIX = "pool-";

/** Root directory for all chrome-devtools-axi session state. */
export function resolveStateRoot(): string {
  return join(homedir(), STATE_DIR_NAME);
}

/** Directory containing per-name session state directories. */
export function resolveNamedSessionsDir(): string {
  return join(resolveStateRoot(), "sessions");
}

/**
 * Resolve the active session name from `CHROME_DEVTOOLS_AXI_SESSION`. Returns
 * DEFAULT_SESSION_NAME when unset, empty, or whitespace.
 *
 * A configured-but-unsafe name throws (via `validateSessionName`). This is the
 * single chokepoint through which every command obtains the active session, so
 * validating here guarantees that no entry point - `ensureBridge`, `stopBridge`,
 * `getSessionSnapshotIfRunning`, the generation counter, or the bridge itself -
 * can resolve an invalid name into a filesystem path that collapses onto the
 * default session's directory.
 */
export function resolveSessionName(): string {
  const raw = process.env.CHROME_DEVTOOLS_AXI_SESSION?.trim();
  const name = raw && raw.length > 0 ? raw : DEFAULT_SESSION_NAME;
  validateSessionName(name);
  return name;
}

/**
 * Throw if a non-default session name is unsafe for a filesystem path. Allows
 * 1-64 chars from `[A-Za-z0-9._-]`; rejects path traversal, separators, shell
 * metacharacters, overlong names, and names made only of dots (`.` / `..` /
 * `...`), which `resolveSessionStateDir` would otherwise collapse onto the
 * default session's directory.
 */
export function validateSessionName(name: string): void {
  if (name === DEFAULT_SESSION_NAME) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid CHROME_DEVTOOLS_AXI_SESSION "${name}": use 1-64 chars from [A-Za-z0-9._-]`,
    );
  }
  if (/^\.+$/.test(name)) {
    throw new Error(
      `Invalid CHROME_DEVTOOLS_AXI_SESSION "${name}": a name made only of dots would collapse onto the default session's state directory`,
    );
  }
}

function hashSessionName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/**
 * Deterministic port for a session name: an FNV-1a hash mapped into
 * [DEFAULT_BASE_PORT+1, DEFAULT_BASE_PORT+SESSION_PORT_RANGE]. The default
 * session keeps DEFAULT_BASE_PORT. Two distinct names can hash to the same
 * port - a concurrency limit, not a correctness bug; set
 * CHROME_DEVTOOLS_AXI_PORT to break a collision.
 */
export function defaultPortForSession(name: string): number {
  if (name === DEFAULT_SESSION_NAME) return DEFAULT_BASE_PORT;
  return DEFAULT_BASE_PORT + (hashSessionName(name) % SESSION_PORT_RANGE) + 1;
}

/**
 * Resolve the optional browser pool size. Unset, empty, and "0" preserve the
 * legacy one-bridge-per-session behavior. Positive integers opt into pooled
 * bridges; invalid values fail loudly before any browser starts.
 */
export function resolveBrowserPoolSize(
  value = process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE,
): number | null {
  if (value === undefined || value.trim() === "" || value.trim() === "0") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== value.trim() ||
    parsed < 1
  ) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_POOL_SIZE must be a positive integer, or 0/unset to disable pooling",
    );
  }
  return parsed;
}

export function poolSlotForSession(name: string, poolSize: number): number {
  return hashSessionName(name) % poolSize;
}

export function isPooledBridgeSessionName(name: string): boolean {
  return new RegExp(`^${POOL_SESSION_PREFIX}\\d+$`).test(name);
}

export function resolveBridgeSessionName(
  logicalSessionName: string = resolveSessionName(),
): string {
  const poolSize = resolveBrowserPoolSize();
  if (poolSize === null) return logicalSessionName;
  return `${POOL_SESSION_PREFIX}${poolSlotForSession(logicalSessionName, poolSize)}`;
}

export function isBrowserPoolEnabled(): boolean {
  return resolveBrowserPoolSize() !== null;
}

/**
 * Resolve the bridge port for a session: explicit `CHROME_DEVTOOLS_AXI_PORT`
 * wins, otherwise the session-derived default.
 */
export function resolveSessionPort(
  name: string = resolveSessionName(),
): number {
  const explicit = process.env.CHROME_DEVTOOLS_AXI_PORT;
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return defaultPortForSession(name);
}

export function resolveBridgePort(
  logicalSessionName: string = resolveSessionName(),
): number {
  const poolSize = resolveBrowserPoolSize();
  if (poolSize !== null) {
    const explicit = process.env.CHROME_DEVTOOLS_AXI_PORT;
    const slot = poolSlotForSession(logicalSessionName, poolSize);
    if (explicit) {
      const parsed = Number.parseInt(explicit, 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed + slot;
    }
  }
  const bridgeSessionName = resolveBridgeSessionName(logicalSessionName);
  return resolveSessionPort(bridgeSessionName);
}

/**
 * State directory for a session. The default session keeps the legacy
 * `~/.chrome-devtools-axi/` path so existing tools and older versions stay
 * compatible; named sessions live under a per-name subdirectory.
 */
export function resolveSessionStateDir(
  name: string = resolveSessionName(),
): string {
  const base = resolveStateRoot();
  return name === DEFAULT_SESSION_NAME ? base : join(base, "sessions", name);
}

export function resolveBridgeStateDir(
  logicalSessionName: string = resolveSessionName(),
): string {
  const bridgeSessionName = resolveBridgeSessionName(logicalSessionName);
  if (bridgeSessionName === logicalSessionName) {
    return resolveSessionStateDir(logicalSessionName);
  }
  return resolveBridgeStateDirForBridgeSession(bridgeSessionName, true);
}

export function resolveBridgeStateDirForBridgeSession(
  bridgeSessionName: string = resolveSessionName(),
  pooled: boolean = isBrowserPoolEnabled(),
): string {
  if (!pooled) return resolveSessionStateDir(bridgeSessionName);
  return join(homedir(), STATE_DIR_NAME, "pools", bridgeSessionName);
}

export function resolveBrowserPoolsDir(): string {
  return join(resolveStateRoot(), "pools");
}

/** PID file path for a session, under its state directory. */
export function resolveSessionPidFile(
  name: string = resolveSessionName(),
): string {
  return join(resolveSessionStateDir(name), "bridge.pid");
}

export function resolveBridgePidFile(
  logicalSessionName: string = resolveSessionName(),
): string {
  return join(resolveBridgeStateDir(logicalSessionName), "bridge.pid");
}

export function resolveBridgePidFileForBridgeSession(
  bridgeSessionName: string = resolveSessionName(),
): string {
  return join(
    resolveBridgeStateDirForBridgeSession(
      bridgeSessionName,
      isPooledBridgeSessionName(bridgeSessionName),
    ),
    "bridge.pid",
  );
}

export function resolveActiveBridgePidFile(): string {
  return resolveBridgePidFileForBridgeSession();
}
