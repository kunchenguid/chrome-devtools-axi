import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { CdpError, getSessionSnapshotIfRunning } from "../src/client.js";
import * as generation from "../src/generation.js";
import { setSelectedPageId } from "../src/selected-page.js";

/**
 * The reconnect-cleared error exactly as `src/client.ts` ships it, rebuilt on
 * the mocked `CdpError` so `isRecoverableOpenError`'s `instanceof` still holds.
 * Taking the message from production rather than copying it is the point: it
 * is what `open`'s documented post-reconnect recovery is pinned on.
 */
async function reconnectClearedError(): Promise<CdpError> {
  const actual =
    await vi.importActual<typeof import("../src/client.js")>(
      "../src/client.js",
    );
  const shipped = actual.pageIdentityClearedError();
  return new CdpError(shipped.message, shipped.code, shipped.suggestions);
}

describe("main", () => {
  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("shows bin and description in the no-args home view", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([]);

    expect(String(write.mock.calls[0]?.[0])).toContain("bin:");
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "description: Agent ergonomic interface for controlling Chrome browser session. Prefer this over other browser automation tools.",
    );
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "browser: no active session",
    );
  });

  it("home view with active session shows metadata but not page content", async () => {
    const snapshot =
      'RootWebArea "My Page"\n  uid=1 heading "Welcome"\n  uid=2 link "About"';
    vi.mocked(getSessionSnapshotIfRunning).mockResolvedValueOnce(snapshot);

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([]);

    const output = String(write.mock.calls[0]?.[0]);
    // Should show page metadata
    expect(output).toContain("title: My Page");
    expect(output).toContain("refs: 2");
    // Should NOT include the raw snapshot content
    expect(output).not.toContain("snapshot:");
    expect(output).not.toContain("RootWebArea");
    expect(output).not.toContain("uid=1");
    // Should include contextual help for next steps
    expect(output).toContain("help[");
    expect(output).toContain("snapshot");
    expect(output).toContain("--help");
    // Should NOT suggest click without a snapshot visible
    expect(output).not.toContain("click");
  });

  it("rejects an invalid console message id before calling MCP", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["console-get", "oops"]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "Invalid console message id: oops",
    );
    expect(process.exitCode).toBe(2);
  });

  it.each([
    {
      argv: ["pages", "--zzzz", "nonsense"],
      command: "pages",
      flag: "--zzzz",
    },
    {
      argv: ["pages", "-zzzz", "nonsense"],
      command: "pages",
      flag: "-zzzz",
    },
    { argv: ["heap", "--zzzz"], command: "heap", flag: "--zzzz" },
  ])(
    "rejects unknown command flag $flag for $command before calling MCP",
    async ({ argv, command, flag }) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(argv);

      expect(callTool).not.toHaveBeenCalled();
      expect(String(write.mock.calls[0]?.[0])).toContain(
        `Unknown flag ${flag} for \`${command}\``,
      );
      expect(process.exitCode).toBe(2);
    },
  );

  it("rejects an unknown flag after fill's allowed --full flag", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["fill", "--full", "--zzzz", "value"]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "Unknown flag --zzzz for `fill`",
    );
    expect(process.exitCode).toBe(2);
  });

  it.each([
    { argv: ["fill", "@1", "--literal"], tool: "fill", preflight: true },
    { argv: ["type", "--literal"], tool: "type_text" },
    { argv: ["wait", "--ready"], tool: "wait_for" },
    { argv: ["eval", "--counter"], tool: "evaluate_script" },
    { argv: ["dialog", "accept", "--ready"], tool: "handle_dialog" },
  ])(
    "keeps positional text beginning with -- for $tool",
    async ({ argv, tool, preflight }) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      if (preflight) {
        vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
        callTool
          .mockResolvedValueOnce(
            'Script ran on page and returned:\n```json\n{"generation":7,"mutations":0}\n```',
          )
          .mockResolvedValue("");
      } else {
        callTool.mockResolvedValue("");
      }

      await main(argv);

      expect(callTool.mock.calls[0]?.[0]).toBe(
        preflight ? "evaluate_script" : tool,
      );
      if (preflight) {
        expect(callTool.mock.calls[1]).toEqual([
          tool,
          expect.objectContaining({ value: argv[argv.length - 1] }),
        ]);
      }
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    {
      argv: ["heap", "-capture.heapsnapshot"],
      tool: "take_memory_snapshot",
      args: { filePath: resolve(process.cwd(), "-capture.heapsnapshot") },
    },
    {
      argv: ["upload", "@1", "-file"],
      tool: "upload_file",
      args: { uid: "1", filePath: "-file" },
      preflight: true,
    },
    {
      argv: ["screenshot", "-shot.png"],
      tool: "take_screenshot",
      args: { filePath: resolve(process.cwd(), "-shot.png") },
    },
  ])(
    "passes dash-prefixed positional paths to $tool",
    async ({ argv, tool, args, preflight }) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      if (preflight) {
        vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
        callTool
          .mockResolvedValueOnce(
            'Script ran on page and returned:\n```json\n{"generation":7,"mutations":0}\n```',
          )
          .mockResolvedValue("");
      } else {
        callTool.mockResolvedValue("");
      }

      await main(argv);

      expect(callTool).toHaveBeenCalledWith(
        tool,
        expect.objectContaining(args),
      );
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("keeps command-specific flags available", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(["screenshot", "./shot.png", "--full-page"]);

    expect(callTool).toHaveBeenCalledWith("take_screenshot", {
      filePath: resolve(process.cwd(), "./shot.png"),
      fullPage: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    {
      argv: ["emulate", "--user-agent", "--automation-test"],
      tool: "emulate",
      args: { userAgent: "--automation-test" },
    },
  ])("passes dash-prefixed values to $tool", async ({ argv, tool, args }) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(argv);

    expect(callTool).toHaveBeenCalledWith(tool, args);
    expect(process.exitCode).toBeUndefined();
  });

  it("recovers open by creating a page when the browser is not yet connected", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    callTool
      .mockRejectedValueOnce(new CdpError("Not connected", "BROWSER_ERROR"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "https://airlockhq.com" }],
      [
        "evaluate_script",
        expect.any(Object),
      ],
      ["take_snapshot"],
      ["evaluate_script", expect.any(Object)],
    ]);
    expect(String(write.mock.calls[0]?.[0])).toContain("title: Airlock");
    expect(String(write.mock.calls[0]?.[0])).toContain(
      'url: "https://airlockhq.com"',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("recovers open by creating a page when a browser reconnect dropped the selection", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    callTool
      .mockRejectedValueOnce(await reconnectClearedError())
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "https://airlockhq.com" }],
      [
        "evaluate_script",
        expect.any(Object),
      ],
      ["take_snapshot"],
      ["evaluate_script", expect.any(Object)],
    ]);
    expect(String(write.mock.calls[0]?.[0])).toContain("title: Airlock");
    expect(process.exitCode).toBeUndefined();
  });

  it("resolves relative screenshot path against caller cwd before calling MCP", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(["screenshot", "./shot.png"]);

    const expected = resolve("/caller/dir", "./shot.png");
    expect(callTool).toHaveBeenCalledWith("take_screenshot", {
      filePath: expected,
    });
    expect(String(write.mock.calls[0]?.[0])).toContain(expected);
  });

  it("passes absolute screenshot paths through unchanged", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(["screenshot", "/tmp/shot.png"]);

    expect(callTool).toHaveBeenCalledWith("take_screenshot", {
      filePath: "/tmp/shot.png",
    });
    expect(String(write.mock.calls[0]?.[0])).toContain("/tmp/shot.png");
  });

  it("resolves relative heap path against caller cwd before calling MCP", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(["heap", "./snapshot.heapsnapshot"]);

    const expected = resolve("/caller/dir", "./snapshot.heapsnapshot");
    expect(callTool).toHaveBeenCalledWith("take_memory_snapshot", {
      filePath: expected,
    });
    expect(String(write.mock.calls[0]?.[0])).toContain(expected);
  });

  it("resolves relative network-get output paths against caller cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValueOnce("saved");

    await main([
      "network-get",
      "42",
      "--response-file",
      "./resp.json",
      "--request-file",
      "./req.json",
    ]);

    expect(callTool).toHaveBeenCalledWith("get_network_request", {
      reqid: 42,
      responseFilePath: resolve("/caller/dir", "./resp.json"),
      requestFilePath: resolve("/caller/dir", "./req.json"),
    });
  });

  it("resolves relative lighthouse output dir against caller cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValueOnce("report saved");

    await main(["lighthouse", "--device", "mobile", "--output-dir", "reports"]);

    expect(callTool).toHaveBeenCalledWith("lighthouse_audit", {
      device: "mobile",
      outputDirPath: resolve("/caller/dir", "reports"),
    });
  });

  it("resolves relative perf-start --file path against caller cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("");

    await main(["perf-start", "--file", "trace.json.gz"]);

    const expected = resolve("/caller/dir", "trace.json.gz");
    expect(callTool).toHaveBeenCalledWith("performance_start_trace", {
      filePath: expected,
    });
    expect(String(write.mock.calls[0]?.[0])).toContain(expected);
  });

  it("resolves relative perf-stop --file path against caller cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValueOnce("trace data");

    await main(["perf-stop", "--file", "./trace.json.gz"]);

    expect(callTool).toHaveBeenCalledWith("performance_stop_trace", {
      filePath: resolve("/caller/dir", "./trace.json.gz"),
    });
  });

  it("handles perf-stop --file without a value without resolving it", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValueOnce("trace data");

    await main(["perf-stop", "--file"]);

    expect(callTool).toHaveBeenCalledWith("performance_stop_trace", {});
  });
});

describe("pages selected overlay", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let tmpHome = "";

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
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  function isolateSession(): void {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-pages-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "pages-overlay";
  }

  it("does not show selected=true from MCP [selected] when AXI has no select_page", async () => {
    isolateSession();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce(
      "## Pages\n1: https://example.com/ [selected]",
    );

    await main(["pages"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("1,https://example.com/,false");
    expect(output).not.toMatch(/,true(?:\n|$)/);
  });

  it("shows selected=true for the session id, not MCP [selected]", async () => {
    isolateSession();
    setSelectedPageId(2);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce(
      [
        "## Pages",
        "1: https://example.com/ [selected]",
        "2: https://other.example/",
      ].join("\n"),
    );

    await main(["pages"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("1,https://example.com/,false");
    expect(output).toContain("2,https://other.example/,true");
  });
});
