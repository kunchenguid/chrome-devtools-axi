/**
 * HTTP client for the chrome-devtools-axi bridge + bridge lifecycle management.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { AxiError } from "axi-sdk-js";
import {
  AMBIENT_SNAPSHOT_TOOL,
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  MCP_PACKAGE_SPEC,
  resolveBridgeIdleTimeoutMs,
  resolveBridgeScript,
  resolveRouteIdleTimeoutMs,
  validateBrowserPoolConnectionMode,
} from "./bridge.js";
import {
  isBrowserPoolEnabled,
  resolveBridgePidFile,
  resolveBridgePidFileForBridgeSession,
  resolveBridgePort,
  resolveBridgeSessionName,
  resolveSessionName,
} from "./sessions.js";

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const MIN_BRIDGE_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
const DEEP_HEALTH_TIMEOUT_MS = 5_000;
const TARGET_LOSS_CONFIRMATION_ATTEMPTS = 2;
const TARGET_LOSS_CONFIRMATION_DELAY_MS = 250;

/**
 * Resolve the bridge readiness deadline in milliseconds.
 *
 * Honors `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` for systems where npx
 * bootstrap or Chrome launch is slow (>30s). Values below 1s are clamped to
 * 1s to avoid pathological retries.
 */
export function resolveBridgeTimeoutMs(): number {
  const raw = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  if (!raw) return DEFAULT_BRIDGE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return Math.max(parsed, MIN_BRIDGE_TIMEOUT_MS);
}

export type ErrorCode =
  | "BRIDGE_NOT_READY"
  | "REF_NOT_FOUND"
  | "STALE_REF"
  | "TIMEOUT"
  | "BROWSER_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class CdpError extends AxiError {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly suggestions: string[] = [],
  ) {
    super(message, code, suggestions);
    this.name = "CdpError";
  }
}

export interface PidInfo {
  pid: number;
  port: number;
  session?: string;
  instanceId?: string;
  startedAt?: string;
  lastActivityAt?: string;
  owner?: unknown;
}

export function readPidFile(
  pidFile: string = resolveBridgePidFile(),
): PidInfo | null {
  try {
    if (!existsSync(pidFile)) return null;
    const data = JSON.parse(readFileSync(pidFile, "utf-8"));
    if (typeof data.pid === "number" && typeof data.port === "number") {
      return data as PidInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpGet(
  port: number,
  path: string,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: timeoutMs,
        headers: idleTimeoutHeaders(),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...idleTimeoutHeaders(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(data));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

function idleTimeoutHeaders(): Record<string, string> {
  const value = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
  return value ? { "X-Axi-Idle-Timeout-Ms": value } : {};
}

/**
 * Apply the caller's effective bridge idle policy to its pooled logical route
 * as well. This makes explicit CLI timeouts and persisted agent-session
 * policies reclaim route-owned pages without shortening unrelated active work.
 */
export function requestedRouteIdleTimeoutMs(): number | undefined {
  const callerValue = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
  if (callerValue) return resolveBridgeIdleTimeoutMs(callerValue);
  const routeValue = process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS;
  return routeValue ? resolveRouteIdleTimeoutMs(routeValue) : undefined;
}

/**
 * Probe the bridge's `/health` endpoint. With `deep: true`, asks the bridge
 * to drive one CDP-backed MCP call (`list_pages`) so callers can distinguish
 * "MCP server is up but the attached browser is gone" from genuine readiness.
 *
 * With `expectedSession`, a bridge that reports a *different* session name is
 * treated as unhealthy, so a session never silently reuses another session's
 * bridge after a port collision (two sessions pinned to one port via a global
 * `CHROME_DEVTOOLS_AXI_PORT`). A bridge that omits the field (older version) is
 * accepted, since there is no mismatch to detect.
 *
 * Exported for tests; production code uses it via `ensureBridge`.
 */
export async function checkBridgeHealth(
  port: number,
  opts: {
    deep?: boolean;
    expectedSession?: string;
    expectedInstanceId?: string;
    expectedPid?: number;
  } = {},
): Promise<boolean> {
  return (await probeBridgeHealth(port, opts)).status === "ok";
}

export type BridgeHealthProbe =
  | { status: "ok" }
  | { status: "target-unreachable"; reason?: string }
  | { status: "unhealthy" }
  | { status: "identity-mismatch" }
  | { status: "unreachable" };

export async function probeBridgeHealth(
  port: number,
  opts: {
    deep?: boolean;
    expectedSession?: string;
    expectedInstanceId?: string;
    expectedPid?: number;
  } = {},
): Promise<BridgeHealthProbe> {
  try {
    const path = opts.deep ? "/health?deep=1" : "/health";
    const timeoutMs = opts.deep ? DEEP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
    const resp = await httpGet(port, path, timeoutMs);
    const data = JSON.parse(resp);
    if (
      opts.expectedSession !== undefined &&
      typeof data.session === "string" &&
      data.session !== opts.expectedSession
    ) {
      return { status: "identity-mismatch" };
    }
    if (
      opts.expectedInstanceId !== undefined &&
      data.instanceId !== opts.expectedInstanceId
    ) {
      return { status: "identity-mismatch" };
    }
    if (opts.expectedPid !== undefined && data.pid !== opts.expectedPid) {
      return { status: "identity-mismatch" };
    }
    if (data.status === "ok") return { status: "ok" };
    if (opts.deep && data.error === "CDP target unreachable") {
      return {
        status: "target-unreachable",
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      };
    }
    return { status: "unhealthy" };
  } catch {
    return { status: "unreachable" };
  }
}

export async function confirmBridgeTargetUnreachable(
  port: number,
  opts: {
    expectedSession?: string;
    expectedInstanceId?: string;
    expectedPid?: number;
  },
  attempts = TARGET_LOSS_CONFIRMATION_ATTEMPTS,
  delayMs = TARGET_LOSS_CONFIRMATION_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(delayMs);
    const probe = await probeBridgeHealth(port, { ...opts, deep: true });
    if (probe.status !== "target-unreachable") return false;
  }
  return true;
}

export async function checkBridgeIdentity(
  port: number,
  expected: { session: string; instanceId: string; pid: number },
): Promise<boolean> {
  try {
    const data = JSON.parse(await httpGet(port, "/health", HEALTH_TIMEOUT_MS));
    return (
      data.session === expected.session &&
      data.instanceId === expected.instanceId &&
      data.pid === expected.pid
    );
  } catch {
    return false;
  }
}

async function requestAuthenticatedBridgeShutdown(
  port: number,
  instanceId: string,
): Promise<boolean> {
  try {
    const data = JSON.parse(
      await httpPost(port, "/shutdown", { instanceId }, 5_000),
    );
    return data.status === "shutting-down";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

export function isBridgeProcess(pid: number): boolean {
  try {
    const command = readProcessCommand(pid);
    return command.includes("chrome-devtools-axi-bridge");
  } catch {
    return false;
  }
}

export function readProcessCommand(
  pid: number,
  platform = process.platform,
  run: typeof execFileSync = execFileSync,
): string {
  if (platform === "win32") {
    return run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ],
      { encoding: "utf-8", timeout: 1000 },
    );
  }
  return run("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf-8",
    timeout: 1000,
  });
}

/**
 * Terminate a bridge process and reap its detached process group. Sends
 * SIGTERM, polls up to ~2s for exit, then escalates to SIGKILL on the entire
 * process group so chrome-devtools-mcp / Chrome children can't survive as
 * orphans. Returns once the bridge PID is gone (or the SIGKILL grace window
 * expires).
 */
export async function terminateBridgeProcess(
  pid: number,
  opts: { killProcessGroup?: boolean } = {},
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const killProcessGroup = opts.killProcessGroup === true;

  if (process.platform === "win32" && killProcessGroup) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
    }
    await waitForProcessExit(pid, 1000);
    return;
  }

  // Give the bridge a chance to run its own shutdown handler (which kills its
  // process group on `exit`).
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, 2000)) {
    if (killProcessGroup) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group already gone or pid was never a group leader — fine.
      }
    }
    return;
  }

  // Escalate: kill the whole process group so children get reaped together.
  if (killProcessGroup) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  }
  await waitForProcessExit(pid, 1000);
}

/**
 * Minimal view of the spawned bridge process that {@link ensureBridge} needs:
 * an `exit` notification so a bridge that dies before reporting healthy can be
 * detected. The default {@link spawnBridgeProcess} returns a `ChildProcess`
 * (which satisfies this); tests inject a fake.
 */
export interface SpawnedBridge {
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

/**
 * Spawn the detached bridge process. Prefers the sibling `.ts` (dev mode, run
 * via tsx) and falls back to the built `.js`, so dev and dist behave the same.
 */
function spawnBridgeProcess(port: number, sessionName: string): SpawnedBridge {
  const bridgeScript = resolveBridgeScript(import.meta.dirname);
  const script = existsSync(bridgeScript.replace(/\.js$/, ".ts"))
    ? bridgeScript.replace(/\.js$/, ".ts")
    : bridgeScript;
  const launch = resolveBridgeLaunchCommand(script);

  const child = spawn(launch.command, launch.args, {
    stdio: "ignore",
    env: {
      ...process.env,
      CHROME_DEVTOOLS_AXI_PORT: String(port),
      CHROME_DEVTOOLS_AXI_SESSION: sessionName,
    },
    detached: true,
  });
  child.unref();
  return child;
}

export function resolveBridgeLaunchCommand(script: string): {
  command: string;
  args: string[];
} {
  return {
    command: process.execPath,
    args: script.endsWith(".ts") ? ["--import", "tsx", script] : [script],
  };
}

/**
 * Build the error thrown when a freshly spawned bridge exits before it ever
 * reports healthy. Surfacing this the moment the child dies - rather than
 * polling the full readiness deadline - turns an early death into a fast,
 * actionable failure instead of a slow, generic "failed to start" timeout.
 *
 * The guidance is attributed by exit code. Only {@link BRIDGE_PORT_IN_USE_EXIT_CODE}
 * (the bridge's EADDRINUSE sentinel) gets the port-in-use explanation; any
 * other early death is a startup failure (packaged MCP could not start, the
 * pinned npx fallback could not resolve/download chrome-devtools-mcp, a broken
 * `CHROME_DEVTOOLS_AXI_MCP_PATH`, or a Chrome launch failure) and gets the
 * generic startup guidance, so a single-session user with a broken install is
 * not misdirected to port advice.
 */
export function buildBridgeEarlyExitError(
  sessionName: string,
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): CdpError {
  const how =
    signal != null
      ? `was killed by ${signal}`
      : `exited with code ${code ?? "unknown"}`;
  const message = `Bridge for session "${sessionName}" ${how} before becoming ready on port ${port}`;

  if (code === BRIDGE_PORT_IN_USE_EXIT_CODE) {
    return new CdpError(message, "BRIDGE_NOT_READY", [
      `Port ${port} is already in use. It may be held by another chrome-devtools-axi session's bridge (a hashed-port collision, or a globally-exported CHROME_DEVTOOLS_AXI_PORT forcing every session onto one port), by a stale or crashed bridge that could not be reused, or by an unrelated process.`,
      "Set a distinct CHROME_DEVTOOLS_AXI_PORT for this session, unset a global CHROME_DEVTOOLS_AXI_PORT so every session derives its own, or free whatever is holding the port.",
    ]);
  }

  const suggestions = [
    "Reinstall chrome-devtools-axi so its packaged MCP dependency is present.",
  ];
  if (process.env.CHROME_DEVTOOLS_AXI_MCP_PATH) {
    suggestions.push(
      "Verify CHROME_DEVTOOLS_AXI_MCP_PATH points to a valid chrome-devtools-mcp build.",
    );
  } else {
    suggestions.push(
      `If the packaged dependency is unavailable, check the pinned fallback directly: npx -y ${MCP_PACKAGE_SPEC} --help`,
    );
  }
  suggestions.push(
    "Or Chrome failed to launch; confirm a usable Chrome is installed.",
  );
  return new CdpError(message, "BRIDGE_NOT_READY", suggestions);
}

/**
 * Ensure the bridge is running, starting it if needed. Returns the port.
 *
 * Verifies a *deep* health check (one round-trip CDP-backed MCP call) before
 * declaring the bridge ready. Automatic replacement requires the recorded
 * session/instance/PID identity and repeated target-unreachable probes; other
 * deep-health failures preserve the existing bridge because another route may
 * still be active.
 *
 * `spawnBridge` is injectable for tests; production uses {@link spawnBridgeProcess}.
 */
export async function ensureBridge(
  spawnBridge: (
    port: number,
    sessionName: string,
  ) => SpawnedBridge = spawnBridgeProcess,
): Promise<number> {
  validateBrowserPoolConnectionMode();
  const sessionName = resolveSessionName();
  const bridgeSessionName = resolveBridgeSessionName(sessionName);
  const port = resolveBridgePort(sessionName);
  const pidFile = resolveBridgePidFile(sessionName);

  // Check the existing bridge via its PID file. Recycle it only after exact
  // identity and repeated deep probes confirm persistent CDP target loss.
  const pidInfo = readPidFile(pidFile);
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    const recordedSessionMatches =
      pidInfo.session === undefined || pidInfo.session === bridgeSessionName;
    const shallowAny = await checkBridgeHealth(pidInfo.port);
    const identityOptions =
      pidInfo.instanceId === undefined
        ? {}
        : {
            expectedInstanceId: pidInfo.instanceId,
            expectedPid: pidInfo.pid,
          };
    const shallowExpected = await checkBridgeHealth(pidInfo.port, {
      expectedSession: bridgeSessionName,
      ...identityOptions,
    });
    const healthSessionMatches = !shallowAny || shallowExpected;
    if (recordedSessionMatches && healthSessionMatches) {
      const deepOptions = {
        expectedSession: bridgeSessionName,
        ...identityOptions,
      };
      const deepProbe = await probeBridgeHealth(pidInfo.port, {
        ...deepOptions,
        deep: true,
      });
      if (deepProbe.status === "ok") {
        return pidInfo.port;
      }
      const identityMatches =
        pidInfo.instanceId !== undefined &&
        (await checkBridgeIdentity(pidInfo.port, {
          session: bridgeSessionName,
          instanceId: pidInfo.instanceId,
          pid: pidInfo.pid,
        }));
      const targetLossConfirmed =
        deepProbe.status === "target-unreachable" &&
        identityMatches &&
        (await confirmBridgeTargetUnreachable(pidInfo.port, deepOptions));
      if (targetLossConfirmed && pidInfo.instanceId !== undefined) {
        const shutdownAccepted = await requestAuthenticatedBridgeShutdown(
          pidInfo.port,
          pidInfo.instanceId,
        );
        const exited =
          shutdownAccepted && (await waitForProcessExit(pidInfo.pid, 5_000));
        if (!exited) {
          throw new CdpError(
            "The stale bridge accepted shutdown but did not exit before its deadline",
            "BRIDGE_NOT_READY",
            ["Retry after the bridge process has exited."],
          );
        }
      } else if (shallowExpected) {
        throw new CdpError(
          "The bridge target health check failed without confirmed persistent target loss",
          "BRIDGE_NOT_READY",
          [
            "Retry the command; the bridge was preserved because another route may still be active.",
          ],
        );
      }
    }
  }

  // Start a new bridge
  const child = spawnBridge(port, bridgeSessionName);

  // If the freshly spawned bridge dies before it reports healthy - an EADDRINUSE
  // port collision with another session, or a startup failure (npx/MCP launch,
  // Chrome), whose stderr is lost to `stdio: "ignore"` - fail fast
  // instead of polling the full readiness deadline and reporting a generic
  // timeout. The exit code attributes the cause (see buildBridgeEarlyExitError).
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  // Poll for health — Chrome launch can be slow, and broken installs may hit
  // the slower pinned npx fallback.
  // Track whether the *shallow* health check ever passed so we can attribute
  // the failure correctly: shallow-but-no-deep means the MCP server came up
  // but the attached CDP target is dead, vs. nothing-came-up which is the
  // generic startup-timeout case.
  const timeoutMs = resolveBridgeTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let sawShallowReady = false;
  while (Date.now() < deadline) {
    if (
      await checkBridgeHealth(port, {
        deep: true,
        expectedSession: bridgeSessionName,
      })
    ) {
      return port;
    }
    if (childExited) {
      if (
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: bridgeSessionName,
        })
      ) {
        return port;
      }
      throw buildBridgeEarlyExitError(
        bridgeSessionName,
        port,
        exitCode,
        exitSignal,
      );
    }
    if (
      !sawShallowReady &&
      (await checkBridgeHealth(port, { expectedSession: bridgeSessionName }))
    ) {
      sawShallowReady = true;
    }
    await sleep(500);
  }

  const seconds = Math.round(timeoutMs / 1000);

  if (sawShallowReady) {
    throw new CdpError(
      "Bridge is running but the attached CDP target appears to have gone away",
      "BRIDGE_NOT_READY",
      [
        "The Chrome/Electron instance the bridge was attached to may have exited.",
        "Verify the target is still listening on its remote-debugging port, then re-run the command.",
        "If the target was restarted, the bridge has already been recycled — this run will succeed once the target is reachable.",
      ],
    );
  }

  const suggestions = [
    "Reinstall chrome-devtools-axi so its packaged MCP dependency is present.",
  ];
  if (process.env.CHROME_DEVTOOLS_AXI_MCP_PATH) {
    suggestions.push(
      "Verify CHROME_DEVTOOLS_AXI_MCP_PATH points to a valid chrome-devtools-mcp build.",
    );
  } else {
    suggestions.push(
      `If the packaged dependency is unavailable, check the pinned fallback directly: npx -y ${MCP_PACKAGE_SPEC} --help`,
    );
  }
  suggestions.push(
    "Or extend the deadline: export CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS=60000",
  );
  throw new CdpError(
    `Bridge failed to start within ${seconds}s`,
    "BRIDGE_NOT_READY",
    suggestions,
  );
}

/**
 * Call an MCP tool via the bridge. Returns the text result.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const port = await ensureBridge();
  const routeSession = resolveSessionName();

  try {
    const resp = await httpPost(port, "/call", {
      name,
      args,
      routeSession,
      routeIdleTimeoutMs: requestedRouteIdleTimeoutMs(),
    });
    const data = JSON.parse(resp);
    if (data.error) {
      throw new Error(data.error);
    }
    return data.result ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapErrorMessage(message);
  }
}

export function mapErrorMessage(message: string): CdpError {
  if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return new CdpError("Bridge is not running", "BRIDGE_NOT_READY", [
      "Run `chrome-devtools-axi open <url>` — the bridge starts automatically",
    ]);
  }
  if (
    (message.includes("uid") || message.includes("element")) &&
    (message.includes("not found") || message.includes("invalid"))
  ) {
    return new CdpError(message, "REF_NOT_FOUND", [
      "Run `chrome-devtools-axi snapshot` to see available elements and their @uid refs",
    ]);
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new CdpError(message, "TIMEOUT", [
      "Run `chrome-devtools-axi snapshot` to see current page state",
    ]);
  }
  // Try to parse JSON error
  try {
    const parsed = JSON.parse(message);
    if (parsed.error) {
      return new CdpError(parsed.error, "BROWSER_ERROR", [
        "Run `chrome-devtools-axi snapshot` to see current page state",
      ]);
    }
  } catch {
    // Not JSON
  }
  return new CdpError(message, "UNKNOWN");
}

/**
 * Get the current page snapshot without starting the bridge.
 *
 * Returns null if the bridge is not running or healthy. This is the ambient
 * home view / SessionStart probe, so it must stay cheap and never throw: an
 * invalid `CHROME_DEVTOOLS_AXI_SESSION` degrades to "no active session" (null)
 * here, while action commands (`ensureBridge` / `stopBridge`) still fail loudly.
 */
export async function getSessionSnapshotIfRunning(): Promise<string | null> {
  let sessionName: string;
  let bridgeSessionName: string;
  let pidInfo: PidInfo | null;
  try {
    sessionName = resolveSessionName();
    bridgeSessionName = resolveBridgeSessionName(sessionName);
    pidInfo = readPidFile(resolveBridgePidFile(sessionName));
  } catch {
    return null;
  }
  if (!pidInfo || !isProcessAlive(pidInfo.pid)) {
    return null;
  }
  if (
    !(await checkBridgeHealth(pidInfo.port, {
      expectedSession: bridgeSessionName,
    }))
  ) {
    return null;
  }
  try {
    const resp = await httpPost(
      pidInfo.port,
      "/call",
      {
        name: isBrowserPoolEnabled() ? AMBIENT_SNAPSHOT_TOOL : "take_snapshot",
        args: {},
        routeSession: sessionName,
        routeIdleTimeoutMs: requestedRouteIdleTimeoutMs(),
      },
      5000,
    );
    const data = JSON.parse(resp);
    if (data.error) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop the active logical session. In unpooled mode this terminates the bridge
 * process and reaps its MCP/Chrome process group; in pooled mode it releases
 * only the caller's owned pages and leaves the shared bridge running.
 */
export async function stopBridge(): Promise<boolean> {
  return (await stopBridgeSession()) === "stopped";
}

export type StopBridgeSessionResult =
  | "stopped"
  | "not-running"
  | "not-bridge"
  | "session-mismatch"
  | "shutdown-timeout";

export type StopBridgeSessionTarget = "logical" | "dedicated" | "physical-pool";

/**
 * Stop one logical session after validating that its PID file still points at
 * the expected chrome-devtools-axi bridge process. The target distinguishes a
 * logical pooled route from diagnostics that intentionally stop a dedicated
 * or physical pool-slot bridge. Physical stops use an instance-ID-authenticated
 * self-shutdown request, so cleanup never sends a terminating signal to a PID
 * after it can be reused.
 * Logical route release remains compatible with legacy pooled bridges that do
 * not report an instance ID because it never terminates the physical process.
 */
export async function stopBridgeSession(
  sessionName: string = resolveSessionName(),
  opts: { target?: StopBridgeSessionTarget; physicalPool?: boolean } = {},
): Promise<StopBridgeSessionResult> {
  const target = opts.physicalPool
    ? "physical-pool"
    : (opts.target ?? "logical");
  const isPhysicalPool = target === "physical-pool";
  const isDedicated = target === "dedicated";
  const bridgeSessionName =
    isPhysicalPool || isDedicated
      ? sessionName
      : resolveBridgeSessionName(sessionName);
  const pidInfo = readPidFile(
    isPhysicalPool
      ? resolveBridgePidFileForBridgeSession(sessionName, true)
      : isDedicated
        ? resolveBridgePidFileForBridgeSession(sessionName, false)
        : resolveBridgePidFile(sessionName),
  );
  if (!pidInfo) return "not-running";
  if (!isProcessAlive(pidInfo.pid)) return "not-running";
  if (pidInfo.session !== undefined && pidInfo.session !== bridgeSessionName) {
    return "session-mismatch";
  }
  if (!isBridgeProcess(pidInfo.pid)) return "not-bridge";

  if (target === "logical" && isBrowserPoolEnabled()) {
    const identityMatches =
      pidInfo.instanceId === undefined
        ? await checkBridgeHealth(pidInfo.port, {
            expectedSession: bridgeSessionName,
          })
        : await checkBridgeIdentity(pidInfo.port, {
            session: bridgeSessionName,
            instanceId: pidInfo.instanceId,
            pid: pidInfo.pid,
          });
    if (!identityMatches) return "not-bridge";
    try {
      await httpPost(
        pidInfo.port,
        "/call",
        {
          name: "__axi_release_session",
          args: {},
          routeSession: sessionName,
        },
        10_000,
      );
      return "stopped";
    } catch {
      return "not-running";
    }
  }

  if (
    pidInfo.instanceId === undefined ||
    !(await checkBridgeIdentity(pidInfo.port, {
      session: bridgeSessionName,
      instanceId: pidInfo.instanceId,
      pid: pidInfo.pid,
    }))
  ) {
    return "not-bridge";
  }
  if (
    !(await requestAuthenticatedBridgeShutdown(
      pidInfo.port,
      pidInfo.instanceId,
    ))
  ) {
    return "not-running";
  }
  return (await waitForProcessExit(pidInfo.pid, 5_000))
    ? "stopped"
    : "shutdown-timeout";
}
