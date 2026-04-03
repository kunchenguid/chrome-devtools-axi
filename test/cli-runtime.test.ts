import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runAxiCli } = vi.hoisted(() => ({
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
});
