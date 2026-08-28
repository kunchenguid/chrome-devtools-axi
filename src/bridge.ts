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
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  resolveBridgeScript,
} from "./bridge-script.js";
import { clearSelectedPageId } from "./selected-page.js";
import {
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
} from "./sessions.js";

// Re-exported so existing bridge consumers keep a single import surface; the
// definitions live in the MCP-free ./bridge-script.js (see its header).
export { BRIDGE_PORT_IN_USE_EXIT_CODE, resolveBridgeScript };

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
  /**
   * Absolute directories the caller wants added to the MCP workspace roots for
   * this call, so file-writing tools may write there. See
   * {@link RootsAwareClient.applyRoots} and the roots negotiation in
   * `runBridge`.
   */
  roots?: string[];
}

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(
    request: {
      name: string;
      arguments: Record<string, unknown>;
    },
    roots?: string[],
  ): Promise<unknown>;
  close(): Promise<void>;
  /**
   * Negotiate the MCP workspace roots to the given absolute directories before
   * the next tool call, so a caller-supplied write path outside the OS temp
   * directory passes chrome-devtools-mcp's `validatePath`. Optional so test
   * fakes need not implement it; the real client always does.
   */
  applyRoots?(dirs: string[]): Promise<void>;
}

/** A {@link BridgeClient} that always negotiates MCP roots. */
export interface RootsAwareClient extends BridgeClient {
  applyRoots(dirs: string[]): Promise<void>;
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
): Promise<
  { ok: true; pageIdentityChanged: boolean } | { ok: false; reason: string }
> {
  try {
    const result = await client.callTool({
      name: "list_pages",
      arguments: {},
    });
    return {
      ok: true,
      pageIdentityChanged: didMcpPageIdentityChange(result),
    };
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

/**
 * Whether an MCP tool result signals failure (`isError: true`). chrome-devtools-mcp
 * reports recoverable tool failures - a denied file write, a bad selector, a
 * navigation error - as a *successful* JSON-RPC response carrying `isError`, not
 * as a protocol error. Treating that as success is how a rejected screenshot got
 * reported as written (issue #96); the bridge must surface it as a failure so the
 * CLI exits non-zero with the tool's own message.
 */
export function isToolResultError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * chrome-devtools-mcp keeps its stdio process alive when Chrome reconnects,
 * but deliberately reissues every page id. Its one-shot reconnect marker is
 * the authoritative identity boundary; the bridge must observe it before the
 * response is flattened or a persisted AXI selection can outlive the ids it
 * belongs to.
 */
export function didMcpPageIdentityChange(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if ("structuredContent" in result) {
    const structured = (result as { structuredContent?: unknown })
      .structuredContent;
    if (
      !!structured &&
      typeof structured === "object" &&
      "reconnected" in structured &&
      (structured as { reconnected?: unknown }).reconnected === true
    ) {
      return true;
    }
  }

  // Upstream only includes structuredContent behind its experimental flag;
  // its default protocol response carries the same one-shot marker as an exact
  // text line. Match the complete dependency-owned sentence rather than a
  // generic "reconnected" substring that page content could accidentally hit.
  const text = extractToolText(getToolContent(result));
  return text
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim() ===
        "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.",
    );
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: { name?: unknown; args?: unknown; roots?: unknown };
  try {
    payload = JSON.parse(body) as {
      name?: unknown;
      args?: unknown;
      roots?: unknown;
    };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  const roots = parseRootsField(payload.roots);
  if (payload.args === undefined) {
    return { name: payload.name, args: {}, ...(roots ? { roots } : {}) };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return {
    name: payload.name,
    args: payload.args as Record<string, unknown>,
    ...(roots ? { roots } : {}),
  };
}

/**
 * Validate the optional `roots` field: absent, or an array of absolute
 * directory paths. Any other shape is a malformed payload and is rejected
 * loudly rather than silently dropped, so a client bug can't quietly disable
 * roots negotiation or make roots depend on the bridge process's cwd.
 */
function parseRootsField(roots: unknown): string[] | undefined {
  if (roots === undefined) return undefined;
  if (
    !Array.isArray(roots) ||
    !roots.every((r) => typeof r === "string" && isAbsolute(r))
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return roots as string[];
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
  onPageIdentityChanged?: () => void,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const result = await client.callTool(
    {
      name: payload.name,
      arguments: payload.args,
    },
    payload.roots,
  );
  if (didMcpPageIdentityChange(result)) onPageIdentityChanged?.();
  const text = extractToolText(getToolContent(result));
  if (isToolResultError(result)) {
    // Surface the tool's own failure text as an error so the CLI throws and
    // exits non-zero instead of printing success (issue #96).
    writeJson(res, 200, { error: text || `Tool "${payload.name}" failed` });
    return;
  }
  writeJson(res, 200, { result: text });
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  sessionName?: string,
  logForbidden?: (message: string) => void,
  onPageIdentityChanged?: () => void,
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
      if (probe.pageIdentityChanged) onPageIdentityChanged?.();
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
      await handleCallRequest(client, req, res, onPageIdentityChanged);
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
): Server {
  return createServer((req, res) => {
    void handleBridgeRequest(
      client,
      req,
      res,
      sessionName,
      logBridgeMessage,
      clearSelectedPageId,
    );
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[chrome-devtools-axi] ${message}\n`);
}

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

export function buildTransportArgs(): string[] {
  const args = ["-y", "chrome-devtools-mcp@latest"];

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
}

const DEFAULT_MCP_PATH_PROBE: McpPathProbe = {
  existsSync: (path) => existsSync(path),
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

/**
 * Auto-detect a globally-installed chrome-devtools-mcp by probing
 * `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *
 * Returns the resolved path on success, or null if npm is unavailable or the
 * package isn't installed. Used as the auto-fallback in
 * {@link resolveTransportSpec} when `CHROME_DEVTOOLS_AXI_MCP_PATH` isn't set.
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
    "chrome-devtools-mcp",
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
 *   2. Auto-detect: probe a globally-installed `chrome-devtools-mcp` via
 *      `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *      If found, spawn `node <path>` directly — starts in ~1-2s vs. the
 *      30s+ npx-bootstrap path.
 *   3. Fall back to `npx -y chrome-devtools-mcp@latest`. On systems with a
 *      slow link or large global cache this can race the bridge's readiness
 *      deadline; install the package globally to skip it:
 *        npm install -g chrome-devtools-mcp
 */
export function resolveTransportSpec(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): { command: string; args: string[] } {
  const mcpArgs = buildTransportArgs();
  const explicit = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  const mcpPath =
    explicit && explicit.length > 0 ? explicit : detectGlobalMcpPath(probe);
  if (mcpPath) {
    // Strip the npx prefix `["-y", "chrome-devtools-mcp@latest"]` — direct
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
  // Declare the `roots` capability so chrome-devtools-mcp asks us for workspace
  // roots (via `roots/list`) instead of restricting every file write to the OS
  // temp directory. `listChanged` lets us update the roots per call.
  return new Client(
    { name: "chrome-devtools-axi-bridge", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
}

/** How long {@link RootsAwareClient.applyRoots} waits for chrome-devtools-mcp to
 * re-read our roots after a `list_changed` notification before proceeding. The
 * round-trip is local stdio (sub-millisecond); this cap only stops a server
 * that never re-reads from wedging the call. */
const ROOTS_FETCH_WAIT_MS = 2_000;

function toRoots(dirs: string[]): Array<{ uri: string; name: string }> {
  const seen = new Set<string>();
  const roots: Array<{ uri: string; name: string }> = [];
  for (const dir of dirs) {
    const uri = pathToFileURL(dir).href;
    if (seen.has(uri)) continue;
    seen.add(uri);
    roots.push({ uri, name: basename(dir) || dir });
  }
  return roots;
}

function rootUrisEqual(
  a: Array<{ uri: string }>,
  b: Array<{ uri: string }>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((root, i) => root.uri === b[i]?.uri);
}

/**
 * Wrap an MCP {@link Client} so it answers `roots/list` and can renegotiate the
 * workspace roots on demand. Registers the `roots/list` handler that returns the
 * current roots, and exposes {@link RootsAwareClient.applyRoots}: it swaps in the
 * requested directories, fires `roots/list_changed`, and waits for the server to
 * re-read them (bounded) before returning, so the *next* tool call validates
 * against the new roots rather than the previous set. A no-op when the roots are
 * unchanged, so repeated calls in the same directory add no round-trips.
 */
export function createRootsAwareBridgeClient(client: Client): RootsAwareClient {
  let currentRoots: Array<{ uri: string; name: string }> = [];
  let confirmedRoots: Array<{ uri: string; name: string }> | null = [];
  let onRootsFetched: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  let callQueue = Promise.resolve();

  client.setRequestHandler(ListRootsRequestSchema, () => {
    const notify = onRootsFetched;
    onRootsFetched = null;
    if (notify) {
      setImmediate(() => {
        void client.ping().then(notify.resolve, notify.reject);
      });
    }
    return { roots: currentRoots };
  });

  async function applyRootsNow(dirs: string[]): Promise<void> {
    const next = toRoots(dirs);
    if (confirmedRoots && rootUrisEqual(next, confirmedRoots)) return;
    confirmedRoots = null;
    currentRoots = next;
    let waiter:
      | { resolve: () => void; reject: (error: unknown) => void }
      | undefined;
    const fetched = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      onRootsFetched = waiter;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await client.notification({
            method: "notifications/roots/list_changed",
          });
          await fetched;
        })(),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for roots negotiation")),
            ROOTS_FETCH_WAIT_MS,
          );
        }),
      ]);
      confirmedRoots = next;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onRootsFetched === waiter) onRootsFetched = null;
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = callQueue.then(operation);
    callQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    listTools: () => client.listTools(),
    callTool: (request, roots) =>
      enqueue(async () => {
        if (roots) await applyRootsNow(roots);
        return client.callTool(request);
      }),
    close: () => client.close(),
    applyRoots: (dirs) => enqueue(() => applyRootsNow(dirs)),
  };
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
  // Connect the MCP transport (which spawns chrome-devtools-mcp and launches
  // Chrome) before binding the port. A same-session bind race then self-heals:
  // both racers finish booting before listen(), so the loser's EADDRINUSE exit
  // finds the winner already deep-healthy and reuses it instead of failing. The
  // trade-off is one wasted Chrome launch on a genuine cross-session collision,
  // a rare and self-correcting path.
  const transport = createTransport();
  const client = createBridgeClient();
  const bridgeClient = createRootsAwareBridgeClient(client);
  await client.connect(transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  const sessionName = resolveSessionName();
  const server = createBridgeServer(bridgeClient, sessionName);
  server.on("error", (error: NodeJS.ErrnoException) => {
    handleBridgeServerError(error, port);
  });
  server.listen(port, "127.0.0.1", () => {
    writePidFile(port);
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removePidFile();
    await closeServer(server);
    await client.close();
    await transport.close();
    process.exit(0);
  };

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
