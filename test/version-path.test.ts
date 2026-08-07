import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };

/**
 * Guards the property that made `chrome-devtools-axi --version` slow: the CLI
 * entry point must never pull in the heavy command graph, and the MCP SDK must
 * remain isolated to the bridge subprocess. The assertions observe the module
 * graph the ESM loader actually resolved rather than relying on timing.
 */

const ROOT = resolve(import.meta.dirname, "..");
const CLI_BIN = join(ROOT, "dist", "bin", "chrome-devtools-axi.js");
const BRIDGE_BIN = join(ROOT, "dist", "bin", "chrome-devtools-axi-bridge.js");
const TRACE_REGISTER = join(
  import.meta.dirname,
  "fixtures",
  "module-trace-register.mjs",
);

beforeAll(() => {
  // The test spawns the built CLI, so `pnpm test` on a fresh checkout has to
  // build first. CI already builds before testing, so this is usually a no-op.
  if (!existsSync(CLI_BIN) || !existsSync(BRIDGE_BIN)) {
    const built = spawnSync("pnpm", ["run", "build"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(built.status, built.stderr).toBe(0);
  }
}, 120_000);

function traceModules(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { modules: string[]; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "cdt-axi-trace-"));
  const tracePath = join(dir, "modules.txt");
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TRACE_REGISTER, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          CHROME_DEVTOOLS_AXI_MODULE_TRACE: tracePath,
        },
      },
    );
    const contents = existsSync(tracePath)
      ? readFileSync(tracePath, "utf8")
      : "";
    return {
      modules: contents.split("\n").filter(Boolean),
      status: result.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMcpModule = (url: string) => url.includes("@modelcontextprotocol");

describe("--version path", () => {
  it("prints the package version and exits 0", () => {
    const result = spawnSync(process.execPath, [CLI_BIN, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
    expect(result.stderr).toBe("");
  });

  it("does not load the MCP SDK", () => {
    const { modules } = traceModules([CLI_BIN, "--version"]);
    expect(modules.filter(isMcpModule)).toEqual([]);
    expect(modules.length).toBeGreaterThan(0);
  });

  it("loads the MCP SDK in the bridge entry point", () => {
    // Negative control: without it, a probe that silently stopped tracing would
    // pass vacuously. Point the bridge at a nonexistent MCP binary so transport
    // setup fails immediately; the SDK is imported before that failure.
    const { modules, status } = traceModules([BRIDGE_BIN], {
      CHROME_DEVTOOLS_AXI_MCP_PATH: join(tmpdir(), "no-such-mcp-binary.js"),
    });
    expect(status).not.toBe(0);
    expect(modules.filter(isMcpModule).length).toBeGreaterThan(0);
  }, 60_000);

  it("--version does not load the heavy cli.js command graph", () => {
    const { modules, status } = traceModules([CLI_BIN, "--version"]);
    expect(status).toBe(0);
    expect(
      modules.some((url) => url.endsWith("/dist/src/version.js")),
    ).toBe(true);
    expect(modules.some((url) => url.endsWith("/dist/src/cli.js"))).toBe(false);
    expect(modules.some((url) => url.includes("@toon-format"))).toBe(false);
  });

  it("loads the heavy cli.js command graph for --help", () => {
    const { modules, status } = traceModules([CLI_BIN, "--help"]);
    expect(status).toBe(0);
    expect(modules.some((url) => url.endsWith("/dist/src/cli.js"))).toBe(true);
  });

  it.each(["-v", "-V", "--version"])(
    "%s prints exactly the version and exits 0",
    (flag) => {
      const result = spawnSync(process.execPath, [CLI_BIN, flag], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${pkg.version}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it("falls through for a multi-argument version flag", () => {
    const { modules } = traceModules([CLI_BIN, "--help", "--version"]);
    expect(modules.some((url) => url.endsWith("/dist/src/cli.js"))).toBe(true);
  });
});
