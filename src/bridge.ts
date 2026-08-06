/**
 * Persistent MCP bridge server for chrome-devtools-axi.
 *
 * Spawns chrome-devtools-mcp as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok", session } or 503 { status: "error", error }
 *   GET  /health?deep=1         → also verifies the attached CDP target; 503 may include reason
 *
 * Writes a PID file to the active session's state dir on startup
 * (~/.chrome-devtools-axi/bridge.pid for the default session; named sessions
 * nest under sessions/<name>/ - see src/sessions.ts).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
} from "./sessions.js";

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
}

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export const DEFAULT_BRIDGE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve how long an unused bridge stays alive. The bridge is intentionally
 * persistent across short-lived CLI invocations, but it must eventually reap
 * its MCP/Chrome process tree when the owning agent disappears without
 * running `stop`.
 */
export function resolveBridgeIdleTimeoutMs(
  value = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS,
): number {
  if (value === undefined || value === "") {
    return DEFAULT_BRIDGE_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS must be an integer >= 1000",
    );
  }
  return parsed;
}

export interface BridgeIdleWatchdog {
  beginRequest(): () => void;
  stop(): void;
}

/**
 * Shut down a bridge after a bounded period with no HTTP clients. In-flight
 * requests suspend the timer, and every completed request starts a fresh idle
 * window. The returned completion callback is idempotent so request error
 * paths cannot accidentally underflow the active-request count.
 */
export function createBridgeIdleWatchdog(
  timeoutMs: number,
  onIdle: () => void | Promise<void>,
): BridgeIdleWatchdog {
  let activeRequests = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    clearTimer();
    if (stopped || activeRequests > 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || activeRequests > 0) return;
      stopped = true;
      void onIdle();
    }, timeoutMs);
    timer.unref();
  };

  arm();

  return {
    beginRequest() {
      if (stopped) return () => {};
      clearTimer();
      activeRequests++;
      let finished = false;
      return () => {
        if (finished || stopped) return;
        finished = true;
        activeRequests--;
        arm();
      };
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

export async function isBridgeClientConnected(
  client: BridgeClient,
): Promise<boolean> {
  try {
    await client.listTools();
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether the bridge's underlying CDP target is reachable. Drives one
 * round-trip MCP tool call (`list_pages`) that requires a live browser/CDP
 * connection — `listTools()` alone only confirms the local MCP server is up,
 * not that the attached browser is still alive. Used by `/health?deep=1` so
 * `ensureBridge` can detect a stale bridge after the user kills + restarts
 * the underlying Chrome/Electron target.
 */
export async function isBridgeTargetReachable(
  client: BridgeClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await client.callTool({ name: "list_pages", arguments: {} });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }
}

function writePidFile(port: number): void {
  const pidFile = resolveSessionPidFile();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port }));
}

/**
 * Remove the session PID file, but only when this process owns it. On a
 * same-session bind race the losing bridge exits via EADDRINUSE after the
 * winning bridge has already written the shared PID file; an unconditional
 * unlink would delete the still-running winner's handle and orphan it (later
 * `stop`/reuse can no longer find it). A missing, unreadable, or malformed
 * file — or one recording a different pid — is left untouched. `ownerPid` is
 * injectable for tests.
 */
export function removePidFile(
  pidFile: string = resolveSessionPidFile(),
  ownerPid: number = process.pid,
): void {
  try {
    const data = JSON.parse(readFileSync(pidFile, "utf-8")) as {
      pid?: unknown;
    };
    if (data.pid !== ownerPid) return;
  } catch {
    // Missing, unreadable, or malformed — nothing we own to remove.
    return;
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone — fine
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hostnames that identify the loopback interface. The bridge is a persistent
 * unauthenticated loopback service on a known port, so it is the target of
 * DNS-rebinding: a malicious page rebinds its own domain to 127.0.0.1 and the
 * browser then issues same-origin requests that hit the bridge. Binding to
 * 127.0.0.1 does NOT stop this - the packets still arrive on loopback. The one
 * thing a rebound request cannot hide is that it carries the attacker's own
 * domain in the `Host` (and `Origin`) header, and those are forbidden headers
 * page JavaScript cannot forge. Requiring both to name loopback is therefore
 * THE anti-rebinding control (see GHSA-x439-jhfh-v9x2).
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  // Node's URL parser keeps IPv6 hostnames bracketed (`[::1]`); strip the
  // brackets so the bare literal matches LOOPBACK_HOSTNAMES.
  const normalized = hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * Extract the hostname from a `Host` header value, dropping any `:port` suffix.
 * Handles bracketed IPv6 (`[::1]:9224` -> `::1`) and bare IPv6 literals
 * (`::1`). Returns null for an empty/whitespace-only value.
 */
export function extractHostHeaderHostname(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    // Anything after the closing bracket must be a `:port` suffix. Reject
    // trailing garbage (e.g. "[::1]evil.com") instead of treating it as the
    // loopback literal "::1" - this keeps the Host parser as strict as the
    // Origin path (new URL(...).hostname), which already rejects the analogue.
    const rest = trimmed.slice(end + 1);
    if (rest.length > 0 && !rest.startsWith(":")) return null;
    return trimmed.slice(1, end);
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed;
  // A second colon means this is a bare (unbracketed) IPv6 literal with no
  // port, not a host:port pair - keep the whole string as the hostname.
  if (trimmed.indexOf(":", firstColon + 1) !== -1) return trimmed;
  return trimmed.slice(0, firstColon);
}

/**
 * True when the `Host` header is present and names the loopback interface.
 * A missing Host, or one naming any other host (e.g. a rebound
 * `evil.attacker.com`), is rejected.
 */
export function isAllowedBridgeHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = extractHostHeaderHostname(host);
  if (hostname === null) return false;
  return isLoopbackHostname(hostname);
}

/**
 * True when the request carries no `Origin` (the CLI client sends none) or an
 * `Origin` whose hostname is loopback. A present-but-non-loopback or
 * unparseable Origin is rejected.
 */
export function isRequestOriginAllowed(req: IncomingMessage): boolean {
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return true;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin === undefined || origin.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

/**
 * Anti-rebinding gate: a request is allowed only when its `Host` header names
 * loopback and any `Origin` header also names loopback. Checked FIRST on every
 * route (health included) so a rebound request is refused before any CDP tool
 * can run.
 */
export function isRequestAllowed(req: IncomingMessage): boolean {
  return isAllowedBridgeHost(req.headers.host) && isRequestOriginAllowed(req);
}

export function extractToolText(content: BridgeContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function getToolContent(result: unknown): BridgeContentBlock[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return [];
  }
  return result.content as BridgeContentBlock[];
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: { name?: unknown; args?: unknown };
  try {
    payload = JSON.parse(body) as { name?: unknown; args?: unknown };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  if (payload.args === undefined) {
    return { name: payload.name, args: {} };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return { name: payload.name, args: payload.args as Record<string, unknown> };
}

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(
    importMetaDir,
    "../bin/chrome-devtools-axi-bridge.js",
  );
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }
  return body;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

async function handleToolsRequest(
  client: BridgeClient,
  res: ServerResponse,
): Promise<void> {
  const result = await client.listTools();
  writeJson(
    res,
    200,
    result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
}

async function handleCallRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const result = await client.callTool({
    name: payload.name,
    arguments: payload.args,
  });
  writeJson(res, 200, { result: extractToolText(getToolContent(result)) });
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  sessionName?: string,
  logForbidden?: (message: string) => void,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // Reject rebound requests before any routing - see isRequestAllowed and
  // GHSA-x439-jhfh-v9x2. This gate covers /health, /tools, and /call alike.
  if (!isRequestAllowed(req)) {
    // Log the refusal so an operator can tell a mis-configured client apart
    // from an actual rebinding attempt. Injected (not a direct
    // logBridgeMessage call) so unit tests stay quiet unless they opt in.
    const rawOrigin = req.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    logForbidden?.(
      `Rejected request with disallowed host: host=${req.headers.host ?? ""} ` +
        `origin=${origin ?? ""} ${req.method ?? ""} ${req.url ?? ""}`,
    );
    writeJson(res, 403, { error: "Forbidden host" });
    return;
  }

  if (
    req.method === "GET" &&
    (req.url === "/health" || req.url?.startsWith("/health?"))
  ) {
    if (!(await isBridgeClientConnected(client))) {
      writeJson(res, 503, { status: "error", error: "Not connected" });
      return;
    }
    const deep = req.url.includes("deep=1");
    if (deep) {
      const probe = await isBridgeTargetReachable(client);
      if (!probe.ok) {
        writeJson(res, 503, {
          status: "error",
          error: "CDP target unreachable",
          reason: probe.reason,
        });
        return;
      }
    }
    writeJson(res, 200, { status: "ok", session: sessionName });
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/tools") {
      await handleToolsRequest(client, res);
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      await handleCallRequest(client, req, res);
      return;
    }
  } catch (error) {
    writeJson(res, 500, { error: getErrorMessage(error) });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

export function createBridgeServer(
  client: BridgeClient,
  sessionName?: string,
  idleWatchdog?: BridgeIdleWatchdog,
): Server {
  return createServer((req, res) => {
    const finishRequest = idleWatchdog?.beginRequest();
    void handleBridgeRequest(
      client,
      req,
      res,
      sessionName,
      logBridgeMessage,
    ).finally(() => {
      finishRequest?.();
    });
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[chrome-devtools-axi] ${message}\n`);
}

/**
 * Distinct exit code the bridge uses for an EADDRINUSE bind failure. A generic
 * non-zero exit is ambiguous (npx/MCP launch failures exit non-zero too), so
 * `ensureBridge` keys on this sentinel to attribute an early death to a genuine
 * port collision versus a startup failure and tailor its error accordingly.
 */
export const BRIDGE_PORT_IN_USE_EXIT_CODE = 48;

/**
 * Handle a fatal HTTP server error by logging it and exiting non-zero. An
 * EADDRINUSE means another bridge already owns this port (typically because
 * `CHROME_DEVTOOLS_AXI_PORT` was exported globally, forcing every session onto
 * one port); it exits with {@link BRIDGE_PORT_IN_USE_EXIT_CODE} so `ensureBridge`
 * can distinguish it from any other early death. Failing loudly prevents
 * `ensureBridge` from silently attaching to the other session's bridge. `exit`
 * is injectable for tests.
 */
export function handleBridgeServerError(
  error: NodeJS.ErrnoException,
  port: number,
  exit: (code: number) => void = process.exit,
): void {
  if (error.code === "EADDRINUSE") {
    logBridgeMessage(
      `Port ${port} is already in use (EADDRINUSE) - another bridge is listening there. ` +
        `Exporting CHROME_DEVTOOLS_AXI_PORT globally forces every session onto one port; ` +
        `unset it so each session gets its own, or set it only per-session.`,
    );
    exit(BRIDGE_PORT_IN_USE_EXIT_CODE);
    return;
  }
  logBridgeMessage(`Bridge server error: ${getErrorMessage(error)}`);
  exit(1);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

/**
 * Chrome flags that keep a browser *we* launch away from the machine owner's
 * login keychain.
 *
 * `--use-mock-keychain` makes Chromium's OSCrypt use an in-memory mock instead
 * of the real `Chrome Safe Storage` keychain item; `--password-store=basic`
 * keeps the password store off the platform secret service. Without them a
 * launched Chrome calls `SecItemAdd` against the login keychain, and if that
 * keychain is not resolvable for the browser process (for example because it
 * was spawned with a redirected `HOME`) macOS answers `errSecNoDefaultKeychain`
 * and raises the `system.keychain.create.loginkc` authorization panel -
 * "Keychain Not Found ... Reset To Defaults" - on the machine owner's screen.
 *
 * Puppeteer happens to pass both flags in its own default set today, so this is
 * currently belt-and-braces. It is stated explicitly because the isolation is a
 * property we owe our users, not one we want to silently inherit from an
 * upstream default that could change: an automation browser must never be able
 * to reach - or offer to reset - the owner's password store.
 */
export const KEYCHAIN_ISOLATION_CHROME_ARGS = [
  "--use-mock-keychain",
  "--password-store=basic",
] as const;

export const MCP_PACKAGE_NAME = "chrome-devtools-mcp";
export const MCP_PACKAGE_VERSION = "1.6.0";
export const MCP_PACKAGE_SPEC = `${MCP_PACKAGE_NAME}@${MCP_PACKAGE_VERSION}`;

const requireFromBridge = createRequire(import.meta.url);

export function buildTransportArgs(): string[] {
  const args = ["-y", MCP_PACKAGE_SPEC];

  const autoConnect = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1";
  const browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  const userDataDir = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
  const channel = process.env.CHROME_DEVTOOLS_AXI_CHANNEL?.trim();

  if (autoConnect) {
    // Chrome 144+ built-in remote debugging via chrome://inspect/#remote-debugging.
    // Connects to the user's running Chrome - no separate browser launched.
    args.push("--autoConnect");
  } else if (browserUrl) {
    // Connect to an existing Chrome instance - skip --isolated and --headless
    // since the user manages the browser lifecycle externally.
    // ws://|wss:// route to --wsEndpoint (direct WebSocket), http(s):// to --browserUrl
    // (which fetches /json/version to discover the WebSocket URL).
    const isWs = /^wss?:\/\//i.test(browserUrl);
    if (isWs) {
      args.push(`--wsEndpoint=${browserUrl}`);
      const wsHeaders = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
      if (wsHeaders) {
        let parsedHeaders: unknown;
        try {
          parsedHeaders = JSON.parse(wsHeaders);
        } catch {
          throw new Error("CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON");
        }
        if (
          parsedHeaders === null ||
          typeof parsedHeaders !== "object" ||
          Array.isArray(parsedHeaders)
        ) {
          throw new Error(
            "CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object",
          );
        }
        args.push(`--wsHeaders=${wsHeaders}`);
      }
    } else {
      args.push(`--browserUrl=${browserUrl}`);
    }
  } else {
    if (userDataDir) {
      // Persistent profile — skip --isolated so the profile is preserved.
      args.push(`--userDataDir=${userDataDir}`);
    } else {
      args.push("--isolated");
    }
    if (process.env.CHROME_DEVTOOLS_AXI_HEADED !== "1") {
      args.push("--headless");
    }
    // Launch modes only: `--chrome-arg` is ignored when chrome-devtools-mcp
    // attaches to a browser somebody else started, and that browser's keychain
    // policy is its owner's to decide, not ours.
    for (const arg of KEYCHAIN_ISOLATION_CHROME_ARGS) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  // --channel selects which installed Chrome distribution chrome-devtools-mcp
  // targets: the running instance --autoConnect attaches to, or the one launched
  // by default. It is irrelevant when attaching to an explicit endpoint, so it is
  // omitted in BROWSER_URL/wsEndpoint mode. Validation is left to chrome-devtools-mcp.
  if (channel && !browserUrl) {
    args.push(`--channel=${channel}`);
  }

  const extraChromeArgs = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
  if (extraChromeArgs) {
    for (const arg of extraChromeArgs.trim().split(/\s+/)) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  return args;
}

/**
 * Probe interface for {@link detectGlobalMcpPath}. Defaults to real `node:fs`
 * + `npm prefix -g`; injectable for tests.
 */
export interface McpPathProbe {
  existsSync: (path: string) => boolean;
  getNpmPrefix: () => string | null;
  readFileSync: (path: string) => string;
  resolvePackageJson: (packageName: string) => string | null;
}

const DEFAULT_MCP_PATH_PROBE: McpPathProbe = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
  resolvePackageJson: (packageName) => {
    try {
      return requireFromBridge.resolve(`${packageName}/package.json`);
    } catch {
      return null;
    }
  },
  getNpmPrefix: () => {
    try {
      return execSync("npm prefix -g", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
};

function getPackageBinPath(manifest: unknown, binName: string): string | null {
  if (manifest === null || typeof manifest !== "object") return null;
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === "string") return bin;
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    return null;
  }
  const binPath = (bin as Record<string, unknown>)[binName];
  return typeof binPath === "string" ? binPath : null;
}

/**
 * Resolve the chrome-devtools-mcp binary from chrome-devtools-axi's own
 * dependency graph. Published chrome-devtools-axi installs ship this pinned
 * dependency, so normal bridge startup can spawn `node <local mcp bin>`
 * directly without a per-session npm/npx resolution step.
 */
export function detectPackagedMcpPath(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): string | null {
  const packageJsonPath = probe.resolvePackageJson(MCP_PACKAGE_NAME);
  if (!packageJsonPath) return null;

  let manifest: unknown;
  try {
    manifest = JSON.parse(probe.readFileSync(packageJsonPath));
  } catch {
    return null;
  }

  const binPath = getPackageBinPath(manifest, MCP_PACKAGE_NAME);
  if (!binPath) return null;

  const candidate = resolve(dirname(packageJsonPath), binPath);
  return probe.existsSync(candidate) ? candidate : null;
}

/**
 * Auto-detect a globally-installed chrome-devtools-mcp by probing
 * `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *
 * Returns the resolved path on success, or null if npm is unavailable or the
 * package isn't installed. This is a compatibility fallback for damaged or
 * partial installs; normal packaged installs use {@link detectPackagedMcpPath}
 * first so the MCP server version stays pinned to chrome-devtools-axi.
 */
export function detectGlobalMcpPath(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): string | null {
  const prefix = probe.getNpmPrefix();
  if (!prefix || prefix.length === 0) return null;
  const candidate = join(
    prefix,
    "lib",
    "node_modules",
    MCP_PACKAGE_NAME,
    "build",
    "src",
    "bin",
    "chrome-devtools-mcp.js",
  );
  return probe.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the command + args used to spawn the chrome-devtools-mcp transport.
 *
 * Resolution order (most → least specific):
 *   1. `CHROME_DEVTOOLS_AXI_MCP_PATH` env var — explicit override, always wins.
 *   2. Package-owned `chrome-devtools-mcp` dependency pinned by chrome-devtools-axi.
 *      This is the normal install path and avoids per-session npm/npx bootstrap.
 *   3. Auto-detect: probe a globally-installed `chrome-devtools-mcp` via
 *      `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *      If found, spawn `node <path>` directly.
 *   4. Fall back to `npx -y chrome-devtools-mcp@<pinned version>` for source
 *      checkouts or broken installs where the package dependency is unavailable.
 */
export function resolveTransportSpec(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): { command: string; args: string[] } {
  const mcpArgs = buildTransportArgs();
  const explicit = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  const mcpPath =
    explicit && explicit.length > 0
      ? explicit
      : (detectPackagedMcpPath(probe) ?? detectGlobalMcpPath(probe));
  if (mcpPath) {
    // Strip the npx prefix `["-y", MCP_PACKAGE_SPEC]` — direct
    // node spawn doesn't need it.
    return {
      command: process.execPath,
      args: [mcpPath, ...mcpArgs.slice(2)],
    };
  }
  return { command: "npx", args: mcpArgs };
}

function createTransport(): StdioClientTransport {
  return new StdioClientTransport(resolveTransportSpec());
}

function createBridgeClient(): Client {
  return new Client({ name: "chrome-devtools-axi-bridge", version: "1.0.0" });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function runBridge(port = resolveSessionPort()): Promise<void> {
  const idleTimeoutMs = resolveBridgeIdleTimeoutMs();

  // Connect the MCP transport (which spawns chrome-devtools-mcp and launches
  // Chrome) before binding the port. A same-session bind race then self-heals:
  // both racers finish booting before listen(), so the loser's EADDRINUSE exit
  // finds the winner already deep-healthy and reuses it instead of failing. The
  // trade-off is one wasted Chrome launch on a genuine cross-session collision,
  // a rare and self-correcting path.
  const transport = createTransport();
  const client = createBridgeClient();
  await client.connect(transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  const sessionName = resolveSessionName();
  let idleWatchdog: BridgeIdleWatchdog | undefined;
  const requestActivity: BridgeIdleWatchdog = {
    beginRequest: () => idleWatchdog?.beginRequest() ?? (() => {}),
    stop: () => idleWatchdog?.stop(),
  };
  const server = createBridgeServer(client, sessionName, requestActivity);
  server.on("error", (error: NodeJS.ErrnoException) => {
    handleBridgeServerError(error, port);
  });

  let shuttingDown = false;
  const shutdown = async (reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    idleWatchdog?.stop();
    if (reason) logBridgeMessage(reason);
    removePidFile();
    await closeServer(server);
    await client.close();
    await transport.close();
    process.exit(0);
  };

  server.listen(port, "127.0.0.1", () => {
    writePidFile(port);
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
    idleWatchdog = createBridgeIdleWatchdog(idleTimeoutMs, () =>
      shutdown(`Idle for ${idleTimeoutMs}ms; shutting down`),
    );
  });

  // Kill our entire process group on exit so chrome-devtools-mcp children
  // don't survive as orphans. The bridge is spawned with detached:true,
  // making it a process group leader — all children share our PGID.
  process.on("exit", () => {
    removePidFile();
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // Already dead or not a group leader
    }
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
