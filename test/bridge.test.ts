import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildTransportArgs, extractToolText, getErrorMessage, isBridgeClientConnected, parseBridgeCallPayload, resolveBridgeScript } from "../src/bridge.js";

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
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
  });

  afterEach(() => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = savedEnv.CHROME_DEVTOOLS_AXI_HEADED;
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
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
