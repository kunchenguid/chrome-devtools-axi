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
const TIMING_REGISTER = join(
  import.meta.dirname,
  "fixtures",
  "process-timing-register.mjs",
);
const MCP_IMPORT_ARGS = [
  "-e",
  "import('@modelcontextprotocol/sdk/client/index.js')",
];

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

function runtimeMs(args: string[]): number {
  const dir = mkdtempSync(join(tmpdir(), "cdt-axi-timing-"));
  const timingPath = join(dir, "runtime.txt");
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TIMING_REGISTER, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHROME_DEVTOOLS_AXI_PROCESS_TIMING: timingPath,
        },
      },
    );
    expect(result.status).toBe(0);
    return Number(readFileSync(timingPath, "utf8").trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lowContentionDeltaMs(
  actualArgs: string[],
  baselineArgs = ["-e", ""],
  runs = 11,
): number {
  const deltas: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Start each CPU clock inside the child after Node and the instrumentation
    // preload initialize. Parent-side spawn latency and time spent descheduled
    // are irrelevant to the CLI import path and vary dramatically when Vitest
    // workers contend in CI.
    // Keep each baseline measurement adjacent and alternate their order so any
    // remaining short-lived load does not consistently penalize one command.
    const baselineFirst = i % 2 === 0;
    const first = runtimeMs(baselineFirst ? baselineArgs : actualArgs);
    const second = runtimeMs(baselineFirst ? actualArgs : baselineArgs);
    deltas.push(baselineFirst ? second - first : first - second);
  }
  deltas.sort((a, b) => a - b);
  // CPU timings can still include short-lived host noise. Use the lower
  // quartile rather than a single minimum so several observations must
  // demonstrate the fast path while noisy samples cannot dominate it.
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

  it("runs substantially faster than loading the MCP SDK", () => {
    // An absolute wall-clock budget is flaky across machines; measure child CPU
    // time inside the child instead. Even CPU time varies between Node builds
    // and operating systems, so measure the MCP import's delta over the CLI on
    // the same runner. Adjacent, alternating samples keep changing host load
    // from consistently favoring either path. Reintroducing the SDK into the
    // CLI path removes this gap.
    const mcpImportDelta = lowContentionDeltaMs(MCP_IMPORT_ARGS, [
      CLI_BIN,
      "--version",
    ]);
    expect(mcpImportDelta).toBeGreaterThan(10);
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
