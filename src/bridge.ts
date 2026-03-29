/**
 * Persistent MCP bridge server for chrome-devtools-axi.
 *
 * Spawns chrome-devtools-mcp as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok" }
 *
 * Writes a PID file to ~/.chrome-devtools-axi/bridge.pid on startup.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PORT = Number.parseInt(process.env.CHROME_DEVTOOLS_AXI_PORT ?? "9224", 10);
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
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export async function isBridgeClientConnected(client: BridgeClient): Promise<boolean> {
  try {
    await client.listTools();
    return true;
  } catch {
    return false;
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
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
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
  if (payload.args === null || typeof payload.args !== "object" || Array.isArray(payload.args)) {
    throw new Error("Invalid bridge request payload");
  }
  return { name: payload.name, args: payload.args as Record<string, unknown> };
}

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(importMetaDir, "../bin/chrome-devtools-axi-bridge.js");
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

async function handleToolsRequest(client: BridgeClient, res: ServerResponse): Promise<void> {
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
  const result = await client.callTool({ name: payload.name, arguments: payload.args });
  writeJson(res, 200, { result: extractToolText(getToolContent(result)) });
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    if (await isBridgeClientConnected(client)) {
      writeJson(res, 200, { status: "ok" });
    } else {
      writeJson(res, 503, { error: "Not connected" });
    }
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

function createTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated"],
  });
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

  const shutdown = async () => {
    removePidFile();
    await closeServer(server);
    await client.close();
    await transport.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
