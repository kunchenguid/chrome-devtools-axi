import { resolve } from "node:path";
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

  it("recovers open by creating a page when the browser is not yet connected", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    callTool
      .mockRejectedValueOnce(new CdpError("Not connected", "BROWSER_ERROR"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce('RootWebArea "Airlock"\n  uid=1 link "Sign in"');

    await main(["open", "https://airlockhq.com"]);

    expect(callTool.mock.calls).toEqual([
      ["navigate_page", { type: "url", url: "https://airlockhq.com" }],
      ["new_page", { url: "https://airlockhq.com" }],
      ["take_snapshot"],
      [
        "evaluate_script",
        {
          function: expect.stringContaining(
            "__chromeDevtoolsAxiSnapshotGeneration",
          ),
        },
      ],
    ]);
    expect(String(write.mock.calls[0]?.[0])).toContain("title: Airlock");
    expect(String(write.mock.calls[0]?.[0])).toContain(
      'url: "https://airlockhq.com"',
    );
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
