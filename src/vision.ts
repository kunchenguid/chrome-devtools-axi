/**
 * Opt-in for chrome-devtools-mcp's coordinate ("vision") tools.
 *
 * chrome-devtools-mcp registers `click_at` only when it starts with
 * `--experimentalVision=true`. The bridge appends that flag when this variable
 * is `1` (see `buildTransportArgs` in `src/bridge.ts`), and `click-at` names
 * it in its error when the running server has the tool disabled.
 *
 * This module imports nothing, so both the CLI and the bridge can share it
 * without pulling the MCP SDK into the CLI graph.
 */

export const VISION_ENV = "CHROME_DEVTOOLS_AXI_VISION";

/**
 * Whether an MCP error says `click_at` is unavailable on this server.
 *
 * chrome-devtools-mcp reports a tool held back by `--experimentalVision` as
 * `Tool click_at requires experimental feature --experimentalVision and is
 * currently disabled...`; the MCP SDK's own gate says `Tool click_at
 * disabled`, and a server that never registered it says `Tool click_at not
 * found`. Any of them means the server was started without the flag.
 */
export function isCoordinateToolUnavailable(message: string): boolean {
  return /\bTool click_at\b[^\n]*\b(?:disabled|not found)\b/.test(message);
}
