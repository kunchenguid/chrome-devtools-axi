/**
 * Dependency-free bridge facts shared by the CLI and the bridge process.
 *
 * This module deliberately imports nothing but node builtins. `src/client.ts`
 * needs only these few symbols from the bridge, and `src/bridge.ts` statically
 * imports the MCP SDK (~45ms). Keeping them here means every CLI invocation -
 * `--version`, `--help`, every command - resolves the bridge script, the
 * port-collision exit code and the page-identity error text without loading an
 * MCP client it never constructs.
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

/**
 * Bridge-owned error text for a call that ran against a page id space
 * chrome-devtools-mcp had just reissued. The bridge writes it verbatim as the
 * `/call` `{ error }` body and `src/client.ts` maps that exact string back to a
 * `BROWSER_ERROR` with next-step suggestions, so the two processes agree on the
 * boundary without either one parsing dependency-owned text twice.
 */
export const PAGE_IDENTITY_CHANGED_ERROR =
  "The browser reconnected and every page id changed, so this call did not target the page you selected";
