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

/**
 * Explicit launch mode for the chrome-devtools-mcp Extensions category.
 * Extension tools are intentionally opt-in because the upstream category is
 * pipe-only and must never attach to an operator's normal Chrome/profile.
 */
export const EXTENSION_MODE_ENV = "CHROME_DEVTOOLS_AXI_EXTENSION_MODE";
export const EXTENSION_MODE = "extension" as const;
export const STANDARD_MODE = "standard" as const;
export type BridgeMode = typeof EXTENSION_MODE | typeof STANDARD_MODE;

export function isExtensionModeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[EXTENSION_MODE_ENV] === "1";
}

export function resolveBridgeMode(
  env: Record<string, string | undefined> = process.env,
): BridgeMode {
  return isExtensionModeEnabled(env) ? EXTENSION_MODE : STANDARD_MODE;
}

/**
 * Return an actionable incompatibility when extension mode is combined with a
 * browser/profile supplied by the operator. The upstream Extensions category
 * supports only a pipe-launched browser, and --isolated is the security
 * boundary that keeps extension tests away from a normal Chrome profile.
 */
export function extensionModeConflict(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isExtensionModeEnabled(env)) return null;
  if (env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1") {
    return (
      `${EXTENSION_MODE_ENV}=1 requires a pipe-launched Chrome with a temporary isolated profile; ` +
      "unset CHROME_DEVTOOLS_AXI_AUTO_CONNECT. The upstream Extensions category does not support autoConnect."
    );
  }
  if (env.CHROME_DEVTOOLS_AXI_BROWSER_URL) {
    return (
      `${EXTENSION_MODE_ENV}=1 requires a pipe-launched Chrome with a temporary isolated profile; ` +
      "unset CHROME_DEVTOOLS_AXI_BROWSER_URL. The upstream Extensions category does not support browserUrl or wsEndpoint."
    );
  }
  if (env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR) {
    return (
      `${EXTENSION_MODE_ENV}=1 requires a pipe-launched Chrome with a temporary isolated profile; ` +
      "unset CHROME_DEVTOOLS_AXI_USER_DATA_DIR so extension operations cannot mutate a normal profile."
    );
  }
  const extraChromeArgs = env.CHROME_DEVTOOLS_AXI_CHROME_ARGS?.trim()
    .split(/\s+/)
    .filter(Boolean);
  const profileOverride = extraChromeArgs?.find(
    (arg) =>
      arg === "--user-data-dir" ||
      arg.startsWith("--user-data-dir=") ||
      arg === "--profile-directory" ||
      arg.startsWith("--profile-directory="),
  );
  if (profileOverride) {
    return (
      `${EXTENSION_MODE_ENV}=1 rejects ${profileOverride} because extension mode requires a pipe-launched Chrome with a temporary isolated profile; ` +
      "remove profile-overriding CHROME_DEVTOOLS_AXI_CHROME_ARGS."
    );
  }
  return null;
}
