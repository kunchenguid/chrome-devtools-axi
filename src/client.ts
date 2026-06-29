/**
 * HTTP client for the chrome-devtools-axi bridge + bridge lifecycle management.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { AxiError } from "axi-sdk-js";
import { BRIDGE_PORT_IN_USE_EXIT_CODE, resolveBridgeScript } from "./bridge.js";
import {
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
} from "./sessions.js";

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const MIN_BRIDGE_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
const DEEP_HEALTH_TIMEOUT_MS = 5_000;

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

interface PidInfo {
  pid: number;
  port: number;
}

function readPidFile(
  pidFile: string = resolveSessionPidFile(),
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

function isProcessAlive(pid: number): boolean {
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
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
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
  opts: { deep?: boolean; expectedSession?: string } = {},
): Promise<boolean> {
  try {
    const path = opts.deep ? "/health?deep=1" : "/health";
    const timeoutMs = opts.deep ? DEEP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
    const resp = await httpGet(port, path, timeoutMs);
    const data = JSON.parse(resp);
    if (data.status !== "ok") return false;
    if (
      opts.expectedSession !== undefined &&
      typeof data.session === "string" &&
      data.session !== opts.expectedSession
    ) {
      return false;
    }
    return true;
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

function isBridgeProcess(pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return command.includes("chrome-devtools-axi-bridge");
  } catch {
    return false;
  }
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
  const runner = script.endsWith(".ts") ? "tsx" : "node";

  const child = spawn(
    runner === "tsx" ? "npx" : "node",
    runner === "tsx" ? ["tsx", script] : [script],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        CHROME_DEVTOOLS_AXI_PORT: String(port),
        CHROME_DEVTOOLS_AXI_SESSION: sessionName,
      },
      detached: true,
    },
  );
  child.unref();
  return child;
}

/**
 * Build the error thrown when a freshly spawned bridge exits before it ever
 * reports healthy. Surfacing this the moment the child dies - rather than
 * polling the full readiness deadline - turns an early death into a fast,
 * actionable failure instead of a slow, generic "failed to start" timeout.
 *
 * The guidance is attributed by exit code. Only {@link BRIDGE_PORT_IN_USE_EXIT_CODE}
 * (the bridge's EADDRINUSE sentinel) gets the port-in-use explanation; any
 * other early death is a startup failure (npx could not resolve/download
 * chrome-devtools-mcp, a broken `CHROME_DEVTOOLS_AXI_MCP_PATH`, or a
 * Chrome launch failure) and gets the generic startup guidance, so a
 * single-session user with a broken install is not misdirected to port advice.
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
    "Check that chrome-devtools-mcp can start: npx chrome-devtools-mcp@latest --help",
  ];
  if (process.env.CHROME_DEVTOOLS_AXI_MCP_PATH) {
    suggestions.push(
      "Verify CHROME_DEVTOOLS_AXI_MCP_PATH points to a valid chrome-devtools-mcp build.",
    );
  } else {
    suggestions.push(
      "`npx -y chrome-devtools-mcp@latest` may have failed to resolve/download the package (offline, or a slow cold first run); install it globally and set:",
      '  export CHROME_DEVTOOLS_AXI_MCP_PATH="$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"',
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
 * declaring the bridge ready, so a bridge whose attached browser/Electron
 * target was killed while still answering local /health requests gets torn
 * down + restarted instead of being reused as a stale endpoint.
 *
 * `spawnBridge` is injectable for tests; production uses {@link spawnBridgeProcess}.
 */
export async function ensureBridge(
  spawnBridge: (
    port: number,
    sessionName: string,
  ) => SpawnedBridge = spawnBridgeProcess,
): Promise<number> {
  const sessionName = resolveSessionName();
  const port = resolveSessionPort(sessionName);
  const pidFile = resolveSessionPidFile(sessionName);

  // Check existing bridge via PID file. Use a deep probe so a bridge whose
  // attached CDP target has gone away gets recycled instead of returned.
  const pidInfo = readPidFile(pidFile);
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    if (
      await checkBridgeHealth(pidInfo.port, {
        deep: true,
        expectedSession: sessionName,
      })
    ) {
      return pidInfo.port;
    }
    await terminateBridgeProcess(pidInfo.pid, {
      killProcessGroup: isBridgeProcess(pidInfo.pid),
    });
  }

  // Start a new bridge
  const child = spawnBridge(port, sessionName);

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

  // Poll for health — Chrome launch + npx bootstrap can be slow.
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
        expectedSession: sessionName,
      })
    ) {
      return port;
    }
    if (childExited) {
      if (
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: sessionName,
        })
      ) {
        return port;
      }
      throw buildBridgeEarlyExitError(sessionName, port, exitCode, exitSignal);
    }
    if (
      !sawShallowReady &&
      (await checkBridgeHealth(port, { expectedSession: sessionName }))
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

  const usingNpx = !process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  const suggestions = [
    "Check that chrome-devtools-mcp is installed: npx chrome-devtools-mcp@latest --help",
  ];
  if (usingNpx) {
    suggestions.push(
      "If `npx -y chrome-devtools-mcp@latest` is slow on this machine, install mcp globally and set:",
      '  export CHROME_DEVTOOLS_AXI_MCP_PATH="$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"',
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

  try {
    const resp = await httpPost(port, "/call", { name, args });
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
  let pidInfo: PidInfo | null;
  try {
    sessionName = resolveSessionName();
    pidInfo = readPidFile(resolveSessionPidFile(sessionName));
  } catch {
    return null;
  }
  if (!pidInfo || !isProcessAlive(pidInfo.pid)) {
    return null;
  }
  if (
    !(await checkBridgeHealth(pidInfo.port, { expectedSession: sessionName }))
  ) {
    return null;
  }
  try {
    const resp = await httpPost(
      pidInfo.port,
      "/call",
      { name: "take_snapshot", args: {} },
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
 * Stop the bridge process. Waits for the bridge PID to actually exit (bounded
 * poll, ~2s) before escalating to SIGKILL on the entire detached process
 * group, so chrome-devtools-mcp + Chrome children get reaped together rather
 * than orphaned. Resolves once the bridge process is gone.
 */
export async function stopBridge(): Promise<boolean> {
  const pidInfo = readPidFile();
  if (!pidInfo) return false;
  if (!isProcessAlive(pidInfo.pid)) return false;
  await terminateBridgeProcess(pidInfo.pid, {
    killProcessGroup: isBridgeProcess(pidInfo.pid),
  });
  return true;
}
