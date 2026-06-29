/**
 * Persistent MCP bridge server for chrome-devtools-axi.
 *
 * Spawns chrome-devtools-mcp as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok" } or 503 { status: "error", error }
 *   GET  /health?deep=1         → also verifies the attached CDP target; 503 may include reason
 *
 * Writes a PID file to ~/.chrome-devtools-axi/bridge.pid on startup.
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
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PORT = Number.parseInt(
  process.env.CHROME_DEVTOOLS_AXI_PORT ?? "9224",
  10,
);
const STATE_DIR = join(homedir(), ".chrome-devtools-axi");
const PID_FILE = join(STATE_DIR, "bridge.pid");

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
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port }));
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Already gone — fine
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

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
    writeJson(res, 200, { status: "ok" });
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

export function createBridgeServer(client: BridgeClient): Server {
  return createServer((req, res) => {
    void handleBridgeRequest(client, req, res);
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[chrome-devtools-axi] ${message}\n`);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

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

export async function runBridge(port = DEFAULT_PORT): Promise<void> {
  const transport = createTransport();
  const client = createBridgeClient();
  await client.connect(transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  const server = createBridgeServer(client);
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
