import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  buildTransportArgs,
  detectGlobalMcpPath,
  extractHostHeaderHostname,
  extractToolText,
  getErrorMessage,
  getBridgeReapReason,
  handleBridgeRequest,
  isAllowedBridgeHost,
  isRequestAllowed,
  isRequestOriginAllowed,
  handleBridgeServerError,
  isBridgeClientConnected,
  isBridgeTargetReachable,
  parseBridgeCallPayload,
  removePidFile,
  resolveBridgeScript,
  resolveTransportSpec,
  type BridgeClient,
} from "../src/bridge.js";

describe("getBridgeReapReason", () => {
  const options = { idleTimeoutMs: 100, leaseTimeoutMs: 50 };

  it("reaps an idle bridge only when no request is in flight", () => {
    expect(
      getBridgeReapReason(
        {
          nowMs: 200,
          lastLeaseMs: 190,
          lastActivityMs: 99,
          activeRequests: 0,
          ownerAlive: true,
        },
        options,
      ),
    ).toBe("idle");
    expect(
      getBridgeReapReason(
        {
          nowMs: 200,
          lastLeaseMs: 190,
          lastActivityMs: 99,
          activeRequests: 1,
          ownerAlive: true,
        },
        options,
      ),
    ).toBeNull();
  });

  it("does not reap a recent in-flight request even when the owner is dead", () => {
    expect(
      getBridgeReapReason(
        {
          nowMs: 200,
          lastLeaseMs: 149,
          lastActivityMs: 99,
          activeRequests: 1,
          oldestActiveRequestMs: 190,
          ownerAlive: false,
        },
        options,
      ),
    ).toBeNull();
  });

  it("allows a wedged request to be reaped after the hard request limit", () => {
    expect(
      getBridgeReapReason(
        {
          nowMs: 300,
          lastLeaseMs: 149,
          lastActivityMs: 99,
          activeRequests: 1,
          oldestActiveRequestMs: 100,
          ownerAlive: false,
        },
        { ...options, maxRequestMs: 100 },
      ),
    ).toBe("idle");
  });

  it("reaps after a dead owner's lease expires", () => {
    expect(
      getBridgeReapReason(
        {
          nowMs: 200,
          lastLeaseMs: 149,
          lastActivityMs: 190,
          activeRequests: 0,
          ownerAlive: false,
        },
        options,
      ),
    ).toBe("lease-expired");
  });

  it("keeps a live owner and recent bridge alive", () => {
    expect(
      getBridgeReapReason(
        {
          nowMs: 120,
          lastLeaseMs: 100,
          lastActivityMs: 100,
          activeRequests: 0,
          ownerAlive: true,
        },
        options,
      ),
    ).toBeNull();
  });
});

describe("extractToolText", () => {
  it("joins text blocks and ignores non-text content", () => {
    const result = extractToolText([
      { type: "text", text: "first" },
      { type: "image" },
      { type: "text", text: "second" },
    ]);

    expect(result).toBe("first\nsecond");
  });
});

describe("parseBridgeCallPayload", () => {
  it("defaults missing args to an empty object", () => {
    const result = parseBridgeCallPayload('{"name":"take_snapshot"}');

    expect(result).toEqual({ name: "take_snapshot", args: {} });
  });

  it("rejects payloads without a tool name", () => {
    expect(() => parseBridgeCallPayload('{"args":{}}')).toThrow(
      "Invalid bridge request payload",
    );
  });

  it("normalizes malformed JSON into a validation error", () => {
    expect(() => parseBridgeCallPayload("{")).toThrow(
      "Invalid bridge request payload",
    );
  });
});

describe("getErrorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(getErrorMessage({ reason: "boom" })).toBe("[object Object]");
  });
});

describe("resolveBridgeScript", () => {
  it("prefers the TypeScript bridge entrypoint in the repo checkout", () => {
    expect(resolveBridgeScript(import.meta.dirname)).toMatch(
      /bin\/chrome-devtools-axi-bridge\.ts$/,
    );
  });
});

describe("buildTransportArgs", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED =
      process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    savedEnv.CHROME_DEVTOOLS_AXI_CHANNEL =
      process.env.CHROME_DEVTOOLS_AXI_CHANNEL;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    delete process.env.CHROME_DEVTOOLS_AXI_CHANNEL;
  });

  afterEach(() => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED =
      savedEnv.CHROME_DEVTOOLS_AXI_HEADED;
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL =
      savedEnv.CHROME_DEVTOOLS_AXI_CHANNEL;
  });

  it("defaults to headless and isolated", () => {
    const args = buildTransportArgs();
    expect(args).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--isolated",
      "--headless",
      "--chrome-arg=--use-mock-keychain",
      "--chrome-arg=--password-store=basic",
    ]);
  });

  it("omits --headless when CHROME_DEVTOOLS_AXI_HEADED=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--isolated",
      "--chrome-arg=--use-mock-keychain",
      "--chrome-arg=--password-store=basic",
    ]);
  });

  it("forwards chrome args via --chrome-arg=", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      "--enable-gpu --ignore-gpu-blocklist";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--enable-gpu");
    expect(args).toContain("--chrome-arg=--ignore-gpu-blocklist");
  });

  it("handles tabs, newlines, and extra whitespace in chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      "  --flag-a\t--flag-b\n--flag-c  ";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--flag-a");
    expect(args).toContain("--chrome-arg=--flag-b");
    expect(args).toContain("--chrome-arg=--flag-c");
    expect(
      args.filter(
        (a) =>
          a.startsWith("--chrome-arg=") && a.startsWith("--chrome-arg=--flag"),
      ),
    ).toHaveLength(3);
  });

  it("combines headed mode with chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--enable-unsafe-webgpu";
    const args = buildTransportArgs();
    expect(args).not.toContain("--headless");
    expect(args).toContain("--chrome-arg=--enable-unsafe-webgpu");
  });

  it("uses --browserUrl when CHROME_DEVTOOLS_AXI_BROWSER_URL is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("passes chrome args alongside --browserUrl", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--some-flag";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).toContain("--chrome-arg=--some-flag");
  });

  it("uses --userDataDir when CHROME_DEVTOOLS_AXI_USER_DATA_DIR is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--isolated");
    expect(args).toContain("--headless");
  });

  it("respects headed mode with --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--headless");
  });

  it("--browserUrl takes precedence over --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("uses --autoConnect when CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("--autoConnect takes precedence over --browserUrl and --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("ignores AUTO_CONNECT when not set to '1'", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "true";
    const args = buildTransportArgs();
    expect(args).not.toContain("--autoConnect");
    expect(args).toContain("--isolated");
  });

  it("omits --channel by default", () => {
    const args = buildTransportArgs();
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("appends --channel to --autoConnect", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).toContain("--channel=beta");
  });

  it("appends --channel in the default launch mode", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--channel=beta");
    expect(args).toContain("--isolated");
    expect(args).toContain("--headless");
  });

  it("appends --channel alongside --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "canary";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).toContain("--channel=canary");
  });

  it("ignores --channel when connecting via --browserUrl", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("trims surrounding whitespace from the channel", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "  beta  ";
    const args = buildTransportArgs();
    expect(args).toContain("--channel=beta");
  });

  it("ignores a blank channel", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "   ";
    const args = buildTransportArgs();
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("routes ws:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      "ws://127.0.0.1:9222/devtools/browser/abc123";
    const args = buildTransportArgs();
    expect(args).toContain(
      "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc123",
    );
    expect(args).not.toContain(
      "--browserUrl=ws://127.0.0.1:9222/devtools/browser/abc123",
    );
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("routes wss:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).not.toContain("--browserUrl=wss://our.cluster.io/launch");
  });

  it("passes --wsHeaders when CHROME_DEVTOOLS_AXI_WS_HEADERS is set with ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).toContain('--wsHeaders={"Authorization":"Bearer token"}');
  });

  it("rejects malformed ws headers before launching the transport", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = "{";

    expect(() => buildTransportArgs()).toThrow(
      "CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON",
    );
  });

  it("rejects ws headers JSON that is not an object", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '["Authorization: Bearer token"]';

    expect(() => buildTransportArgs()).toThrow(
      "CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object",
    );
  });

  it("ignores --wsHeaders without a ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--wsHeaders="))).toBe(false);
  });
});

describe("resolveTransportSpec", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_MCP_PATH =
      process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED =
      process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to spawning via npx when MCP_PATH is unset and auto-detection finds nothing", () => {
    // Inject a probe that simulates "no global chrome-devtools-mcp" so the
    // test outcome doesn't depend on the host machine's npm install state.
    const probe = {
      existsSync: () => false,
      getNpmPrefix: () => "/usr",
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
    expect(spec.args[0]).toBe("-y");
    expect(spec.args[1]).toBe("chrome-devtools-mcp@latest");
    // Default mcp args follow
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
  });

  it("spawns node directly when CHROME_DEVTOOLS_AXI_MCP_PATH is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH =
      "/opt/mcp/build/src/bin/chrome-devtools-mcp.js";
    const spec = resolveTransportSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/opt/mcp/build/src/bin/chrome-devtools-mcp.js");
    // Strips the npx-only `-y, chrome-devtools-mcp@latest` prefix
    expect(spec.args).not.toContain("-y");
    expect(spec.args).not.toContain("chrome-devtools-mcp@latest");
    // Preserves the mcp-specific args
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
  });

  it("preserves --browserUrl when MCP_PATH and BROWSER_URL are both set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp.js";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    const spec = resolveTransportSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/opt/mcp.js");
    expect(spec.args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(spec.args).not.toContain("--isolated");
  });

  it("treats an empty MCP_PATH as unset", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "";
    const probe = {
      existsSync: () => false,
      getNpmPrefix: () => null,
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
  });

  it("auto-detects a globally-installed chrome-devtools-mcp when MCP_PATH is unset", () => {
    const probe = {
      existsSync: (path: string) =>
        path ===
        "/usr/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      getNpmPrefix: () => "/usr",
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(
      "/usr/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    );
    expect(spec.args).not.toContain("-y");
    expect(spec.args).not.toContain("chrome-devtools-mcp@latest");
    expect(spec.args).toContain("--isolated");
  });

  it("falls back to npx when auto-detection finds nothing", () => {
    const probe = {
      existsSync: () => false,
      getNpmPrefix: () => "/usr",
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
    expect(spec.args[0]).toBe("-y");
  });

  it("falls back to npx when npm prefix is unavailable", () => {
    const probe = {
      existsSync: () => true, // would match anything if asked
      getNpmPrefix: () => null,
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
  });

  it("explicit MCP_PATH always wins over auto-detection", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/explicit/override.js";
    const probe = {
      existsSync: () => true,
      getNpmPrefix: () => "/usr",
    };
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/explicit/override.js");
  });
});

describe("detectGlobalMcpPath", () => {
  it("returns the canonical MCP path when npm prefix + the file both exist", () => {
    const probe = {
      existsSync: (path: string) =>
        path ===
        "/opt/npm/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      getNpmPrefix: () => "/opt/npm",
    };

    expect(detectGlobalMcpPath(probe)).toBe(
      "/opt/npm/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    );
  });

  it("returns null when the file is missing", () => {
    const probe = {
      existsSync: () => false,
      getNpmPrefix: () => "/opt/npm",
    };

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });

  it("returns null when npm prefix is null (npm not installed)", () => {
    const probe = {
      existsSync: () => true,
      getNpmPrefix: () => null,
    };

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });

  it("returns null when npm prefix is the empty string", () => {
    const probe = {
      existsSync: () => true,
      getNpmPrefix: () => "",
    };

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });
});

describe("bridge health", () => {
  it("reports disconnected clients as unhealthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(false);
  });

  it("reports connected clients as healthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(true);
  });
});

describe("isBridgeTargetReachable", () => {
  it("returns ok when list_pages succeeds", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }) => {
        expect(name).toBe("list_pages");
        return { content: [] };
      },
      close: async () => {},
    };

    const result = await isBridgeTargetReachable(client);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with reason when the CDP target is gone", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        throw new Error("Target closed");
      },
      close: async () => {},
    };

    const result = await isBridgeTargetReachable(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Target closed");
    }
  });
});

function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  // Real requests always carry a Host header; the CLI client sends
  // "127.0.0.1:<port>". Default to loopback so the anti-rebinding gate lets
  // these through, and let callers override to exercise rejection.
  req.headers = { host: "127.0.0.1:9224", ...headers };
  // Feed a request body so handlers that read the stream (e.g. /call) don't
  // hang waiting on EOF. Rejected requests short-circuit before reading it.
  if (body !== undefined) {
    req.push(body);
    req.push(null);
  }
  return req;
}

interface CapturedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

function makeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: "",
    headers: {},
  };
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | string[]) => {
    captured.headers[String(name).toLowerCase()] = String(value);
    return origSetHeader(name, value as string);
  }) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") captured.body += chunk;
    captured.statusCode = res.statusCode;
    return res;
  }) as typeof res.end;
  return { res, captured };
}

describe("handleBridgeRequest /lease", () => {
  it("refreshes a valid lease and rejects a wrong token", async () => {
    let activity = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };

    const valid = makeResponse();
    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/lease",
        {},
        JSON.stringify({ token: "secret", ownerPid: 123 }),
      ),
      valid.res,
      undefined,
      undefined,
      {
        leaseToken: "secret",
        onActivity: () => activity++,
        onOwnerChange: (pid) => expect(pid).toBe(123),
      },
    );
    expect(valid.captured.statusCode).toBe(200);
    expect(activity).toBe(1);

    const invalid = makeResponse();
    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/lease",
        {},
        JSON.stringify({ token: "wrong", ownerPid: 123 }),
      ),
      invalid.res,
      undefined,
      undefined,
      { leaseToken: "secret" },
    );
    expect(invalid.captured.statusCode).toBe(403);
  });
});

describe("handleBridgeRequest /health", () => {
  it("returns 200 ok for shallow /health when MCP is connected", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ status: "ok" });
  });

  it("stamps the session name into the /health response when provided", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health"),
      res,
      "worker-1",
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({
      status: "ok",
      session: "worker-1",
    });
  });

  it("returns 503 when MCP server is disconnected", async () => {
    const client: BridgeClient = {
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(503);
    expect(JSON.parse(captured.body)).toMatchObject({ status: "error" });
  });

  it("returns 503 from /health?deep=1 when CDP target is unreachable", async () => {
    const client: BridgeClient = {
      // Shallow probe (listTools) passes — local MCP server is fine.
      listTools: async () => ({ tools: [] }),
      // Deep probe (list_pages) fails — attached browser is gone.
      callTool: async () => {
        throw new Error("Target closed");
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health?deep=1"),
      res,
    );

    expect(captured.statusCode).toBe(503);
    const body = JSON.parse(captured.body);
    expect(body.status).toBe("error");
    expect(body.error).toContain("CDP target unreachable");
    expect(body.reason).toContain("Target closed");
  });

  it("returns 200 from /health?deep=1 when both MCP and CDP target are healthy", async () => {
    let listPagesCalls = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }) => {
        if (name === "list_pages") listPagesCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health?deep=1"),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ status: "ok" });
    expect(listPagesCalls).toBe(1);
  });

  it("does not invoke the deep CDP probe on the shallow /health path", async () => {
    let callToolCalls = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callToolCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(200);
    expect(callToolCalls).toBe(0);
  });
});

describe("extractHostHeaderHostname", () => {
  it("drops the :port suffix from a host:port value", () => {
    expect(extractHostHeaderHostname("127.0.0.1:9224")).toBe("127.0.0.1");
    expect(extractHostHeaderHostname("localhost:9224")).toBe("localhost");
  });

  it("returns the bare hostname when no port is present", () => {
    expect(extractHostHeaderHostname("localhost")).toBe("localhost");
  });

  it("unwraps a bracketed IPv6 host, with or without a port", () => {
    expect(extractHostHeaderHostname("[::1]:9224")).toBe("::1");
    expect(extractHostHeaderHostname("[::1]")).toBe("::1");
  });

  it("keeps a bare unbracketed IPv6 literal intact", () => {
    expect(extractHostHeaderHostname("::1")).toBe("::1");
  });

  it("rejects trailing garbage after a bracketed IPv6 host", () => {
    // "[::1]evil.com" must not be read as the loopback literal "::1".
    expect(extractHostHeaderHostname("[::1]evil.com")).toBeNull();
    expect(extractHostHeaderHostname("[::1]:9224evil")).toBe("::1");
    expect(isAllowedBridgeHost("[::1]evil.com")).toBe(false);
  });

  it("returns null for an empty or whitespace-only value", () => {
    expect(extractHostHeaderHostname("")).toBeNull();
    expect(extractHostHeaderHostname("   ")).toBeNull();
  });
});

describe("isAllowedBridgeHost", () => {
  it("accepts loopback hosts (with and without port, any case)", () => {
    expect(isAllowedBridgeHost("127.0.0.1:9224")).toBe(true);
    expect(isAllowedBridgeHost("localhost:9224")).toBe(true);
    expect(isAllowedBridgeHost("LOCALHOST")).toBe(true);
    expect(isAllowedBridgeHost("[::1]:9224")).toBe(true);
    expect(isAllowedBridgeHost("::1")).toBe(true);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedBridgeHost(undefined)).toBe(false);
  });

  it("rejects a rebound attacker domain", () => {
    expect(isAllowedBridgeHost("evil.attacker.com")).toBe(false);
    expect(isAllowedBridgeHost("evil.attacker.com:9224")).toBe(false);
    // A hostname that merely embeds a loopback label must not pass.
    expect(isAllowedBridgeHost("127.0.0.1.evil.com")).toBe(false);
    expect(isAllowedBridgeHost("localhost.evil.com")).toBe(false);
  });
});

describe("isRequestOriginAllowed", () => {
  it("allows a missing Origin (the CLI client sends none)", () => {
    expect(isRequestOriginAllowed(makeRequest("POST", "/call"))).toBe(true);
  });

  it("allows an Origin whose hostname is loopback", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://127.0.0.1:9224" }),
      ),
    ).toBe(true);
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://localhost" }),
      ),
    ).toBe(true);
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://[::1]:9224" }),
      ),
    ).toBe(true);
  });

  it("rejects a present non-loopback Origin", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", {
          origin: "https://evil.attacker.com",
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unparseable Origin", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "not a url" }),
      ),
    ).toBe(false);
  });
});

describe("handleBridgeRequest anti-rebinding gate", () => {
  const client: BridgeClient = {
    listTools: async () => ({ tools: [{ name: "take_snapshot" }] }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };

  it("rejects a forged non-loopback Host with 403 on every route", async () => {
    for (const [method, url] of [
      ["GET", "/health"],
      ["GET", "/tools"],
      ["POST", "/call"],
    ] as const) {
      const { res, captured } = makeResponse();
      await handleBridgeRequest(
        client,
        makeRequest(method, url, { host: "evil.attacker.com" }),
        res,
      );
      expect(captured.statusCode).toBe(403);
      expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
    }
  });

  it("rejects a request with no Host header", async () => {
    const req = makeRequest("GET", "/health");
    delete req.headers.host;
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, req, res);

    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });

  it("rejects a forged non-loopback Origin even when Host is loopback", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("POST", "/call", {
        host: "127.0.0.1:9224",
        origin: "https://evil.attacker.com",
      }),
      res,
    );

    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });

  it("does not invoke any CDP tool when a request is rejected", async () => {
    let callToolCalls = 0;
    const spyClient: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callToolCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res } = makeResponse();

    await handleBridgeRequest(
      spyClient,
      makeRequest("POST", "/call", { host: "evil.attacker.com" }),
      res,
    );

    expect(callToolCalls).toBe(0);
  });

  it("allows a loopback Host with no Origin through to /call", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/call",
        { host: "127.0.0.1:9224" },
        JSON.stringify({ name: "take_snapshot" }),
      ),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ result: "ok" });
  });

  it("logs the refusal (host/origin/route) when a request is rejected", async () => {
    const logs: string[] = [];
    const { res } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("POST", "/call", {
        host: "evil.attacker.com",
        origin: "https://evil.attacker.com",
      }),
      res,
      undefined,
      (message) => logs.push(message),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("evil.attacker.com");
    expect(logs[0]).toContain("/call");
  });

  it("does not log when a request is allowed", async () => {
    const logs: string[] = [];
    const { res } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/tools", { host: "127.0.0.1:9224" }),
      res,
      undefined,
      (message) => logs.push(message),
    );

    expect(logs).toHaveLength(0);
  });

  it("allows a loopback Host + loopback Origin through to /tools", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/tools", {
        host: "localhost:9224",
        origin: "http://localhost:9224",
      }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(isRequestAllowed(makeRequest("GET", "/tools"))).toBe(true);
  });
});

describe("handleBridgeServerError", () => {
  function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: fn(), stderr };
    } finally {
      process.stderr.write = original;
    }
  }

  it("exits with the distinct EADDRINUSE code so ensureBridge can attribute a collision", () => {
    const exitCodes: number[] = [];
    const { stderr } = captureStderr(() =>
      handleBridgeServerError(
        Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
        9225,
        (code) => exitCodes.push(code),
      ),
    );

    expect(exitCodes).toEqual([BRIDGE_PORT_IN_USE_EXIT_CODE]);
    expect(BRIDGE_PORT_IN_USE_EXIT_CODE).not.toBe(1);
    expect(stderr).toContain("9225");
    expect(stderr).toContain("EADDRINUSE");
    expect(stderr).toContain("CHROME_DEVTOOLS_AXI_PORT");
  });

  it("exits non-zero for other fatal server errors", () => {
    const exitCodes: number[] = [];
    const { stderr } = captureStderr(() =>
      handleBridgeServerError(
        Object.assign(new Error("boom"), { code: "EACCES" }),
        9225,
        (code) => exitCodes.push(code),
      ),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr).toContain("boom");
  });
});

describe("removePidFile ownership", () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cda-pid-"));
    pidFile = join(dir, "bridge.pid");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the winner's PID file intact when a same-session loser exits", () => {
    const winnerPid = process.pid + 1;
    const loserPid = process.pid + 2;
    writeFileSync(pidFile, JSON.stringify({ pid: winnerPid, port: 9224 }));

    // The EADDRINUSE loser's exit handler must not delete the winner's handle.
    removePidFile(pidFile, loserPid);

    expect(existsSync(pidFile)).toBe(true);
  });

  it("removes the PID file when this process owns it", () => {
    const ownerPid = process.pid + 3;
    writeFileSync(pidFile, JSON.stringify({ pid: ownerPid, port: 9224 }));

    removePidFile(pidFile, ownerPid);

    expect(existsSync(pidFile)).toBe(false);
  });

  it("treats a missing or malformed PID file as nothing to remove", () => {
    expect(() => removePidFile(pidFile, process.pid)).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, "not json");
    expect(() => removePidFile(pidFile, process.pid)).not.toThrow();
    expect(existsSync(pidFile)).toBe(true);
  });
});
