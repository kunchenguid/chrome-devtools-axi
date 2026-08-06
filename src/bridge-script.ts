/**
 * Dependency-free bridge facts shared by the CLI and the bridge process.
 *
 * This module deliberately imports nothing but node builtins. `src/client.ts`
 * needs only these two symbols from the bridge, and `src/bridge.ts` statically
 * imports the MCP SDK (~45ms). Keeping them here means every CLI invocation -
 * `--version`, `--help`, every command - resolves the bridge script and the
 * port-collision exit code without loading an MCP client it never constructs.
 * `test/version-path.test.ts` guards that property.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(
    importMetaDir,
    "../bin/chrome-devtools-axi-bridge.js",
  );
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

/**
 * Distinct exit code the bridge uses for an EADDRINUSE bind failure. A generic
 * non-zero exit is ambiguous (npx/MCP launch failures exit non-zero too), so
 * `ensureBridge` keys on this sentinel to attribute an early death to a genuine
 * port collision versus a startup failure and tailor its error accordingly.
 */
export const BRIDGE_PORT_IN_USE_EXIT_CODE = 48;
