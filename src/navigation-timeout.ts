/**
 * Opt-in navigation timeout for `open` and `newpage`.
 *
 * chrome-devtools-mcp's `new_page` and `navigate_page` accept a `timeout` in
 * milliseconds and fall back to a 10s default without one. AXI sends nothing
 * unless the caller opts in, so unset behaves exactly as before.
 *
 * This module imports nothing (the CLI graph must stay free of the MCP SDK),
 * so both the CLI and the bridge process can share the deadline arithmetic.
 */

export const NAVIGATION_TIMEOUT_ENV =
  "CHROME_DEVTOOLS_AXI_NAVIGATION_TIMEOUT_MS";

/**
 * Largest accepted timeout. Keeps the derived request deadlines below the
 * 2^31-1 ms ceiling of a Node timer.
 */
export const MAX_NAVIGATION_TIMEOUT_MS = 1_000_000_000;

/** The MCP SDK's default per-request deadline, which the bridge must not undercut. */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

/** The CLI's default deadline for one bridge `/call`. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Headroom beyond the tool's own work (snapshot, event wait, IPC). */
const DEADLINE_HEADROOM_MS = 30_000;

/**
 * Parse a navigation timeout from a flag value or the environment. Returns
 * `null` when it is not a positive integer within range.
 */
export function parseNavigationTimeoutMs(
  raw: string | undefined,
): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_NAVIGATION_TIMEOUT_MS) return null;
  return parsed;
}

/**
 * The bridge's MCP request deadline for a tool call. `new_page` can spend
 * `timeout` on `goto` and again waiting for page events, so the deadline is
 * twice the tool timeout plus headroom, and never below the SDK default.
 */
export function mcpRequestTimeoutMs(
  args: Record<string, unknown> | undefined,
): number {
  const timeout = args?.timeout;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  }
  return Math.max(
    DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    2 * timeout + DEADLINE_HEADROOM_MS,
  );
}

/** The CLI's HTTP deadline for a `/call`: always above the bridge's own. */
export function callRequestTimeoutMs(
  args: Record<string, unknown> | undefined,
): number {
  return Math.max(
    DEFAULT_CALL_TIMEOUT_MS,
    mcpRequestTimeoutMs(args) + DEADLINE_HEADROOM_MS,
  );
}
