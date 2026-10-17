import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTransportArgs } from "../src/bridge.js";
import {
  CHROME_DEVTOOLS_MCP_SPEC,
  CHROME_DEVTOOLS_MCP_VERSION,
} from "../src/bridge-script.js";
import { TOP_HELP } from "../src/cli.js";
import { buildBridgeEarlyExitError } from "../src/client.js";

/**
 * The default engine fallback is `npx -y chrome-devtools-mcp@<version>`. These
 * tests tie that one pinned spec to every place that names the engine, so a
 * bump touches them all together and a floating `@latest` cannot come back.
 */

const ROOT = resolve(import.meta.dirname, "..");
const ENV_KEYS = [
  "CHROME_DEVTOOLS_AXI_MCP_PATH",
  "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL",
] as const;

describe("pinned chrome-devtools-mcp engine", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is an exact release version, never a tag or range", () => {
    expect(CHROME_DEVTOOLS_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CHROME_DEVTOOLS_MCP_SPEC).toBe(
      `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
    );
  });

  it("is what the npx fallback runs", () => {
    expect(buildTransportArgs().slice(0, 2)).toEqual([
      "-y",
      CHROME_DEVTOOLS_MCP_SPEC,
    ]);
  });

  it("is what the startup suggestions, CLI help, and README name", () => {
    const suggestions = buildBridgeEarlyExitError(
      "default",
      9224,
      1,
      null,
    ).suggestions.join("\n");
    expect(suggestions).toContain(`npx ${CHROME_DEVTOOLS_MCP_SPEC} --help`);
    expect(suggestions).toContain(`npx -y ${CHROME_DEVTOOLS_MCP_SPEC}`);
    expect(TOP_HELP).toContain(`npx -y ${CHROME_DEVTOOLS_MCP_SPEC}`);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(
      `npx -y ${CHROME_DEVTOOLS_MCP_SPEC}`,
    );
  });
});
