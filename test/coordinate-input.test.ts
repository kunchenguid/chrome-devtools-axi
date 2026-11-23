import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";
import { decode } from "@toon-format/toon";

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

import { getCommandHelp, main, TOP_HELP } from "../src/cli.js";
import { CdpError } from "../src/client.js";
import * as generation from "../src/generation.js";
import { isCoordinateToolUnavailable, VISION_ENV } from "../src/vision.js";

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
  tmpHome = mkdtempSync(join(tmpdir(), "axi-coordinate-input-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("CHROME_DEVTOOLS_AXI_SESSION", "coordinate-input");
  vi.stubEnv(VISION_ENV, undefined);
  vi.stubEnv("CHROME_DEVTOOLS_AXI_MCP_SERVER_URL", undefined);
  vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
});

afterEach(() => {
  callTool.mockReset();
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("click-at", () => {
  it.each([
    { argv: ["click-at", "300", "183"], args: { x: 300, y: 183 } },
    {
      argv: ["click-at", "300", "183", "--double"],
      args: { x: 300, y: 183, dblClick: true },
    },
    {
      argv: ["click-at", "--double", "0", "12.5"],
      args: { x: 0, y: 12.5, dblClick: true },
    },
    { argv: ["click-at", "1", "2", "--full"], args: { x: 1, y: 2 } },
  ])("calls click_at with $args, then snapshots", async ({ argv, args }) => {
    const output = captureStdout();
    mockBrowser({});

    await main(argv);

    expect(callTool.mock.calls[0]).toEqual(["click_at", args]);
    expect(callTool.mock.calls.map(([tool]) => tool)).toContain(
      "take_snapshot",
    );
    const text = output();
    expect(text).toContain("title: Grid page");
    expect(text).toContain("snapshot:");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    { argv: ["click-at"], error: "Missing x and/or y coordinate" },
    { argv: ["click-at", "10"], error: "Missing x and/or y coordinate" },
    { argv: ["click-at", "--double", "10"], error: "Missing x and/or y" },
    {
      argv: ["click-at", "10", "20", "30"],
      error: "Unexpected argument: 30",
    },
    {
      argv: ["click-at", "a", "20"],
      error: "Coordinates must be non-negative numbers, got a 20",
    },
    {
      argv: ["click-at", "1e3", "20"],
      error: "Coordinates must be non-negative numbers",
    },
    {
      argv: ["click-at", "0x10", "20"],
      error: "Coordinates must be non-negative numbers",
    },
    {
      argv: ["click-at", "10", "Infinity"],
      error: "Coordinates must be non-negative numbers",
    },
    { argv: ["click-at", "-5", "20"], error: "Unknown flag -5 for `click-at`" },
    {
      argv: ["click-at", "10", "20", "--triple"],
      error: "Unknown flag --triple for `click-at`",
    },
  ])("rejects $argv before calling MCP", async ({ argv, error }) => {
    const output = captureStdout();

    await main(argv);

    expect(callTool).not.toHaveBeenCalled();
    expect(output()).toContain(error);
    expect(process.exitCode).toBe(2);
  });

  const DISABLED_MESSAGES = [
    "MCP error -32602: Tool click_at disabled",
    "Tool click_at requires experimental feature --experimentalVision and is currently disabled. Enable it by running chrome-devtools start --experimentalVision=true. For more information check the README.",
    "MCP error -32602: Tool click_at not found",
  ];
  const ENVIRONMENTS = [
    {
      setup: "vision unset",
      env: {},
      hint: `Set ${VISION_ENV}=1, run \`chrome-devtools-axi stop\``,
    },
    {
      setup: "vision set after the bridge started",
      env: { [VISION_ENV]: "1" },
      hint: `The running bridge started before ${VISION_ENV}=1 was set`,
    },
    {
      setup: "shared MCP service",
      env: {
        CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "http://127.0.0.1:9333/mcp",
      },
      hint: "Restart the shared chrome-devtools-mcp service with --experimentalVision=true",
    },
  ];

  it.each(
    DISABLED_MESSAGES.flatMap((message) =>
      ENVIRONMENTS.map((environment) => ({ message, ...environment })),
    ),
  )(
    "explains how to enable coordinate tools ($setup): $message",
    async ({ message, env, hint }) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const output = captureStdout();
      callTool.mockRejectedValueOnce(new CdpError(message, "UNKNOWN"));

      await main(["click-at", "300", "183", "--double"]);

      const text = output();
      expect(text).toContain(
        "click-at needs chrome-devtools-mcp's coordinate tools",
      );
      expect(text).toContain(hint);
      expect(text).toContain(
        "Run `chrome-devtools-axi snapshot` to look for a ref",
      );
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(2);
    },
  );

  it("passes other click_at failures through unchanged", async () => {
    const output = captureStdout();
    callTool.mockRejectedValueOnce(
      new CdpError("No page is currently selected", "BROWSER_ERROR", [
        "Run `chrome-devtools-axi open <url>` to open a page",
      ]),
    );

    await main(["click-at", "300", "183"]);

    const text = output();
    expect(text).toContain("No page is currently selected");
    expect(text).not.toContain("coordinate tools");
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe("screenshot viewport", () => {
  const shot = resolve(process.cwd(), "shot.png");
  const saved = (): string => `Saved screenshot to ${shot}.`;

  it("reports the viewport size and devicePixelRatio with the saved path", async () => {
    const output = captureStdout();
    mockBrowser({
      take_screenshot: saved,
      evaluate_script: () =>
        'Script ran on page and returned:\n```json\n{"width":1280,"height":720,"devicePixelRatio":2}\n```',
    });

    await main(["screenshot", "./shot.png"]);

    expect(callTool.mock.calls.map(([tool]) => tool)).toEqual([
      "take_screenshot",
      "evaluate_script",
    ]);
    expect(decode(output())).toEqual({
      screenshot: shot,
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("sends a callable that reads the page's viewport", async () => {
    captureStdout();
    mockBrowser({ take_screenshot: saved });

    await main(["screenshot", "./shot.png"]);

    const [, args] = callTool.mock.calls.find(
      ([tool]) => tool === "evaluate_script",
    )!;
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("devicePixelRatio", 3);
    const compiled = new Function(`return (${args.function})`)();
    expect(compiled()).toEqual({
      width: 390,
      height: 844,
      devicePixelRatio: 3,
    });
  });

  it.each([
    {
      case: "a failed read",
      answer: () => {
        throw new CdpError("Navigation in progress", "BROWSER_ERROR");
      },
    },
    {
      case: "null",
      answer: () => "Script ran on page and returned:\n```json\nnull\n```",
    },
    {
      case: "a zero width",
      answer: () =>
        'Script ran on page and returned:\n```json\n{"width":0,"height":720,"devicePixelRatio":1}\n```',
    },
    {
      case: "a missing devicePixelRatio",
      answer: () =>
        'Script ran on page and returned:\n```json\n{"width":1280,"height":720}\n```',
    },
    { case: "non-JSON output", answer: () => "something else" },
  ])("still reports the saved screenshot after $case", async ({ answer }) => {
    const output = captureStdout();
    mockBrowser({ take_screenshot: saved, evaluate_script: answer });

    await main(["screenshot", "./shot.png"]);

    expect(decode(output())).toEqual({ screenshot: shot });
    expect(process.exitCode).toBeUndefined();
  });
});

describe("help", () => {
  it("lists click-at and the vision opt-in at the top level", () => {
    expect(TOP_HELP).toContain("click-at <x> <y>");
    expect(TOP_HELP).toContain(VISION_ENV);
  });

  it.each([
    { command: "click-at", text: "--double" },
    { command: "click-at", text: VISION_ENV },
    { command: "click-at", text: "devicePixelRatio" },
    { command: "screenshot", text: "devicePixelRatio" },
  ])("$command help mentions $text", ({ command, text }) => {
    expect(getCommandHelp(command)).toContain(text);
  });
});

describe("isCoordinateToolUnavailable", () => {
  it.each([
    { message: "MCP error -32602: Tool click_at disabled", expected: true },
    { message: "MCP error -32602: Tool click_at not found", expected: true },
    {
      message:
        "Tool click_at requires experimental feature --experimentalVision and is currently disabled.",
      expected: true,
    },
    { message: "MCP error -32602: Tool click disabled", expected: false },
    { message: "No page is currently selected", expected: false },
    {
      message: "Tool click_at failed\nthe button was disabled",
      expected: false,
    },
  ])("is $expected for $message", ({ message, expected }) => {
    expect(isCoordinateToolUnavailable(message)).toBe(expected);
  });
});
