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

import { getCommandHelp, main } from "../src/cli.js";
import * as generation from "../src/generation.js";

const SNAPSHOT =
  'RootWebArea "Grid page"\n  uid=1 button "Save"\n  uid=2 link "Help"';
const FRESH =
  'Script ran on page and returned:\n```json\n{"generation":7,"mutations":0}\n```';

let tmpHome = "";

/** Answer each tool the way chrome-devtools-mcp would for a healthy page. */
function mockBrowser(): void {
  callTool.mockImplementation(async (tool: string) => {
    if (tool === "take_snapshot") return SNAPSHOT;
    if (tool === "evaluate_script") return FRESH;
    return "";
  });
}

function captureStdout(): () => string {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "axi-click-double-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("CHROME_DEVTOOLS_AXI_SESSION", "click-double");
  vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
});

afterEach(() => {
  callTool.mockReset();
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("click --double", () => {
  it.each([
    { argv: ["click", "@g7:5"], dblClick: false },
    { argv: ["click", "@g7:5", "--double"], dblClick: true },
    { argv: ["click", "--double", "@g7:5"], dblClick: true },
    { argv: ["click", "@g7:5", "--full", "--double"], dblClick: true },
  ])("sends dblClick=$dblClick for $argv", async ({ argv, dblClick }) => {
    const output = captureStdout();
    mockBrowser();

    await main(argv);

    const clicks = callTool.mock.calls.filter(([tool]) => tool === "click");
    expect(clicks).toEqual([
      ["click", { uid: "5", ...(dblClick ? { dblClick: true } : {}) }],
    ]);
    expect(output()).toContain("title: Grid page");
    expect(process.exitCode).toBeUndefined();
  });

  it("still fails loud on a stale ref before clicking", async () => {
    const output = captureStdout();
    mockBrowser();

    await main(["click", "@g3:5", "--double"]);

    expect(callTool.mock.calls.map(([tool]) => tool)).not.toContain("click");
    expect(output()).toContain("STALE_REF");
    expect(process.exitCode).not.toBe(0);
  });

  it("documents --double in click help", () => {
    expect(getCommandHelp("click")).toContain("--double");
  });
});
