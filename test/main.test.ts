import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    vi.unstubAllGlobals();
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
        callTool.mockResolvedValue(
          tool === "take_screenshot"
            ? `Saved screenshot to ${(args as { filePath: string }).filePath}.`
            : "",
        );
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
    callTool.mockResolvedValueOnce(
      `Saved screenshot to ${resolve(process.cwd(), "./shot.png")}.`,
    );

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

  it.each([
    { dir: "down", method: "scrollBy", coords: [0, 500] },
    { dir: "up", method: "scrollBy", coords: [0, -500] },
    { dir: "top", method: "scrollTo", coords: [0, 0] },
    { dir: "bottom", method: "scrollTo", coords: [0, 1234] },
  ])(
    "scroll $dir sends a callable that scrolls the window exactly once",
    async ({ dir, method, coords }) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      callTool.mockResolvedValue("");

      await main(["scroll", dir]);

      expect(callTool.mock.calls.map(([tool]) => tool)).toEqual([
        "evaluate_script",
        "evaluate_script",
        "take_snapshot",
        "evaluate_script",
      ]);
      const scrolls: Array<[string, number, number]> = [];
      vi.stubGlobal("window", {
        scrollBy: (x: number, y: number) => scrolls.push(["scrollBy", x, y]),
        scrollTo: (x: number, y: number) => scrolls.push(["scrollTo", x, y]),
      });
      vi.stubGlobal("document", { body: { scrollHeight: 1234 } });

      const compiled = new Function(
        `return (${callTool.mock.calls[0][1].function})`,
      )();
      expect(typeof compiled).toBe("function");
      compiled();
      expect(scrolls).toEqual([[method, ...coords]]);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("wait <ms> sends a callable whose promise settles after the delay", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValue("");

    await main(["wait", "500"]);

    expect(callTool.mock.calls.map(([tool]) => tool)).toEqual([
      "evaluate_script",
    ]);
    const timers: Array<{ fire: () => void; ms: number }> = [];
    vi.stubGlobal("setTimeout", (fire: () => void, ms: number) => {
      timers.push({ fire, ms });
      return timers.length;
    });

    const compiled = new Function(
      `return (${callTool.mock.calls[0][1].function})`,
    )();
    expect(typeof compiled).toBe("function");
    const pending = compiled();
    vi.unstubAllGlobals();
    expect(pending).toBeInstanceOf(Promise);
    expect(timers.map((t) => t.ms)).toEqual([500]);
    timers[0].fire();
    await expect(pending).resolves.toBeUndefined();
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
      ["evaluate_script", expect.any(Object)],
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
      ["evaluate_script", expect.any(Object)],
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
    callTool.mockResolvedValueOnce("Saved screenshot to /caller/dir/shot.png.");

    await main(["screenshot", "./shot.png"]);

    const expected = resolve("/caller/dir", "./shot.png");
    expect(callTool).toHaveBeenCalledWith("take_screenshot", {
      filePath: expected,
    });
    expect(String(write.mock.calls[0]?.[0])).toContain(expected);
  });

  it("fails when MCP does not report a saved screenshot path", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce(
      "Took a screenshot of the current page's viewport.",
    );

    await main(["screenshot", "./shot.png"]);

    expect(callTool).toHaveBeenCalledWith("take_screenshot", {
      filePath: resolve(process.cwd(), "./shot.png"),
    });
    expect(process.exitCode).toBe(1);
    expect(decode(String(write.mock.calls[0]?.[0]))).toEqual({
      error: "chrome-devtools-mcp did not report a saved screenshot path",
      code: "BROWSER_ERROR",
    });
  });

  it.each([
    { format: undefined, input: "shot.png", output: "shot.webp" },
    { format: "jpeg", input: "shot.webp", output: "shot.jpeg" },
    { format: "webp", input: "shot.jpeg", output: "shot.webp" },
    { format: undefined, input: "shot\nname.png", output: "shot\nname.webp" },
  ])(
    "reports the canonical MCP saved path for format $format",
    async ({ format, input, output }) => {
      const directory = mkdtempSync(
        join(tmpdir(), "chrome-devtools-axi-shot-"),
      );
      try {
        const targetDirectory = join(directory, "target");
        const linkedDirectory = join(directory, "linked");
        mkdirSync(targetDirectory);
        symlinkSync(targetDirectory, linkedDirectory);
        vi.spyOn(process, "cwd").mockReturnValue(directory);
        const write = vi
          .spyOn(process.stdout, "write")
          .mockImplementation(() => true);
        callTool.mockImplementationOnce(async (tool, args) => {
          expect(tool).toBe("take_screenshot");
          const requested = (args as { filePath: string }).filePath;
          expect(requested).toBe(resolve(directory, "linked", input));
          const written = join(realpathSync(linkedDirectory), output);
          writeFileSync(written, "fake-screenshot");
          return `Took a screenshot of the current page's viewport.\nSaved screenshot to ${written}.`;
        });

        const argv = ["screenshot", join("linked", input)];
        if (format) argv.push("--format", format);
        await main(argv);

        const requested = resolve(directory, "linked", input);
        const written = join(realpathSync(linkedDirectory), output);
        expect(existsSync(written)).toBe(true);
        expect(callTool).toHaveBeenCalledWith("take_screenshot", {
          filePath: requested,
          ...(format ? { format } : {}),
        });
        expect(decode(String(write.mock.calls[0]?.[0]))).toEqual({
          screenshot: written,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("passes absolute screenshot paths through unchanged", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce("Saved screenshot to /tmp/shot.png.");

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

describe("closepage observation gate", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let tmpHome = "";

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-safe-close-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "safe-close";
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

  function captureOutput() {
    return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  }

  function closeObservation(write: ReturnType<typeof captureOutput>): string {
    const output = write.mock.calls.map(([value]) => String(value)).join("\n");
    const token = output.match(/closeObservation:\s*([^\s]+)/)?.[1];
    if (!token)
      throw new Error("pages output did not contain closeObservation");
    return token;
  }

  const listed = [
    "## Pages",
    "0: User work (https://example.com/work)",
    "1: Smoke (https://example.com/smoke) [selected]",
    "2: Notes (https://example.com/notes)",
  ].join("\n");

  it("names the observation flag when the page id is missing", async () => {
    const write = captureOutput();

    await main(["closepage"]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "closepage <id> --observation <token>",
    );
    expect(process.exitCode).toBe(2);
  });

  it("requires the observation token", async () => {
    const write = captureOutput();

    await main(["closepage", "1"]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "Missing page-list observation token",
    );
    expect(process.exitCode).toBe(2);
  });

  it("refuses to close when pages was not run first", async () => {
    const write = captureOutput();

    await main([
      "closepage",
      "1",
      "--observation",
      "00000000-0000-0000-0000-000000000000",
    ]);

    expect(callTool).not.toHaveBeenCalled();
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "No unconsumed page-list observation",
    );
    expect(process.exitCode).toBe(2);
  });

  it("closes one target when the complete page list is unchanged", async () => {
    const write = captureOutput();
    callTool
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce("");

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "1", "--observation", token]);

    expect(callTool.mock.calls).toEqual([
      ["list_pages"],
      ["list_pages"],
      ["close_page", { pageId: 1 }],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts the observation flag before the page id", async () => {
    const write = captureOutput();
    callTool
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce("");

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "--observation", token, "1"]);

    expect(callTool.mock.calls).toEqual([
      ["list_pages"],
      ["list_pages"],
      ["close_page", { pageId: 1 }],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("closes the target while an unrelated tab changes URL", async () => {
    const write = captureOutput();
    const churned = [
      "## Pages",
      "0: User work (https://example.com/work#sent)",
      "1: Smoke (https://example.com/smoke) [selected]",
      "2: Notes (https://example.com/notes)",
      "3: Popup (https://example.com/popup)",
    ].join("\n");
    callTool
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(churned)
      .mockResolvedValueOnce("");

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "2", "--observation", token]);

    expect(callTool.mock.calls).toEqual([
      ["list_pages"],
      ["list_pages"],
      ["close_page", { pageId: 2 }],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("forces a new pages listing before a second close", async () => {
    const write = captureOutput();
    callTool
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce("");

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "1", "--observation", token]);
    await main(["closepage", "2", "--observation", token]);

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "No unconsumed page-list observation",
    );
    expect(process.exitCode).toBe(2);
  });

  it("rejects a token from an older pages listing", async () => {
    const write = captureOutput();
    callTool.mockResolvedValueOnce(listed).mockResolvedValueOnce(listed);

    await main(["pages"]);
    const firstToken = closeObservation(write);
    write.mockClear();
    await main(["pages"]);
    const secondToken = closeObservation(write);
    expect(secondToken).not.toBe(firstToken);
    await main(["closepage", "1", "--observation", firstToken]);

    expect(callTool.mock.calls).toEqual([["list_pages"], ["list_pages"]]);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "observation token is stale or belongs to another listing",
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects a stale id when it now resolves to another URL", async () => {
    const write = captureOutput();
    const changedTarget = [
      "## Pages",
      "0: Smoke (https://example.com/smoke) [selected]",
      "1: Notes (https://example.com/notes)",
    ].join("\n");
    callTool.mockResolvedValueOnce(listed).mockResolvedValueOnce(changedTarget);

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "1", "--observation", token]);

    expect(callTool.mock.calls).toEqual([["list_pages"], ["list_pages"]]);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "Page ID 1 no longer shows the URL listed by `pages`; nothing was closed",
    );
    expect(process.exitCode).toBe(1);
  });

  it("does not authorize an id absent from the exact observed list", async () => {
    const write = captureOutput();
    callTool.mockResolvedValueOnce(listed);

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "9", "--observation", token]);

    expect(callTool.mock.calls).toEqual([["list_pages"]]);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "Page ID 9 was not present",
    );
    expect(process.exitCode).toBe(2);
  });

  it("keeps the last-page no-op and still consumes the listing", async () => {
    const write = captureOutput();
    const one = "## Pages\n0: https://example.com/ [selected]";
    callTool.mockResolvedValueOnce(one).mockResolvedValueOnce(one);

    await main(["pages"]);
    const token = closeObservation(write);
    await main(["closepage", "0", "--observation", token]);
    await main(["closepage", "0", "--observation", token]);

    expect(callTool.mock.calls).toEqual([["list_pages"], ["list_pages"]]);
    expect(
      write.mock.calls.some(([value]) =>
        String(value).includes("cannot close the last open page"),
      ),
    ).toBe(true);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain(
      "No unconsumed page-list observation",
    );
  });
});
