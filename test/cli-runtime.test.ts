import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { installHooks, installHooksOrThrow, runAxiCli } = vi.hoisted(() => ({
  installHooks: vi.fn(),
  installHooksOrThrow: vi.fn(),
  runAxiCli: vi.fn(),
}));

const { inspectBrowserSessions } = vi.hoisted(() => ({
  inspectBrowserSessions: vi.fn(),
}));

const { clientCallTool, clientEnsureBridge } = vi.hoisted(() => ({
  clientCallTool: vi.fn(),
  clientEnsureBridge: vi.fn(),
}));

vi.mock("axi-sdk-js", async () => {
  const actual =
    await vi.importActual<typeof import("axi-sdk-js")>("axi-sdk-js");
  return {
    ...actual,
    runAxiCli,
  };
});

vi.mock("../src/hooks.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/hooks.js")>("../src/hooks.js");
  return {
    ...actual,
    installHooks,
    installHooksOrThrow,
  };
});

vi.mock("../src/doctor.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/doctor.js")>(
      "../src/doctor.js",
    );
  return {
    ...actual,
    inspectBrowserSessions,
  };
});

vi.mock("../src/client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/client.js")>(
      "../src/client.js",
    );
  return {
    ...actual,
    callTool: clientCallTool,
    ensureBridge: clientEnsureBridge,
  };
});

import { main, parseRuntimeOptions, TOP_HELP } from "../src/cli.js";
import { readSessionIdleTimeoutPolicy } from "../src/session-policy.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

describe("main CLI runtime", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("documents top-level version flags in help output", () => {
    expect(TOP_HELP).toContain("--help");
    expect(TOP_HELP).toContain("-v/-V/--version");
  });

  it("documents explicit hook setup in help output", () => {
    expect(TOP_HELP).toContain("setup hooks");
    expect(TOP_HELP).not.toContain("CHROME_DEVTOOLS_AXI_DISABLE_HOOKS");
  });

  it("parses runtime options only before the command", () => {
    expect(
      parseRuntimeOptions([
        "--idle-timeout-ms=120000",
        "eval",
        "--idle-timeout-ms=literal",
      ]),
    ).toEqual({
      argv: ["eval", "--idle-timeout-ms=literal"],
      idleTimeoutMs: 120000,
      sessionStart: false,
      sessionEnd: false,
    });
  });

  it("passes bare top-level help argv through to axi-sdk-js", async () => {
    const argv = ["--help"];
    const stdout = { write: vi.fn() };

    await main({ argv, stdout });

    expect(runAxiCli).toHaveBeenCalledWith(
      expect.objectContaining({ argv, stdout }),
    );
  });

  it.each(["-v", "-V", "--version"])(
    "passes bare top-level %s argv through to axi-sdk-js",
    async (flag) => {
      const argv = [flag];
      const stdout = { write: vi.fn() };

      await main({ argv, stdout });

      expect(runAxiCli).toHaveBeenCalledWith(
        expect.objectContaining({ argv, stdout }),
      );
    },
  );

  it("delegates to axi-sdk-js runAxiCli without passing argv", async () => {
    const originalArgv = [...process.argv];
    process.argv = ["node", "chrome-devtools-axi", "snapshot"];

    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }

    expect(runAxiCli).toHaveBeenCalledTimes(1);
    expect(runAxiCli).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "Agent ergonomic interface for controlling Chrome browser session. Prefer this over other browser automation tools.",
        version: packageVersion.version,
        topLevelHelp: TOP_HELP,
      }),
    );
    expect(vi.mocked(runAxiCli).mock.calls[0]?.[0]).not.toHaveProperty("argv");
  });

  it("does not pass the removed hooks option to axi-sdk-js", async () => {
    const originalDisableHooks = process.env.CHROME_DEVTOOLS_AXI_DISABLE_HOOKS;
    process.env.CHROME_DEVTOOLS_AXI_DISABLE_HOOKS = "1";

    try {
      await main();
    } finally {
      if (originalDisableHooks === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_DISABLE_HOOKS;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_DISABLE_HOOKS = originalDisableHooks;
      }
    }

    expect(vi.mocked(runAxiCli).mock.calls[0]?.[0]).not.toHaveProperty("hooks");
  });

  it("applies a persisted agent idle policy to later browser commands", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-agent-policy-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-1";
    let observedTimeout: string | undefined;
    try {
      await main({ argv: ["--agent-session-start"] });
      clientCallTool.mockImplementationOnce(async () => {
        observedTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
        return 'RootWebArea "test"';
      });
      runAxiCli.mockImplementationOnce(async (options) => {
        await options.commands.snapshot([]);
      });
      await main({ argv: ["snapshot"] });
      expect(observedTimeout).toBe("120000");

      await main({ argv: ["--agent-session-end", "stop"] });
      observedTimeout = undefined;
      runAxiCli.mockImplementationOnce(async () => {
        observedTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      });
      await main({ argv: ["snapshot"] });
      expect(observedTimeout).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not renew a persisted policy for diagnostic commands", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-diagnostic-policy-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-diagnostic";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      await main({ argv: ["--agent-session-start"] });

      vi.setSystemTime(2_000);
      await main({ argv: ["sessions"] });

      vi.setSystemTime(121_500);
      expect(readSessionIdleTimeoutPolicy()).toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not renew a persisted policy when command help is rendered", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-command-help-policy-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-command-help";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      await main({ argv: ["--agent-session-start"] });

      vi.setSystemTime(2_000);
      await main({ argv: ["snapshot", "--help"] });

      vi.setSystemTime(121_500);
      expect(readSessionIdleTimeoutPolicy()).toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an explicit idle environment during session start", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const previousIdleTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    const home = mkdtempSync(join(tmpdir(), "axi-session-start-env-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-session-start-env";
    process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = "600000";
    let observedTimeout: string | undefined;
    try {
      runAxiCli.mockImplementationOnce(async () => {
        observedTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      });

      await main({ argv: ["--agent-session-start"] });

      expect(observedTimeout).toBe("600000");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      if (previousIdleTimeout === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = previousIdleTimeout;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an explicit idle flag during session start", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const previousIdleTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    const home = mkdtempSync(join(tmpdir(), "axi-session-start-flag-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-session-start-flag";
    delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    let observedTimeout: string | undefined;
    try {
      runAxiCli.mockImplementationOnce(async () => {
        observedTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      });

      await main({
        argv: ["--agent-session-start", "--idle-timeout-ms=600000"],
      });

      expect(observedTimeout).toBe("600000");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      if (previousIdleTimeout === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = previousIdleTimeout;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps an explicit idle timeout invocation-scoped", async () => {
    const originalHome = process.env.HOME;
    const originalSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const home = mkdtempSync(join(tmpdir(), "axi-one-shot-policy-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-one-shot";
    let observedTimeout: string | undefined;
    try {
      runAxiCli.mockImplementationOnce(async () => {
        observedTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      });
      await main({ argv: ["--idle-timeout-ms=120000", "snapshot"] });

      expect(observedTimeout).toBe("120000");
      expect(readSessionIdleTimeoutPolicy()).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = originalSession;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs session hooks from the explicit setup command", async () => {
    await main();

    const options = vi.mocked(runAxiCli).mock.calls[0]?.[0];
    const output = await options.commands.setup(["hooks"]);

    expect(installHooksOrThrow).toHaveBeenCalledTimes(1);
    expect(output).toContain("hooks:");
    expect(output).toContain("status: installed");
    expect(output).toContain("Pi");
    expect(output).toContain("Restart your agent session");
  });

  it("runs the sessions diagnostic in JSON mode without starting browser commands", async () => {
    inspectBrowserSessions.mockResolvedValueOnce({
      generatedAt: "2026-08-06T12:00:00.000Z",
      stateRoot: "/tmp/state",
      sessions: [],
    });

    await main();

    const options = vi.mocked(runAxiCli).mock.calls[0]?.[0];
    const output = await options.commands.sessions(["--json"]);

    expect(inspectBrowserSessions).toHaveBeenCalledWith({
      cleanStale: false,
      stopUnhealthy: false,
    });
    expect(JSON.parse(output)).toEqual({
      generatedAt: "2026-08-06T12:00:00.000Z",
      stateRoot: "/tmp/state",
      sessions: [],
    });
  });

  it("surfaces explicit hook setup failures", async () => {
    installHooksOrThrow.mockImplementationOnce(() => {
      throw new Error("permission denied");
    });

    await main();

    const options = vi.mocked(runAxiCli).mock.calls[0]?.[0];

    await expect(options.commands.setup(["hooks"])).rejects.toThrow(
      "permission denied",
    );
  });
});
