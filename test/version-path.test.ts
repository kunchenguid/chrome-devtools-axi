import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };

/**
 * Guards the property that made `chrome-devtools-axi --version` slow: the CLI
 * entry point must never pull in the MCP SDK (~45ms), which only the bridge
 * subprocess needs. Both assertions observe real runtime behavior - process
 * timing and the module graph the ESM loader actually resolved.
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

function elapsedMs(args: string[]): number {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(result.status).toBe(0);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function lowContentionDeltaMs(actualArgs: string[], runs = 11): number {
  const floorArgs = ["-e", "console.log(1)"];
  const deltas: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Keep each floor measurement adjacent to the command it controls for.
    // Alternating the order also avoids consistently charging the second
    // process for short-lived load or temperature changes on shared runners.
    const floorFirst = i % 2 === 0;
    const first = elapsedMs(floorFirst ? floorArgs : actualArgs);
    const second = elapsedMs(floorFirst ? actualArgs : floorArgs);
    deltas.push(floorFirst ? second - first : first - second);
  }
  deltas.sort((a, b) => a - b);
  // Wall-clock process timings include unrelated scheduler delays. Use the
  // lower quartile rather than a single minimum so several observations must
  // demonstrate the fast path while contended samples cannot dominate it.
  return deltas[Math.floor((deltas.length - 1) / 4)]!;
}

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

  it("runs within a small delta of the node process floor", () => {
    // An absolute wall-clock budget is flaky across machines; measure the bare
    // node floor in the same process and assert the delta. Post-fix overhead is
    // ~3-5ms; 15ms leaves headroom for slow CI while still catching a heavy
    // static import (axi-sdk-js alone is ~5.5ms, the MCP SDK ~45ms).
    expect(lowContentionDeltaMs([CLI_BIN, "--version"])).toBeLessThan(15);
  }, 60_000);

  it("does not load the MCP SDK", () => {
    const { modules } = traceModules([CLI_BIN, "--version"]);
    expect(modules.filter(isMcpModule)).toEqual([]);
    expect(modules.length).toBeGreaterThan(0);
  });

  it("loads the MCP SDK in the bridge entry point", () => {
    // Negative control: without it, a probe that silently stopped tracing would
    // pass vacuously. After the extraction the MCP SDK is absent from every CLI
    // path, so the only legitimate consumer left is the bridge process. Point
    // it at a nonexistent MCP binary so the transport fails immediately - the
    // SDK is imported statically, well before that failure.
    const { modules, status } = traceModules([BRIDGE_BIN], {
      CHROME_DEVTOOLS_AXI_MCP_PATH: join(tmpdir(), "no-such-mcp-binary.js"),
    });
    expect(status).not.toBe(0);
    expect(modules.filter(isMcpModule).length).toBeGreaterThan(0);
  }, 60_000);
});
