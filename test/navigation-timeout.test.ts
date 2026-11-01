import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

const { callTool } = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  CdpError: class CdpError extends AxiError {
    constructor(
      message: string,
      public readonly code: string,
      public readonly suggestions: string[] = [],
    ) {
      super(message, code, suggestions);
    }
  },
  callTool,
  ensureBridge: vi.fn(),
  getSessionSnapshotIfRunning: vi.fn(),
  stopBridge: vi.fn(),
}));

import { createRootsAwareBridgeClient } from "../src/bridge.js";
import { main } from "../src/cli.js";
import {
  callRequestTimeoutMs,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MAX_NAVIGATION_TIMEOUT_MS,
  mcpRequestTimeoutMs,
  NAVIGATION_TIMEOUT_ENV,
  parseNavigationTimeoutMs,
} from "../src/navigation-timeout.js";

describe("parseNavigationTimeoutMs", () => {
  it("accepts positive integers up to the cap", () => {
    expect(parseNavigationTimeoutMs("1")).toBe(1);
    expect(parseNavigationTimeoutMs(" 60000 ")).toBe(60_000);
    expect(parseNavigationTimeoutMs(String(MAX_NAVIGATION_TIMEOUT_MS))).toBe(
      MAX_NAVIGATION_TIMEOUT_MS,
    );
  });

  it.each(["", "0", "-5", "1.5", "1e4", "abc", "10s", "0x10", "+5"])(
    "rejects %j",
    (raw) => {
      expect(parseNavigationTimeoutMs(raw)).toBeNull();
    },
  );

  it("rejects values above the cap and undefined", () => {
    expect(
      parseNavigationTimeoutMs(String(MAX_NAVIGATION_TIMEOUT_MS + 1)),
    ).toBe(null);
    expect(parseNavigationTimeoutMs(undefined)).toBeNull();
  });
});

describe("request deadlines", () => {
  it("keeps today's deadlines when no timeout is sent", () => {
    expect(mcpRequestTimeoutMs({ url: "https://example.com" })).toBe(
      DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    );
    expect(mcpRequestTimeoutMs(undefined)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(callRequestTimeoutMs({})).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });

  it.each([1, 10_000, 30_000, 60_000, 120_000, 600_000, 86_400_000])(
    "keeps the bridge deadline above a %d ms navigation timeout, and the CLI's above the bridge's",
    (timeout) => {
      const mcp = mcpRequestTimeoutMs({ timeout });
      const call = callRequestTimeoutMs({ timeout });
      expect(mcp).toBeGreaterThan(timeout);
      expect(call).toBeGreaterThan(mcp);
      expect(call).toBeLessThan(2 ** 31 - 1);
    },
  );

  it("leaves room for new_page's goto plus its event wait", () => {
    expect(mcpRequestTimeoutMs({ timeout: 120_000 })).toBeGreaterThan(240_000);
  });

  it("stays within timer range at the largest accepted timeout", () => {
    expect(
      callRequestTimeoutMs({ timeout: MAX_NAVIGATION_TIMEOUT_MS }),
    ).toBeLessThan(2 ** 31 - 1);
  });

  it("ignores a non-positive or non-numeric timeout", () => {
    for (const timeout of [0, -1, Number.NaN, "5000", null]) {
      expect(mcpRequestTimeoutMs({ timeout })).toBe(
        DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      );
    }
  });
});

describe("bridge MCP request deadline", () => {
  function makeClient() {
    const callTool = vi.fn(async () => ({ content: [] }));
    const client = {
      setRequestHandler: () => {},
      notification: async () => {},
      ping: async () => ({}),
      listTools: async () => ({ tools: [] }),
      callTool,
      close: async () => {},
    };
    return { client, callTool };
  }

  it("passes a deadline above the navigation timeout to the MCP client", async () => {
    const fake = makeClient();
    const bridge = createRootsAwareBridgeClient(fake.client as any);

    await bridge.callTool({
      name: "new_page",
      arguments: { url: "https://example.com", timeout: 90_000 },
    });

    const [, , options] = fake.callTool.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { timeout: number },
    ];
    expect(options.timeout).toBeGreaterThan(90_000);
  });

  it("keeps the SDK default deadline for calls without a timeout", async () => {
    const fake = makeClient();
    const bridge = createRootsAwareBridgeClient(fake.client as any);

    await bridge.callTool({ name: "list_pages", arguments: {} });

    const [, , options] = fake.callTool.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { timeout: number },
    ];
    expect(options.timeout).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });
});

describe("navigation --timeout", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let tmpHome = "";

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-navigation-timeout-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "navigation-timeout";
    vi.stubEnv(NAVIGATION_TIMEOUT_ENV, undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockImplementation(async (tool: string) =>
      tool === "take_snapshot" ? 'RootWebArea "Page"\n  uid=1 link "Home"' : "",
    );
  });

  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function firstCall(): unknown[] {
    return callTool.mock.calls[0] as unknown[];
  }

  it("open sends the timeout to navigate_page", async () => {
    await main(["open", "https://example.com", "--timeout", "60000"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com", timeout: 60_000 },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("open accepts the flag before the url", async () => {
    await main(["open", "--timeout", "60000", "https://example.com"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com", timeout: 60_000 },
    ]);
  });

  it("newpage sends the timeout to new_page", async () => {
    await main([
      "newpage",
      "https://example.com",
      "--background",
      "--timeout",
      "45000",
    ]);
    expect(firstCall()).toEqual([
      "new_page",
      { url: "https://example.com", background: true, timeout: 45_000 },
    ]);
  });

  it("back and reload reject --timeout and send no timeout from the environment", async () => {
    for (const command of ["back", "reload"]) {
      const write = vi.fn();
      process.exitCode = undefined;
      await main({ argv: [command, "--timeout", "30000"], stdout: { write } });
      expect(callTool).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
    vi.stubEnv(NAVIGATION_TIMEOUT_ENV, "30000");
    process.exitCode = undefined;
    await main(["back"]);
    expect(firstCall()).toEqual(["navigate_page", { type: "back" }]);
    callTool.mockClear();
    await main(["reload"]);
    expect(firstCall()).toEqual(["navigate_page", { type: "reload" }]);
  });

  it("open falls back to new_page with the same timeout", async () => {
    const { CdpError } = await import("../src/client.js");
    callTool.mockRejectedValueOnce(
      new CdpError("Not connected", "BROWSER_ERROR"),
    );
    await main(["open", "https://example.com", "--timeout", "60000"]);
    expect(callTool.mock.calls[1]).toEqual([
      "new_page",
      { url: "https://example.com", timeout: 60_000 },
    ]);
  });

  it("sends nothing extra when neither flag nor env is set", async () => {
    await main(["open", "https://example.com"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com" },
    ]);
    callTool.mockClear();
    await main(["newpage", "https://example.com"]);
    expect(firstCall()).toEqual(["new_page", { url: "https://example.com" }]);
  });

  it("uses the environment default and lets the flag override it", async () => {
    vi.stubEnv(NAVIGATION_TIMEOUT_ENV, "20000");
    await main(["open", "https://example.com"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com", timeout: 20_000 },
    ]);
    callTool.mockClear();
    await main(["open", "https://example.com", "--timeout", "70000"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com", timeout: 70_000 },
    ]);
  });

  it("treats a blank environment value as unset", async () => {
    vi.stubEnv(NAVIGATION_TIMEOUT_ENV, "  ");
    await main(["open", "https://example.com"]);
    expect(firstCall()).toEqual([
      "navigate_page",
      { type: "url", url: "https://example.com" },
    ]);
  });

  it.each([
    ["open", "https://example.com"],
    ["newpage", "https://example.com"],
  ])("%s refuses an invalid --timeout before calling MCP", async (...argv) => {
    for (const bad of ["0", "-1", "1.5", "abc", "10s", ""]) {
      const write = vi.fn();
      process.exitCode = undefined;
      await main({ argv: [...argv, "--timeout", bad], stdout: { write } });
      expect(callTool).not.toHaveBeenCalled();
      expect(write.mock.calls.map(([c]) => c).join("")).toContain(
        "Invalid --timeout",
      );
      expect(process.exitCode).toBe(2);
    }
  });

  it("refuses a --timeout with no value", async () => {
    const write = vi.fn();
    await main({
      argv: ["open", "https://example.com", "--timeout"],
      stdout: { write },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([c]) => c).join("")).toContain(
      "Missing value for --timeout",
    );
    expect(process.exitCode).toBe(2);
  });

  it("refuses an invalid environment default", async () => {
    vi.stubEnv(NAVIGATION_TIMEOUT_ENV, "soon");
    const write = vi.fn();
    await main({ argv: ["open", "https://example.com"], stdout: { write } });
    expect(callTool).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([c]) => c).join("")).toContain(
      NAVIGATION_TIMEOUT_ENV,
    );
    expect(process.exitCode).toBe(2);
  });

  it("documents the flag in command help", async () => {
    for (const command of ["open", "newpage"]) {
      const write = vi.fn();
      await main({ argv: [command, "--help"], stdout: { write } });
      expect(write.mock.calls.map(([c]) => c).join("")).toContain(
        "--timeout <ms>",
      );
    }
  });
});
