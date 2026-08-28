import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { IncomingMessage, ServerResponse, request } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  buildTransportArgs,
  createBridgeServer,
  createRootsAwareBridgeClient,
  detectGlobalMcpPath,
  didMcpPageIdentityChange,
  extractHostHeaderHostname,
  extractToolText,
  getErrorMessage,
  handleBridgeRequest,
  isAllowedBridgeHost,
  isRequestAllowed,
  isRequestOriginAllowed,
  isToolResultError,
  handleBridgeServerError,
  isBridgeClientConnected,
  isBridgeTargetReachable,
  PAGE_IDENTITY_CHANGED_ERROR,
  parseBridgeCallPayload,
  removePidFile,
  resolveBridgeScript,
  resolveTransportSpec,
  type BridgeClient,
} from "../src/bridge.js";
import { pathToFileURL } from "node:url";
import {
  clearSelectedPageId,
  getSelectedPageId,
  setSelectedPageId,
} from "../src/selected-page.js";

const RECONNECT_NOTICE_LINE =
  "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.";

/**
 * A chrome-devtools-mcp tool response body in the order its McpResponse
 * assembles one after a browser reconnect: the one-shot notice first, then the
 * tool's own lines, then page-derived blocks (an open dialog whose message is
 * interpolated verbatim), then `Error: <message>` last. Page ids come from a
 * process-wide counter, so a pageId issued before the reconnect fails to
 * resolve and the body carries both markers at once.
 */
function reconnectResponseBody(): string {
  return [
    RECONNECT_NOTICE_LINE,
    "## Pages",
    "0: about:blank",
    "3: https://app.example/dashboard [selected]",
    "# Open dialog",
    "alert: Saved.",
    "Call handle_dialog to handle it before continuing.",
    "Error: No page found",
  ].join("\n");
}

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

  it("parses an optional roots array of directories", () => {
    const workspaceRoot = resolve("workspace");
    const homeRoot = resolve("home", "user");
    const result = parseBridgeCallPayload(
      JSON.stringify({
        name: "take_screenshot",
        args: { filePath: join(workspaceRoot, "a.png") },
        roots: [workspaceRoot, homeRoot],
      }),
    );

    expect(result).toEqual({
      name: "take_screenshot",
      args: { filePath: join(workspaceRoot, "a.png") },
      roots: [workspaceRoot, homeRoot],
    });
  });

  it("rejects roots that are not an array of absolute paths", () => {
    expect(() =>
      parseBridgeCallPayload(
        JSON.stringify({ name: "x", roots: [resolve("workspace"), ""] }),
      ),
    ).toThrow("Invalid bridge request payload");
    expect(() => parseBridgeCallPayload('{"name":"x","roots":"/w"}')).toThrow(
      "Invalid bridge request payload",
    );
    expect(() =>
      parseBridgeCallPayload('{"name":"x","roots":["relative/path"]}'),
    ).toThrow("Invalid bridge request payload");
  });
});

describe("isToolResultError", () => {
  it("is true only when the result carries isError: true", () => {
    expect(isToolResultError({ isError: true, content: [] })).toBe(true);
    expect(isToolResultError({ isError: false, content: [] })).toBe(false);
    expect(isToolResultError({ content: [] })).toBe(false);
    expect(isToolResultError(null)).toBe(false);
    expect(isToolResultError("boom")).toBe(false);
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
  it("recognizes chrome-devtools-mcp's reconnect boundary in structured and default output", async () => {
    const result = {
      content: [{ type: "text", text: "Page ids have changed" }],
      structuredContent: { reconnected: true },
    };

    expect(didMcpPageIdentityChange(result)).toBe(true);
    expect(
      didMcpPageIdentityChange({
        content: [
          {
            type: "text",
            text: "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.",
          },
        ],
      }),
    ).toBe(true);
    expect(
      didMcpPageIdentityChange({
        ...result,
        structuredContent: { reconnected: false },
      }),
    ).toBe(false);
  });

  it("still recognizes the marker when upstream rewords its tail or renames list_pages", async () => {
    const withText = (text: string) => ({ content: [{ type: "text", text }] });

    expect(
      didMcpPageIdentityChange(
        withText(
          "Note: the browser was restarted or reconnected since the last call. Every page id was reissued. Call browser_list_pages to see the open tabs.",
        ),
      ),
    ).toBe(true);
    expect(
      didMcpPageIdentityChange(
        withText(
          "  Note: the browser was restarted or reconnected since the last call.  \n## Pages\n0: about:blank",
        ),
      ),
    ).toBe(true);
  });

  it("does not let page text that mentions a reconnect forge an identity change", async () => {
    const withText = (text: string) => ({ content: [{ type: "text", text }] });

    expect(
      didMcpPageIdentityChange(
        withText(
          'RootWebArea "status" StaticText "the browser was restarted or reconnected since the last call"',
        ),
      ),
    ).toBe(false);
    expect(
      didMcpPageIdentityChange(
        withText(
          "The page reported: Note: the browser was restarted or reconnected since the last call. Page ids have changed.",
        ),
      ),
    ).toBe(false);
  });

  it("detects the marker in a realistic reconnect response body", async () => {
    expect(
      didMcpPageIdentityChange({
        content: [{ type: "text", text: reconnectResponseBody() }],
      }),
    ).toBe(true);
  });

  it("does not let a dialog message with an embedded newline forge an identity change", async () => {
    // chrome-devtools-mcp interpolates `dialog.message()` verbatim, and a page
    // can put a raw newline in it, so alert("x\n<notice>") opens a line of its
    // own that starts with the dependency-owned clause.
    const forged = [
      "## Pages",
      "3: https://evil.example/ [selected]",
      "# Open dialog",
      "alert: x",
      `${RECONNECT_NOTICE_LINE} z.`,
      "Call handle_dialog to handle it before continuing.",
    ].join("\n");

    expect(
      didMcpPageIdentityChange({ content: [{ type: "text", text: forged }] }),
    ).toBe(false);
  });

  it("returns the page identity status when list_pages succeeds", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }) => {
        expect(name).toBe("list_pages");
        return { content: [] };
      },
      close: async () => {},
    };

    const result = await isBridgeTargetReachable(client);
    expect(result).toEqual({ ok: true, pageIdentityChanged: false });
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

  it("invalidates a named session's persisted routing when a deep probe reconnects the browser", async () => {
    const savedHome = process.env.HOME;
    const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-reconnect-health-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "reconnect-worker";
    try {
      setSelectedPageId(42);
      const client: BridgeClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({
          content: [
            {
              type: "text",
              text: "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.",
            },
          ],
        }),
        close: async () => {},
      };
      const { res, captured } = makeResponse();

      await handleBridgeRequest(
        client,
        makeRequest("GET", "/health?deep=1"),
        res,
        "reconnect-worker",
        undefined,
        clearSelectedPageId,
      );

      expect(captured.statusCode).toBe(200);
      expect(getSelectedPageId()).toBeNull();
      // The probe consumed the marker, so the response is the only way the
      // CLI can tell this cleared selection from one never made.
      expect(JSON.parse(captured.body)).toEqual({
        status: "ok",
        session: "reconnect-worker",
        pageIdentityChanged: true,
      });

      // Same reconnect, but this session had no routing to lose: reporting it
      // would invent a loss the caller never suffered.
      const second = makeResponse();
      await handleBridgeRequest(
        client,
        makeRequest("GET", "/health?deep=1"),
        second.res,
        "reconnect-worker",
        undefined,
        clearSelectedPageId,
      );

      expect(second.captured.statusCode).toBe(200);
      expect(JSON.parse(second.captured.body)).toEqual({
        status: "ok",
        session: "reconnect-worker",
      });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedSession === undefined)
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("answers 500 instead of rejecting when the identity callback throws on a deep probe", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        content: [{ type: "text", text: reconnectResponseBody() }],
      }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await expect(
      handleBridgeRequest(
        client,
        makeRequest("GET", "/health?deep=1"),
        res,
        "reconnect-throws",
        undefined,
        () => {
          throw new Error("state dir is gone");
        },
      ),
    ).resolves.toBeUndefined();

    expect(captured.statusCode).toBe(500);
    expect(JSON.parse(captured.body).error).toContain("state dir is gone");
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

describe("handleBridgeRequest /call error + roots", () => {
  it("surfaces an isError tool result as { error } so the CLI fails loudly (#96)", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: Access denied: path /home/u/a.png is not within any of the configured workspace roots.",
          },
        ],
      }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/call",
        { host: "127.0.0.1:9224" },
        JSON.stringify({ name: "take_screenshot", args: { filePath: "x" } }),
      ),
      res,
    );

    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.result).toBeUndefined();
    expect(body.error).toContain("Access denied");
  });

  it("fails an explicitly routed /call and drops the selection when a reconnect reissues page ids, but not when page text merely quotes the marker", async () => {
    const savedHome = process.env.HOME;
    const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-reconnect-call-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "reconnect-call";
    const reconnectNote =
      "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.";
    const callWith = async (
      text: string,
      args: Record<string, unknown>,
      extra: { isError?: boolean; name?: string } = {},
    ) => {
      const { name = "take_snapshot", ...resultShape } = extra;
      const client: BridgeClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({
          content: [{ type: "text", text }],
          ...resultShape,
        }),
        close: async () => {},
      };
      const { res, captured } = makeResponse();
      await handleBridgeRequest(
        client,
        makeRequest(
          "POST",
          "/call",
          { host: "127.0.0.1:9224" },
          JSON.stringify({ name, args }),
        ),
        res,
        "reconnect-call",
        undefined,
        clearSelectedPageId,
      );
      return captured;
    };

    try {
      // A page whose own text quotes the sentence must not forge an identity
      // change: only a line-anchored, dependency-emitted marker counts.
      setSelectedPageId(7);
      const spoofed = await callWith(
        `RootWebArea "evil" StaticText "${reconnectNote}"`,
        { pageId: 7 },
      );
      expect(spoofed.statusCode).toBe(200);
      expect(JSON.parse(spoofed.body).result).toContain("RootWebArea");
      expect(getSelectedPageId()).toBe(7);

      // The reconnect reissued every page id *during* this call, so content
      // fetched for the caller's explicit pageId belongs to an unknown tab.
      const genuine = await callWith(
        `${reconnectNote}\n## Pages\n0: about:blank`,
        { pageId: 7 },
      );
      expect(genuine.statusCode).toBe(200);
      expect(JSON.parse(genuine.body)).toEqual({
        error: PAGE_IDENTITY_CHANGED_ERROR,
      });
      expect(JSON.parse(genuine.body).result).toBeUndefined();
      expect(getSelectedPageId()).toBeNull();

      // `list_pages` names no page, so it targeted no particular tab and still
      // renders; only the routing is dropped. (The home view probe always
      // sends its persisted pageId, so it takes the failing branch above and
      // degrades to no page rather than rendering another tab.)
      setSelectedPageId(7);
      const unrouted = await callWith(
        `${reconnectNote}\n## Pages\n0: about:blank`,
        {},
        { name: "list_pages" },
      );
      expect(unrouted.statusCode).toBe(200);
      expect(JSON.parse(unrouted.body).result).toContain("## Pages");
      expect(getSelectedPageId()).toBeNull();

      // Page ids come from a monotonic counter, so the real reconnect path is
      // an isError body naming a missing page. The caller must learn the
      // reconnect, not go hunting for a closed tab.
      setSelectedPageId(7);
      const errored = await callWith(
        reconnectResponseBody(),
        { pageId: 7 },
        {
          isError: true,
        },
      );
      expect(errored.statusCode).toBe(200);
      expect(JSON.parse(errored.body)).toEqual({
        error: PAGE_IDENTITY_CHANGED_ERROR,
      });
      expect(getSelectedPageId()).toBeNull();

      // A dialog message can carry a raw newline, opening a line of its own
      // that starts with the dependency-owned clause. The real failure must
      // still surface and the live tab must keep its routing.
      setSelectedPageId(7);
      const forged = await callWith(
        [
          "# Open dialog",
          "alert: x",
          `${reconnectNote} z.`,
          "Call handle_dialog to handle it before continuing.",
          "Error: A dialog is open, call handle_dialog first",
        ].join("\n"),
        { pageId: 7 },
        { isError: true },
      );
      expect(forged.statusCode).toBe(200);
      expect(JSON.parse(forged.body).error).toContain("handle_dialog");
      expect(getSelectedPageId()).toBe(7);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedSession === undefined)
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("negotiates the payload's roots before invoking the tool (#96)", async () => {
    const workspaceRoot = resolve("workspace");
    const homeRoot = resolve("home", "user");
    let appliedRoots: string[] | undefined;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async (_request, roots) => {
        appliedRoots = roots;
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/call",
        { host: "127.0.0.1:9224" },
        JSON.stringify({
          name: "take_screenshot",
          args: { filePath: join(workspaceRoot, "a.png") },
          roots: [workspaceRoot, homeRoot],
        }),
      ),
      res,
    );

    expect(appliedRoots).toEqual([workspaceRoot, homeRoot]);
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ result: "ok" });
  });
});

describe("createRootsAwareBridgeClient", () => {
  function makeFakeMcpClient() {
    let rootsListHandler: (() => { roots: unknown }) | null = null;
    const notifications: Array<{ method: string }> = [];
    const client = {
      setRequestHandler: (
        _schema: unknown,
        handler: () => { roots: unknown },
      ) => {
        rootsListHandler = handler;
      },
      // Simulate chrome-devtools-mcp re-reading roots after a list_changed.
      notification: async (n: { method: string }) => {
        notifications.push(n);
        rootsListHandler?.();
      },
      ping: async () => ({}),
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    return {
      client,
      notifications,
      invokeRootsList: () => rootsListHandler?.(),
    };
  }

  it("answers roots/list with the negotiated directories as file URIs", async () => {
    const workspaceRoot = resolve("workspace");
    const outputRoot = resolve("output");
    const fake = makeFakeMcpClient();
    const rootsClient = createRootsAwareBridgeClient(fake.client as any);

    await rootsClient.applyRoots([workspaceRoot, outputRoot]);

    expect(fake.notifications).toEqual([
      { method: "notifications/roots/list_changed" },
    ]);
    expect(fake.invokeRootsList()).toEqual({
      roots: [
        {
          uri: pathToFileURL(workspaceRoot).href,
          name: "workspace",
        },
        { uri: pathToFileURL(outputRoot).href, name: "output" },
      ],
    });
  });

  it("does not re-notify when the roots are unchanged", async () => {
    const workspaceRoot = resolve("workspace");
    const fake = makeFakeMcpClient();
    const rootsClient = createRootsAwareBridgeClient(fake.client as any);

    await rootsClient.applyRoots([workspaceRoot]);
    await rootsClient.applyRoots([workspaceRoot]);

    expect(fake.notifications).toHaveLength(1);
  });

  it("retries unchanged roots after a fetch times out", async () => {
    const workspaceRoot = resolve("workspace");
    vi.useFakeTimers();
    try {
      const notifications: Array<{ method: string }> = [];
      const client = {
        setRequestHandler: () => {},
        notification: async (notification: { method: string }) => {
          notifications.push(notification);
        },
        ping: async () => ({}),
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const rootsClient = createRootsAwareBridgeClient(client as any);

      const first = expect(
        rootsClient.applyRoots([workspaceRoot]),
      ).rejects.toThrow("Timed out waiting for roots negotiation");
      await vi.advanceTimersByTimeAsync(2_000);
      await first;
      const second = expect(
        rootsClient.applyRoots([workspaceRoot]),
      ).rejects.toThrow("Timed out waiting for roots negotiation");
      await vi.advanceTimersByTimeAsync(2_000);
      await second;

      expect(notifications).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when sending the roots notification stalls", async () => {
    const workspaceRoot = resolve("workspace");
    vi.useFakeTimers();
    try {
      const client = {
        setRequestHandler: () => {},
        notification: () => new Promise<void>(() => {}),
        ping: async () => ({}),
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      const rootsClient = createRootsAwareBridgeClient(client as any);

      const negotiation = expect(
        rootsClient.applyRoots([workspaceRoot]),
      ).rejects.toThrow("Timed out waiting for roots negotiation");
      await vi.advanceTimersByTimeAsync(2_000);

      await negotiation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("renegotiates previously confirmed roots after ambiguous failure", async () => {
    const firstRoot = resolve("first-root");
    const secondRoot = resolve("second-root");
    let rootsListHandler: (() => { roots: unknown }) | null = null;
    let pingCalls = 0;
    const notifications: Array<{ method: string }> = [];
    const client = {
      setRequestHandler: (
        _schema: unknown,
        handler: () => { roots: unknown },
      ) => {
        rootsListHandler = handler;
      },
      notification: async (notification: { method: string }) => {
        notifications.push(notification);
        rootsListHandler?.();
      },
      ping: async () => {
        pingCalls += 1;
        if (pingCalls === 2) throw new Error("confirmation failed");
        return {};
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const rootsClient = createRootsAwareBridgeClient(client as any);

    await rootsClient.applyRoots([firstRoot]);
    await expect(rootsClient.applyRoots([secondRoot])).rejects.toThrow(
      "confirmation failed",
    );
    await rootsClient.applyRoots([firstRoot]);

    expect(notifications).toHaveLength(3);
  });

  it("de-duplicates repeated directories", async () => {
    const workspaceRoot = resolve("workspace");
    const homeRoot = resolve("home", "user");
    const fake = makeFakeMcpClient();
    const rootsClient = createRootsAwareBridgeClient(fake.client as any);

    await rootsClient.applyRoots([workspaceRoot, workspaceRoot, homeRoot]);

    const listed = fake.invokeRootsList() as {
      roots: Array<{ uri: string }>;
    };
    expect(listed.roots.map((r) => r.uri)).toEqual([
      pathToFileURL(workspaceRoot).href,
      pathToFileURL(homeRoot).href,
    ]);
  });

  it("keeps each roots negotiation atomic with its concurrent tool call", async () => {
    const firstRoot = resolve("first-root");
    const secondRoot = resolve("second-root");
    let rootsListHandler: (() => { roots: Array<{ uri: string }> }) | null =
      null;
    let releaseFirstCall: (() => void) | undefined;
    let firstCallStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstCallStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const observed: Array<{ name: string; roots: string[] }> = [];
    const client = {
      setRequestHandler: (
        _schema: unknown,
        handler: () => { roots: Array<{ uri: string }> },
      ) => {
        rootsListHandler = handler;
      },
      notification: async () => {
        rootsListHandler?.();
      },
      ping: async () => ({}),
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }: { name: string }) => {
        observed.push({
          name,
          roots: rootsListHandler?.().roots.map((root) => root.uri) ?? [],
        });
        if (name === "first") {
          firstCallStarted?.();
          await firstRelease;
        }
        return { content: [] };
      },
      close: async () => {},
    };
    const rootsClient = createRootsAwareBridgeClient(client as any);

    const first = rootsClient.callTool({ name: "first", arguments: {} }, [
      firstRoot,
    ]);
    await firstStarted;
    const second = rootsClient.callTool({ name: "second", arguments: {} }, [
      secondRoot,
    ]);

    expect(observed).toEqual([
      { name: "first", roots: [pathToFileURL(firstRoot).href] },
    ]);
    releaseFirstCall?.();
    await Promise.all([first, second]);
    expect(observed).toEqual([
      { name: "first", roots: [pathToFileURL(firstRoot).href] },
      { name: "second", roots: [pathToFileURL(secondRoot).href] },
    ]);
  });

  it("completes a server round trip after returning updated roots", async () => {
    const workspaceRoot = resolve("workspace");
    let rootsListHandler: (() => { roots: unknown }) | null = null;
    let rootsResponseReturned = false;
    const events: string[] = [];
    const client = {
      setRequestHandler: (
        _schema: unknown,
        handler: () => { roots: unknown },
      ) => {
        rootsListHandler = handler;
      },
      notification: async () => {
        rootsListHandler?.();
        rootsResponseReturned = true;
      },
      ping: async () => {
        expect(rootsResponseReturned).toBe(true);
        events.push("ping");
        return {};
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        events.push("tool");
        return { content: [] };
      },
      close: async () => {},
    };
    const rootsClient = createRootsAwareBridgeClient(client as any);

    await rootsClient.callTool({ name: "take_screenshot", arguments: {} }, [
      workspaceRoot,
    ]);

    expect(events).toEqual(["ping", "tool"]);
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

describe("createBridgeServer", () => {
  const postCall = (port: number, payload: unknown): Promise<string> =>
    new Promise((resolvePost, rejectPost) => {
      const body = JSON.stringify(payload);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/call",
          method: "POST",
          headers: { "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let received = "";
          res.on("data", (chunk) => {
            received += chunk;
          });
          res.on("end", () => resolvePost(received));
        },
      );
      req.on("error", rejectPost);
      req.end(body);
    });

  it("wires reconnect invalidation into the served /call route", async () => {
    const savedHome = process.env.HOME;
    const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-reconnect-server-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "reconnect-server";
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        content: [{ type: "text", text: reconnectResponseBody() }],
        isError: true,
      }),
      close: async () => {},
    };
    const server = createBridgeServer(client, "reconnect-server");
    try {
      setSelectedPageId(3);
      await new Promise<void>((ready) => {
        server.listen(0, "127.0.0.1", ready);
      });
      const { port } = server.address() as AddressInfo;

      const body = await postCall(port, {
        name: "take_snapshot",
        args: { pageId: 3 },
      });

      expect(JSON.parse(body)).toEqual({ error: PAGE_IDENTITY_CHANGED_ERROR });
      expect(getSelectedPageId()).toBeNull();
    } finally {
      await new Promise<void>((closed) => {
        server.close(() => closed());
      });
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedSession === undefined)
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
