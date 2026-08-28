/**
 * Session-selected page routing. chrome-devtools-mcp 1.8+ requires `pageId`
 * on page-scoped tools; AXI injects the last page this session selected
 * rather than parsing `[selected]` out of `list_pages` (titles and dialog
 * text can forge that marker).
 *
 * Survives across short-lived CLI processes the same way the snapshot
 * generation counter does: a file in the active session's state dir.
 * `select_page` writes the caller-supplied id. `new_page` (open / newpage)
 * records the created tab when exactly one complete row in that tool's own
 * dump has a URL matching `args.url` — not a `list_pages` call, not
 * `[selected]`, and not every `N:` line after `## Pages`. Title
 * continuations, zero matches, and two matching URLs clear the session id
 * so the next page-scoped call fails loud until an explicit `select_page`.
 * Extra complete rows that do not match (for example `about:blank`) are
 * ignored. `close_page` of the selected id also clears it, and so does the
 * bridge when chrome-devtools-mcp reports a browser reconnect that reissues
 * every page id (`didMcpPageIdentityChange` in `src/bridge.ts`).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

/** Path to the active session's selected-page-id file. */
function selectedPageFile(): string {
  return join(resolveSessionStateDir(), "selected-page-id");
}

export function getSelectedPageId(): number | null {
  const file = selectedPageFile();
  try {
    if (!existsSync(file)) return null;
    const parsed = Number.parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function setSelectedPageId(pageId: number): void {
  const file = selectedPageFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(pageId));
  } catch {
    // Best-effort: a write failure still leaves this invocation with no
    // persisted id. The next process re-reads disk and fails loud rather
    // than guessing a page from `list_pages`.
  }
}

/**
 * Drop this session's routing. Returns whether a usable id was actually
 * dropped, so a caller reacting to a browser reconnect can tell a session
 * that lost its page from one that never had one. A missing or malformed
 * file counts as no routing.
 *
 * The answer is the read-back post-condition, never the pre-delete state: an
 * unlink that fails (a read-only state dir) leaves an id `getSelectedPageId`
 * still returns, so the next page-scoped call injects it. Reporting a drop
 * there would tell the bridge - and through `/health` the CLI - that routing
 * is gone while it is still resolvable, and the reconnect marker that would
 * have re-detected it is one-shot and already consumed. Reporting no drop
 * instead keeps the surviving id and the reported state in agreement: the
 * stale id fails loud on its next use (upstream issues page ids from a
 * monotonic counter, so it resolves to nothing) rather than being explained
 * away as a reconnect that dropped it.
 */
export function clearSelectedPageId(): boolean {
  const hadSelection = getSelectedPageId() !== null;
  const file = selectedPageFile();
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Fall through to the read-back: it, not this catch, decides the answer.
  }
  return hadSelection && getSelectedPageId() === null;
}

/**
 * Overlay AXI's session selected id onto display rows. MCP `[selected]`
 * text stays on the raw `list_pages` parse and must not imply routing.
 */
export function overlaySessionSelected<
  T extends { id: number; selected: boolean },
>(pages: T[], selectedId: number | null = getSelectedPageId()): T[] {
  return pages.map((page) => ({
    ...page,
    selected: selectedId !== null && page.id === selectedId,
  }));
}

/**
 * Record routing after a successful browser-scoped tool. Never reads
 * `[selected]` — that marker is display-only on `list_pages`.
 *
 * `new_page` records the unique complete row whose URL matches `args.url`.
 * Otherwise the session id is cleared (do not keep a prior dump guess).
 */
export function rememberToolRouting(
  name: string,
  args: Record<string, unknown>,
  result: string,
): void {
  if (name === "select_page" && typeof args.pageId === "number") {
    setSelectedPageId(args.pageId);
    return;
  }
  if (name === "new_page") {
    const requested = typeof args.url === "string" ? args.url : "";
    const created = createdPageIdFromNewPageDump(result, requested);
    if (created !== null) setSelectedPageId(created);
    else clearSelectedPageId();
    return;
  }
  if (name === "close_page" && typeof args.pageId === "number") {
    if (getSelectedPageId() === args.pageId) clearSelectedPageId();
  }
}

const MCP_PAGES_HEADER = /^## Pages$/;
const MCP_OTHER_SECTION =
  /^##\s+(Extension Pages|Extension Service Workers|Third-party developer tools|WebMCP tools)$/;
const GENERIC_SCHEME_SLASH_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const COLON_ONLY_SCHEME_URL = /^(?:about:|data:|view-source:|blob:)/i;
const PAGE_ID_LINE = /^(\d+):\s*(.*)$/;

function isSchemeUrl(label: string): boolean {
  return (
    GENERIC_SCHEME_SLASH_URL.test(label) || COLON_ONLY_SCHEME_URL.test(label)
  );
}

/** MCP suffixes only — not title text. */
function stripMcpSuffixes(rest: string): string {
  let label = rest.replace(/\s+isolatedContext=.*$/, "");
  label = label.replace(/\s*\[selected\]\s*$/, "").trimEnd();
  return label;
}

/**
 * True when `rest` is a complete MCP page label without joining title
 * newlines: untitled scheme URL, or a trailing ` (scheme-url)` wrapper.
 * Does not walk `collapsePageRows` and does not read `[selected]` as id.
 */
function isCompletePageLabel(rest: string): boolean {
  const body = stripMcpSuffixes(rest);
  if (isSchemeUrl(body)) return true;
  if (!body.endsWith(")")) return false;
  const open = body.lastIndexOf(" (");
  if (open === -1) return false;
  return isSchemeUrl(body.slice(open + 2, -1));
}

function pageUrlFromLabel(rest: string): string {
  const body = stripMcpSuffixes(rest);
  if (isSchemeUrl(body)) return body;
  const open = body.lastIndexOf(" (");
  if (open !== -1 && body.endsWith(")")) {
    return body.slice(open + 2, -1);
  }
  return body;
}

function urlsMatch(pageUrl: string, requested: string): boolean {
  if (!requested) return false;
  if (pageUrl === requested) return true;
  const trimSlash = (url: string) =>
    url.length > 1 && url.endsWith("/") ? url.slice(0, -1) : url;
  return trimSlash(pageUrl) === trimSlash(requested);
}

/**
 * Created page id from a `new_page` dump, or null when the dump is
 * ambiguous. The created id is the unique complete row in the last
 * `## Pages` block whose URL matches `requestedUrl`. Title continuations
 * such as `404: Not Found` are not page ids and fail the dump. Extra
 * complete rows that do not match (`about:blank`, another tab) are
 * ignored. Two matching URLs, or none, leave the id unset. Extension
 * pages are never routing targets. Does not read `[selected]` or walk
 * `collapsePageRows`.
 */
export function createdPageIdFromNewPageDump(
  text: string,
  requestedUrl: string,
): number | null {
  let inPages = false;
  let matchedIds: number[] = [];
  let incomplete = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (MCP_PAGES_HEADER.test(line)) {
      inPages = true;
      matchedIds = [];
      incomplete = false;
      continue;
    }
    if (MCP_OTHER_SECTION.test(line)) {
      inPages = false;
      continue;
    }
    if (!inPages) continue;
    const m = line.match(PAGE_ID_LINE);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    const rest = m[2];
    if (!isCompletePageLabel(rest)) {
      incomplete = true;
      continue;
    }
    const pageUrl = pageUrlFromLabel(rest);
    if (pageUrl.startsWith("chrome-extension:")) continue;
    if (urlsMatch(pageUrl, requestedUrl)) matchedIds.push(id);
  }
  if (incomplete) return null;
  if (matchedIds.length !== 1) return null;
  return matchedIds[0];
}
