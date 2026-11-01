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

import { main } from "../src/cli.js";

describe("newpage --context", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let tmpHome = "";

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-isolated-context-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "isolated-context";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockImplementation(async (tool: string) =>
      tool === "take_snapshot" ? 'RootWebArea "Page"\n  uid=1 link "Home"' : "",
    );
  });

  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sends the context name to new_page as isolatedContext", async () => {
    await main(["newpage", "https://example.com", "--context", "signed-out"]);
    expect(callTool.mock.calls[0]).toEqual([
      "new_page",
      { url: "https://example.com", isolatedContext: "signed-out" },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts the flag before the url and alongside other flags", async () => {
    await main([
      "newpage",
      "--context",
      "login-b",
      "--background",
      "https://example.com",
      "--timeout",
      "45000",
    ]);
    expect(callTool.mock.calls[0]).toEqual([
      "new_page",
      {
        url: "https://example.com",
        background: true,
        isolatedContext: "login-b",
        timeout: 45_000,
      },
    ]);
  });

  it("sends no isolatedContext without the flag", async () => {
    await main(["newpage", "https://example.com"]);
    expect(callTool.mock.calls[0]).toEqual([
      "new_page",
      { url: "https://example.com" },
    ]);
  });

  it.each([
    [["newpage", "https://example.com", "--context"]],
    [["newpage", "https://example.com", "--context", " "]],
    [["newpage", "https://example.com", "--context", "two words"]],
    [["newpage", "https://example.com", "--context", "x".repeat(65)]],
    [["newpage", "https://example.com", "--context", "a", "--context", "b"]],
  ])("rejects %j without calling the browser", async (argv) => {
    await main({ argv, stdout: { write: vi.fn() } });
    expect(callTool).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("is not accepted by open", async () => {
    await main({
      argv: ["open", "https://example.com", "--context", "x"],
      stdout: { write: vi.fn() },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
