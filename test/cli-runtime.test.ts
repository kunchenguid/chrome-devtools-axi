import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { installHooks, installHooksOrThrow, runAxiCli } = vi.hoisted(() => ({
  installHooks: vi.fn(),
  installHooksOrThrow: vi.fn(),
  runAxiCli: vi.fn(),
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

import { main, TOP_HELP } from "../src/cli.js";

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

  it("installs session hooks from the explicit setup command", async () => {
    await main();

    const options = vi.mocked(runAxiCli).mock.calls[0]?.[0];
    const output = await options.commands.setup(["hooks"]);

    expect(installHooksOrThrow).toHaveBeenCalledTimes(1);
    expect(output).toContain("hooks:");
    expect(output).toContain("status: installed");
    expect(output).toContain("Restart your agent session");
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
