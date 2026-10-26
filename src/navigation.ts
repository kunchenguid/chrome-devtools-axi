/**
 * URL navigation for `open`, `newpage`, and the `run` helper's `page.open`.
 *
 * chrome-devtools-mcp's `new_page` creates and selects the tab, then loads
 * the URL. If the load fails (a navigation timeout, for example), the tool
 * returns only an error. The tab stays open, but the `## Pages` dump that
 * `rememberToolRouting` reads its id from is never sent. The session then
 * keeps no selection (or the previous tab's), and each retried `open` leaves
 * one more unreachable tab behind. So a tab is created on `about:blank`,
 * which loads without waiting on the network, and its id is recorded from
 * that dump. Only then is it navigated with `navigate_page`, whose failure
 * cannot lose the routing.
 *
 * `navigate_page` does not fail as an MCP error. It catches the failed
 * `goto` and returns `Unable to navigate in the selected page: <reason>.`
 * as an ordinary response line. Passing that on as success would report a
 * timed-out or unreachable page as opened, so it becomes a `CdpError` here.
 */

import { CdpError } from "./client.js";

type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<string>;

const NAVIGATION_FAILED_PREFIX = "Unable to navigate in the selected page: ";
const RECONNECT_NOTE_PREFIX = "Note: the browser was restarted or reconnected";

/**
 * The reason chrome-devtools-mcp gave for a failed `navigate_page`, or null.
 *
 * Only the first response line is read, after at most one leading reconnect
 * note. chrome-devtools-mcp writes its own text lines ahead of the
 * page-derived blocks (`## Pages` titles, dialog text), so a page cannot
 * place a line there. The URL interpolated into the line comes from the
 * caller.
 */
export function navigationFailureReason(result: string): string | null {
  const lines = result.split(/\r?\n/);
  let first = lines[0] ?? "";
  if (first.startsWith(RECONNECT_NOTE_PREFIX)) first = lines[1] ?? "";
  if (!first.startsWith(NAVIGATION_FAILED_PREFIX)) return null;
  return first.slice(NAVIGATION_FAILED_PREFIX.length).replace(/\.$/, "");
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
