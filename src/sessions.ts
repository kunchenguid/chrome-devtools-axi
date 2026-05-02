/**
 * Named sessions — per-session bridge isolation.
 *
 * When `CHROME_DEVTOOLS_AXI_SESSION` is set to a non-default name, the bridge
 * binds its PID file, default user data dir, and (auto-allocated) port to
 * that name. This lets multiple bridges run concurrently — one per
 * worktree, one per test user, one per Chrome profile, etc. — without
 * stepping on each other.
 *
 *   CHROME_DEVTOOLS_AXI_SESSION=widecorp-ceo chrome-devtools-axi open ...
 *   CHROME_DEVTOOLS_AXI_SESSION=deb-admin     chrome-devtools-axi open ...
 *
 * Each session above gets its own bridge process, port, and persistent
 * profile dir. They do not share Chrome state.
 *
 * Env var precedence over auto-derived defaults:
 *   port      — CHROME_DEVTOOLS_AXI_PORT > deterministic hash of session name
 *   profile   — CHROME_DEVTOOLS_AXI_USER_DATA_DIR > session-default dir
 *   pid file  — always derived from session name (no override needed)
 *
 * The default session name is "default", which preserves prior behavior:
 * port 9224, ~/.chrome-devtools-axi/bridge.pid, no auto-profile.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_SESSION_NAME = "default";
export const DEFAULT_BASE_PORT = 9224;

const SESSION_PORT_RANGE = 100; // 9225..9324 reserved for named sessions
const STATE_DIR_NAME = ".chrome-devtools-axi";
const PROFILE_CACHE_DIR = ".cache/chrome-devtools-axi/sessions";

/**
 * Resolve the active session name from env. Returns DEFAULT_SESSION_NAME when
 * unset, empty, or explicitly "default".
 */
export function resolveSessionName(): string {
  const raw = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  if (!raw) return DEFAULT_SESSION_NAME;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_SESSION_NAME;
  return trimmed;
}

/**
 * Throw if the session name contains characters that aren't safe for filesystem
 * paths or env var keys. We allow lowercase, digits, dash, underscore, dot.
 */
export function validateSessionName(name: string): void {
  if (name === DEFAULT_SESSION_NAME) return;
  if (!/^[a-z0-9._-]{1,64}$/i.test(name)) {
    throw new Error(
      `Invalid session name: "${name}". Use 1-64 chars from [a-zA-Z0-9._-]`,
    );
  }
}

/**
 * Deterministic port allocation for a session name. Uses a simple FNV-1a-ish
 * hash mod SESSION_PORT_RANGE, offset from DEFAULT_BASE_PORT+1 so the default
 * session keeps port 9224.
 *
 * Two different names can collide on a port — that's a concurrency limit, not
 * a correctness bug. If you hit a collision, set CHROME_DEVTOOLS_AXI_PORT.
 */
export function defaultPortForSession(name: string): number {
  if (name === DEFAULT_SESSION_NAME) return DEFAULT_BASE_PORT;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Map signed int → [0, SESSION_PORT_RANGE)
  const offset = (Math.abs(hash) % SESSION_PORT_RANGE) + 1;
  return DEFAULT_BASE_PORT + offset;
}

/**
 * Resolve the bridge port: explicit env var wins; otherwise session-derived.
 */
export function resolveSessionPort(name: string = resolveSessionName()): number {
  const explicit = process.env.CHROME_DEVTOOLS_AXI_PORT;
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return defaultPortForSession(name);
}

/**
 * PID file path for a session. The default session keeps the legacy path
 * (`~/.chrome-devtools-axi/bridge.pid`) so existing tools and prior versions
 * don't get orphaned.
 */
export function resolveSessionPidFile(
  name: string = resolveSessionName(),
): string {
  if (name === DEFAULT_SESSION_NAME) {
    return join(homedir(), STATE_DIR_NAME, "bridge.pid");
  }
  return join(homedir(), STATE_DIR_NAME, "sessions", name, "bridge.pid");
}

/**
 * Default user-data-dir for a session, used when neither
 * CHROME_DEVTOOLS_AXI_USER_DATA_DIR nor BROWSER_URL nor AUTO_CONNECT is set
 * AND we're on a non-default session. The default session retains
 * --isolated behavior unless the user opts in via USER_DATA_DIR.
 */
export function defaultUserDataDirForSession(name: string): string | null {
  if (name === DEFAULT_SESSION_NAME) return null;
  return join(homedir(), PROFILE_CACHE_DIR, name);
}
