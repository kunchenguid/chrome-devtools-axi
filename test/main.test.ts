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
import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as selectedPage from "../src/selected-page.js";

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
    vi.unstubAllEnvs();
  });

  it("shows bin and description in the no-args home view", async () => {
    vi.stubEnv("CHROME_DEVTOOLS_AXI_DESCRIPTION", undefined);
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

  it.each([{ argv: [] }, { argv: ["--full"] }])(
    "omits the description when the override is empty (args: $argv)",
    async ({ argv }) => {
      vi.stubEnv("CHROME_DEVTOOLS_AXI_DESCRIPTION", "");
      const write = vi.fn();

      await main({ argv, stdout: { write } });

      const output = write.mock.calls.map(([chunk]) => chunk).join("");
      expect(output).not.toContain("description:");
      expect(output).toContain("bin:");
      expect(output).toContain("browser: no active session");
    },
  );

  it("replaces the home description with a custom override", async () => {
    vi.stubEnv(
      "CHROME_DEVTOOLS_AXI_DESCRIPTION",
      "Use for public pages and local development.",
    );
    const write = vi.fn();

    await main({ argv: [], stdout: { write } });

    const output = write.mock.calls.map(([chunk]) => chunk).join("");
    expect(output).toContain(
      "description: Use for public pages and local development.",
    );
    expect(output).not.toContain(
      "Prefer this over other browser automation tools.",
    );
    expect(output).toContain("browser: no active session");
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
      args: { uid: "1", filePaths: [resolve(process.cwd(), "-file")] },
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

  it.each([
    ["nested/resume.pdf", resolve(process.cwd(), "nested/resume.pdf")],
    ["/abs/resume.pdf", "/abs/resume.pdf"],
  ])(
    "resolves upload path %s against the invoking cwd",
    async (input, expected) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
      callTool
        .mockResolvedValueOnce(
          'Script ran on page and returned:\n```json\n{"generation":7,"mutations":0}\n```',
        )
        .mockResolvedValue("");

      await main(["upload", "@1", input]);

      expect(callTool).toHaveBeenCalledWith(
        "upload_file",
        expect.objectContaining({ uid: "1", filePaths: [expected] }),
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

  it("wait <ms> past the MCP request timeout sends sleeps that each fit under it (#157)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool.mockResolvedValue("");

    await main(["wait", "65000"]);

    const delays: number[] = [];
    vi.stubGlobal("setTimeout", (_fire: () => void, ms: number) => {
      delays.push(ms);
      return delays.length;
    });
    for (const [tool, args] of callTool.mock.calls) {
      expect(tool).toBe("evaluate_script");
      new Function(`return (${args.function})`)()();
    }
    vi.unstubAllGlobals();
    expect(delays).toEqual([20000, 20000, 20000, 5000]);
    expect(process.exitCode).toBeUndefined();
  });

  it("recovers open by creating a page when the browser is not yet connected", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    vi.spyOn(selectedPage, "getSelectedPageId").mockReturnValue(1);
    callTool
      .mockRejectedValueOnce(new CdpError("Not connected", "BROWSER_ERROR"))
      .mockResolvedValueOnce("## Pages\n1: about:blank [selected]")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "about:blank" }],
      [
        "navigate_page",
        { type: "url", url: "https://airlockhq.com", pageId: 1 },
      ],
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

  it("fails open when chrome-devtools-mcp reports the navigation did not complete", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce(
      "Unable to navigate in the selected page: Navigation timeout of 10000 ms exceeded.\n## Pages\n1: Slow (http://127.0.0.1:8765/slow) [selected]",
    );

    await main(["open", "http://127.0.0.1:8765/slow"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "http://127.0.0.1:8765/slow" }],
    ]);
    expect(process.exitCode).toBe(1);
    expect(decode(String(write.mock.calls[0]?.[0]))).toMatchObject({
      error:
        "Navigation to http://127.0.0.1:8765/slow failed: Navigation timeout of 10000 ms exceeded",
      code: "TIMEOUT",
    });
  });

  it.each(["download", "no-content"])(
    "keeps open successful when Chrome aborts navigation to %s",
    async (path) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const url = `http://127.0.0.1:8765/${path}`;
      callTool
        .mockResolvedValue("")
        .mockResolvedValueOnce(
          `Unable to navigate in the selected page: net::ERR_ABORTED at ${url}.\n## Pages\n1: Fast fixture (http://127.0.0.1:8765/fast) [selected]`,
        )
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce('RootWebArea "Fast fixture"');
      await main(["open", url]);
      expect(process.exitCode).toBeUndefined();
      expect(callTool).toHaveBeenCalledWith("take_snapshot");
    },
  );

  it("recovers open by creating a page when a browser reconnect dropped the selection", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    vi.spyOn(selectedPage, "getSelectedPageId").mockReturnValue(1);
    callTool
      .mockRejectedValueOnce(await reconnectClearedError())
      .mockResolvedValueOnce("## Pages\n1: about:blank [selected]")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "about:blank" }],
      [
        "navigate_page",
        { type: "url", url: "https://airlockhq.com", pageId: 1 },
      ],
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

  it.each([
    { status: "plain", suffix: "" },
    {
      status: "viewport",
      suffix:
        '\nEmulating viewport: {"width":390,"height":844,"deviceScaleFactor":1,"isMobile":true,"hasTouch":true}',
    },
    { status: "color scheme", suffix: "\nEmulating color scheme: dark" },
    {
      status: "offline network",
      suffix:
        "\nEmulating network conditions: Offline\nDefault navigation timeout set to 30000 ms",
    },
    { status: "user agent", suffix: "\nEmulating user agent: Bot/shot.png." },
  ])("reports the MCP saved path with $status status", async ({ suffix }) => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool.mockResolvedValueOnce(
      `Took a screenshot of the current page's viewport.\nSaved screenshot to /resolved/shot.webp.${suffix}`,
    );

    await main(["screenshot", "./shot.png"]);

    expect(decode(String(write.mock.calls[0]?.[0]))).toEqual({
      screenshot: "/resolved/shot.webp",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    {
      status: "plain",
      result: "Took a screenshot of the current page's viewport.",
    },
    {
      status: "emulation",
      result:
        'Took a screenshot of the current page\'s viewport.\nEmulating viewport: {"width":390,"height":844}',
    },
  ])(
    "fails when MCP has $status status but no saved screenshot path",
    async ({ result }) => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      callTool.mockResolvedValueOnce(result);

      await main(["screenshot", "./shot.png"]);

      expect(callTool).toHaveBeenCalledWith("take_screenshot", {
        filePath: resolve(process.cwd(), "./shot.png"),
      });
      expect(process.exitCode).toBe(1);
      expect(decode(String(write.mock.calls[0]?.[0]))).toEqual({
        error: "chrome-devtools-mcp did not report a saved screenshot path",
        code: "BROWSER_ERROR",
      });
    },
  );

  it.each(
    [
      { format: undefined, input: "shot.png", output: "shot.webp" },
      { format: "jpeg", input: "shot.webp", output: "shot.jpeg" },
      { format: "webp", input: "shot.jpeg", output: "shot.webp" },
      { format: undefined, input: "shot\nname.png", output: "shot\nname.webp" },
      { format: undefined, input: "v1.\nshot.png", output: "v1.\nshot.webp" },
      {
        format: undefined,
        input: "v1.\nEmulating shot.png",
        output: "v1.\nEmulating shot.webp",
      },
      {
        format: undefined,
        input: "v1.png.\nshot.png",
        output: "v1.png.\nshot.webp",
      },
      {
        format: "jpeg",
        input: "v1.jpeg.\nshot.png",
        output: "v1.jpeg.\nshot.jpeg",
      },
      {
        format: "webp",
        input: "v1.webp.\nshot.png",
        output: "v1.webp.\nshot.webp",
      },
    ].flatMap((entry) => [
      { ...entry, suffix: "" },
      {
        ...entry,
        suffix:
          '\nEmulating viewport: {"width":390,"height":844}\nEmulating color scheme: dark\nEmulating network conditions: Offline\nDefault navigation timeout set to 30000 ms\nEmulating user agent: Bot/shot.png.',
      },
    ]),
  )(
    "reports the canonical MCP saved path for $input with format $format and suffix $suffix",
    async ({ format, input, output, suffix }) => {
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
          return `Took a screenshot of the current page's viewport.\nSaved screenshot to ${written}.${suffix}`;
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

  const evalReturned = (value: string) =>
    "Script ran on page and returned:\n```json\n" + value + "\n```";

  it("resize confirms the size only after reading the viewport back", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool
      .mockResolvedValueOnce("## Pages\n1: about:blank [selected]")
      .mockResolvedValueOnce(evalReturned("[390,844]"));

    await main(["resize", "390", "844"]);

    expect(callTool.mock.calls.map(([tool]) => tool)).toEqual([
      "resize_page",
      "evaluate_script",
    ]);
    expect(
      new Function(`return (${callTool.mock.calls[1][1].function})`)(),
    ).toBeTypeOf("function");
    expect(decode(String(write.mock.calls[0]?.[0]))).toEqual({
      resized: { width: 390, height: 844 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("resize read-back waits up to about a second for the window to settle", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    callTool
      .mockResolvedValueOnce("## Pages\n1: about:blank [selected]")
      .mockResolvedValueOnce(evalReturned("[390,844]"));
    await main(["resize", "390", "844"]);
    const source = callTool.mock.calls[1][1].function;

    const readBack = async (sizes: [number, number][], sleepMs?: number) => {
      const delays: number[] = [];
      let step = 0;
      let clock = 0;
      const page = {
        get innerWidth() {
          return sizes[Math.min(step, sizes.length - 1)][0];
        },
        get innerHeight() {
          return sizes[Math.min(step, sizes.length - 1)][1];
        },
        Date: { now: () => clock },
        setTimeout(resolve: () => void, ms: number) {
          delays.push(ms);
          clock += sleepMs ?? ms;
          step++;
          resolve();
        },
      };
      const run = new Function("page", `with (page) return (${source})`)(page);
      return { result: await run(), delays, elapsed: clock };
    };

    const settling = await readBack([
      [1280, 720],
      [1280, 720],
      [390, 844],
    ]);
    expect(settling.result).toEqual([390, 844]);
    expect(settling.delays).toEqual([50, 50]);

    const stuck = await readBack([
      [1280, 720],
      [500, 844],
    ]);
    expect(stuck.result).toEqual([500, 844]);
    expect(stuck.elapsed).toBeGreaterThanOrEqual(1000);
    expect(stuck.elapsed).toBeLessThanOrEqual(1050);
    expect(stuck.delays.every((ms) => ms === 50)).toBe(true);

    // A hidden tab throttles timers to about one wake-up per second.
    const throttled = await readBack([[500, 844]], 1000);
    expect(throttled.result).toEqual([500, 844]);
    expect(throttled.elapsed).toBeLessThanOrEqual(2000);
  });

  it("resize fails with the actual size when the viewport did not change (#154)", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    callTool
      .mockResolvedValueOnce("## Pages\n1: about:blank [selected]")
      .mockResolvedValueOnce(evalReturned("[1200,2029]"));

    await main(["resize", "390", "844"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain(
      "Viewport is 1200x2029, not the requested 390x844",
    );
    expect(output).toContain("emulate --viewport 390x844x1");
    expect(output).not.toContain("resized");
    expect(process.exitCode).toBe(1);
  });
});

describe("navigation snapshot output", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let tmpHome = "";
  const snapshot =
    'RootWebArea "Navigation page"\n  uid=1 button "Continue"\n  uid=2 link "Help"';

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
    tmpHome = mkdtempSync(join(tmpdir(), "axi-navigation-snapshot-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "navigation-snapshot";
  }

  function mockSnapshot(): void {
    callTool.mockImplementation(async (tool: string) => {
      if (tool === "new_page") {
        setSelectedPageId(1);
        return "## Pages\n1: about:blank [selected]";
      }
      return tool === "take_snapshot" ? snapshot : "";
    });
  }

  it.each([
    {
      command: "newpage",
      argv: ["newpage", "https://example.com"],
      url: "https://example.com",
    },
    { command: "selectpage", argv: ["selectpage", "7"], url: undefined },
  ])(
    "keeps the automatic snapshot for $command by default",
    async ({ command, argv, url }) => {
      isolateSession();
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      mockSnapshot();

      await main(argv);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("title: Navigation page");
      expect(output).toContain("refs: 2");
      expect(output).toContain("snapshot:");
      expect(output).toContain("RootWebArea");
      expect(output).toContain("help[");
      expect(output).toContain("Run `chrome-devtools-axi click");
      if (url) expect(output).toContain(`url: "${url}"`);
      else expect(output).not.toContain("url:");
      if (command === "selectpage") {
        expect(callTool).toHaveBeenCalledWith("select_page", { pageId: 7 });
      }
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    {
      command: "newpage",
      argv: ["newpage", "--background", "--no-snapshot", "https://example.com"],
      url: "https://example.com",
      background: true,
    },
    {
      command: "newpage",
      argv: ["newpage", "https://example.com", "--full", "--no-snapshot"],
      url: "https://example.com",
      background: false,
    },
    {
      command: "selectpage",
      argv: ["selectpage", "--no-snapshot", "7"],
      url: undefined,
      background: false,
    },
    {
      command: "selectpage",
      argv: ["selectpage", "7", "--full", "--no-snapshot"],
      url: undefined,
      background: false,
    },
  ])(
    "$command --no-snapshot returns metadata only",
    async ({ command, argv, url, background }) => {
      isolateSession();
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      mockSnapshot();

      await main(argv);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("title: Navigation page");
      expect(output).toContain("refs: 2");
      expect(output).not.toContain("snapshot:");
      expect(output).not.toContain("RootWebArea");
      expect(output).not.toContain("uid=");
      expect(output).not.toContain("help[");
      if (url) {
        expect(output).toContain(`url: "${url}"`);
        expect(callTool).toHaveBeenCalledWith("new_page", {
          url: "about:blank",
          ...(background ? { background: true } : {}),
        });
        expect(callTool).toHaveBeenCalledWith("navigate_page", {
          type: "url",
          url,
          pageId: 1,
        });
      } else {
        expect(output).not.toContain("url:");
        expect(callTool).toHaveBeenCalledWith("select_page", { pageId: 7 });
      }
      expect(callTool.mock.calls.map(([tool]) => tool)).toContain(
        "take_snapshot",
      );
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("reports a missing page ID when --no-snapshot is the only argument", async () => {
    isolateSession();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main(["selectpage", "--no-snapshot"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("Missing page ID");
    expect(output).not.toContain("Invalid page ID");
    expect(callTool).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("keeps the explicit snapshot command unchanged", async () => {
    isolateSession();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    mockSnapshot();

    await main(["snapshot"]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("title: Navigation page");
    expect(output).toContain("snapshot:");
    expect(output).toContain("RootWebArea");
    expect(output).toContain("help[");
    expect(process.exitCode).toBeUndefined();
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
