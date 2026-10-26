/**
 * Create new tabs on about:blank so MCP reports their ids before a network
 * navigation can fail. Subsequent calls then keep targeting the created tab.
 */
import { CdpError } from "./client.js";

type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<string>;

const NAVIGATION_FAILED_PREFIX = "Unable to navigate in the selected page: ";
const RECONNECT_NOTE_PREFIX = "Note: the browser was restarted or reconnected";

// MCP emits tool response lines before page-owned titles and dialog text.
// Inspect only the first line, allowing its one-shot reconnect notice.
export function navigationFailureReason(result: string): string | null {
  const lines = result.split(/\r?\n/);
  let first = lines[0] ?? "";
  if (first.startsWith(RECONNECT_NOTE_PREFIX)) first = lines[1] ?? "";
  if (!first.startsWith(NAVIGATION_FAILED_PREFIX)) return null;
  const reason = first
    .slice(NAVIGATION_FAILED_PREFIX.length)
    .replace(/\.$/, "");
  // Downloads and HTTP 204 responses abort goto without a page-load failure.
  // MCP cannot distinguish these from other cancellations; retain its result.
  return reason.startsWith("net::ERR_ABORTED at ") ? null : reason;
}

function navigationError(url: string, reason: string): CdpError {
  return new CdpError(
    `Navigation to ${url} failed: ${reason}`,
    /timeout|timed out/i.test(reason) ? "TIMEOUT" : "BROWSER_ERROR",
    [
      "The tab stays selected; run `chrome-devtools-axi snapshot` to see what loaded",
    ],
  );
}

/** Navigate the session's selected page, failing loud if the load fails. */
async function navigateSelectedPage(
  callTool: CallTool,
  url: string,
): Promise<void> {
  const result = await callTool("navigate_page", { type: "url", url });
  const reason = navigationFailureReason(result);
  if (reason !== null) throw navigationError(url, reason);
}

/**
 * Create a tab and navigate it to `url`. The tab is selected for this
 * session before the navigation starts, so even if the load fails, the
 * routing points at the tab that was created.
 */
export async function openInNewPage(
  callTool: CallTool,
  url: string,
  opts: { background?: boolean } = {},
): Promise<void> {
  const args: Record<string, unknown> = { url: "about:blank" };
  if (opts.background) args.background = true;
  await callTool("new_page", args);
  await navigateSelectedPage(callTool, url);
}

/** Whether `open` should fall back from `navigate_page` to a new tab. */
function isRecoverableOpenError(error: unknown): error is CdpError {
  if (!(error instanceof CdpError)) return false;
  if (error.code !== "BROWSER_ERROR") return false;
  return /not connected|session (?:closed|not found)|no page/i.test(
    error.message,
  );
}

/**
 * Navigate the selected page to `url`. If there is no usable page (a fresh
 * session, a reconnect, or a closed tab), open it in a new tab instead.
 */
export async function openUrl(callTool: CallTool, url: string): Promise<void> {
  let result: string;
  try {
    result = await callTool("navigate_page", { type: "url", url });
  } catch (error) {
    if (!isRecoverableOpenError(error)) throw error;
    await openInNewPage(callTool, url);
    return;
  }
  const reason = navigationFailureReason(result);
  if (reason !== null) throw navigationError(url, reason);
}
