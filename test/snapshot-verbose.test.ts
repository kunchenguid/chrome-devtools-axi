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
function mockBrowser(
  overrides: Partial<
    Record<string, (args: Record<string, unknown>) => unknown>
  >,
): void {
  callTool.mockImplementation(
    async (tool: string, args: Record<string, unknown> = {}) => {
      const override = overrides[tool];
      if (override) return override(args);
      if (tool === "take_snapshot") return SNAPSHOT;
      if (tool === "evaluate_script") return FRESH;
      return "";
    },
  );
}

function captureStdout(): () => string {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "axi-snapshot-verbose-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("CHROME_DEVTOOLS_AXI_SESSION", "snapshot-verbose");
  vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
});

afterEach(() => {
  callTool.mockReset();
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("snapshot --verbose", () => {
  it.each([
    { argv: ["snapshot"], call: ["take_snapshot"] },
    {
      argv: ["snapshot", "--verbose"],
      call: ["take_snapshot", { verbose: true }],
    },
    {
      argv: ["snapshot", "--full", "--verbose"],
      call: ["take_snapshot", { verbose: true }],
    },
  ])("$argv calls $call", async ({ argv, call }) => {
    const output = captureStdout();
    mockBrowser({});

    await main(argv);

    expect(
      callTool.mock.calls.filter(([tool]) => tool === "take_snapshot"),
    ).toEqual([call]);
    expect(output()).toContain("title: Grid page");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps --verbose in the truncation hint", async () => {
    const output = captureStdout();
    const big = [
      'RootWebArea "Big"',
      ...Array.from(
        { length: 2000 },
        (_, i) => `  uid=${i} generic "cell ${i}"`,
      ),
    ].join("\n");
    mockBrowser({ take_snapshot: () => big });

    await main(["snapshot", "--verbose"]);

    expect(output()).toContain(
      "Run `chrome-devtools-axi snapshot --verbose --full`",
    );
  });

  it("documents --verbose in snapshot help", () => {
    expect(getCommandHelp("snapshot")).toContain("--verbose");
  });
});
