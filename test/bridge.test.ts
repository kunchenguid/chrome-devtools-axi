import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildTransportArgs,
  detectGlobalMcpPath,
  extractToolText,
  getErrorMessage,
  isBridgeClientConnected,
  parseBridgeCallPayload,
  resolveBridgeScript,
  resolveTransportSpec,
} from "../src/bridge.js";

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
    expect(() => parseBridgeCallPayload('{"args":{}}')).toThrow("Invalid bridge request payload");
  });

  it("normalizes malformed JSON into a validation error", () => {
    expect(() => parseBridgeCallPayload("{")).toThrow("Invalid bridge request payload");
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
    expect(resolveBridgeScript(import.meta.dirname)).toMatch(/bin\/chrome-devtools-axi-bridge\.ts$/);
  });
});

describe("buildTransportArgs", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED = process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
  });

  afterEach(() => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = savedEnv.CHROME_DEVTOOLS_AXI_HEADED;
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS;
  });

  it("defaults to headless and isolated", () => {
    const args = buildTransportArgs();
    expect(args).toEqual(["-y", "chrome-devtools-mcp@latest", "--isolated", "--headless"]);
  });

  it("omits --headless when CHROME_DEVTOOLS_AXI_HEADED=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toEqual(["-y", "chrome-devtools-mcp@latest", "--isolated"]);
  });

  it("forwards chrome args via --chrome-arg=", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--enable-gpu --ignore-gpu-blocklist";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--enable-gpu");
    expect(args).toContain("--chrome-arg=--ignore-gpu-blocklist");
  });

  it("handles tabs, newlines, and extra whitespace in chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "  --flag-a\t--flag-b\n--flag-c  ";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--flag-a");
    expect(args).toContain("--chrome-arg=--flag-b");
    expect(args).toContain("--chrome-arg=--flag-c");
    expect(args.filter((a) => a.startsWith("--chrome-arg="))).toHaveLength(3);
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

  it("routes ws:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "ws://127.0.0.1:9222/devtools/browser/abc123";
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc123");
    expect(args).not.toContain("--browserUrl=ws://127.0.0.1:9222/devtools/browser/abc123");
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
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).toContain('--wsHeaders={"Authorization":"Bearer token"}');
  });

  it("rejects malformed ws headers before launching the transport", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = "{";

    expect(() => buildTransportArgs()).toThrow("CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON");
  });

  it("rejects ws headers JSON that is not an object", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '["Authorization: Bearer token"]';

    expect(() => buildTransportArgs()).toThrow("CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object");
  });

  it("ignores --wsHeaders without a ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--wsHeaders="))).toBe(false);
  });
});

describe("resolveTransportSpec", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_MCP_PATH = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED = process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
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
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp/build/src/bin/chrome-devtools-mcp.js";
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
