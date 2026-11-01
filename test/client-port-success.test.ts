import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { ensureBridge, type SpawnedBridge } from "../src/client.js";
import { resolveSessionPort } from "../src/sessions.js";

vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: vi.fn(),
}));

describe("ensureBridge allowed browser endpoints", () => {
  const keys = [
    "HOME",
    "CHROME_DEVTOOLS_AXI_SESSION",
    "CHROME_DEVTOOLS_AXI_PORT",
    "CHROME_DEVTOOLS_AXI_BROWSER_URL",
    "CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
    "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL",
    "CHROME_DEVTOOLS_AXI_MCP_PATH",
  ];
  let saved: (string | undefined)[];
  let home: string;

  beforeEach(() => {
    saved = keys.map((key) => process.env[key]);
    for (const key of keys) delete process.env[key];
    home = mkdtempSync(join(process.cwd(), ".test-port-success-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    vi.mocked(request).mockReset();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { name: "default port with distinct CDP port" },
    { name: "named session port", session: "success-worker" },
    { name: "explicit port", port: "9555" },
    { name: "IPv6 loopback", browser: "http://[::1]:9224" },
    { name: "separate IPv4 loopback", browser: "http://127.0.0.2:9224" },
    { name: "auto-connect", browser: "http://127.0.0.1:9224", auto: "1" },
    {
      name: "shared MCP direct",
      browser: "http://127.0.0.1:9224",
      shared: true,
    },
    {
      name: "shared MCP proxy",
      browser: "http://127.0.0.1:9224",
      shared: true,
      proxy: true,
    },
  ])("returns the effective bridge port for $name", async (scenario) => {
    const session = scenario.session ?? "default";
    if (scenario.session) process.env.CHROME_DEVTOOLS_AXI_SESSION = session;
    if (scenario.port) process.env.CHROME_DEVTOOLS_AXI_PORT = scenario.port;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      scenario.browser ?? "http://127.0.0.1:9222";
    if (scenario.auto)
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = scenario.auto;
    if (scenario.shared) {
      process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL =
        "http://127.0.0.1:9333/mcp";
    }
    if (scenario.proxy)
      process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "mock-mcp.js";
    const expectedPort = scenario.port
      ? Number(scenario.port)
      : resolveSessionPort(session);
    const healthRequest = vi.fn((options: unknown) => {
      expect(options).toMatchObject({
        hostname: "127.0.0.1",
        port: expectedPort,
        path: "/health?deep=1",
        method: "GET",
      });
    });
    vi.mocked(request).mockImplementation(((
      options: unknown,
      callback: (response: EventEmitter) => void,
    ) => {
      healthRequest(options);
      const req = new EventEmitter();
      return Object.assign(req, {
        end() {
          const response = new EventEmitter();
          callback(response);
          response.emit("data", JSON.stringify({ status: "ok", session }));
          response.emit("end");
        },
      });
    }) as typeof request);
    const spawn = vi.fn(() => new EventEmitter() as unknown as SpawnedBridge);

    await expect(ensureBridge(spawn)).resolves.toBe(expectedPort);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expectedPort, session);
    expect(healthRequest).toHaveBeenCalledTimes(1);
  });
});
