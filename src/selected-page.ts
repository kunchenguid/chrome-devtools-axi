/**
 * Session-selected page routing. chrome-devtools-mcp 1.8+ requires `pageId`
 * on page-scoped tools; AXI injects the last page this session selected
 * rather than parsing `[selected]` out of `list_pages` (titles and dialog
 * text can forge that marker).
 *
 * Survives across short-lived CLI processes the same way the snapshot
 * generation counter does: a file in the active session's state dir.
 * `select_page` writes the caller-supplied id. `new_page` (open / newpage)
 * records the created tab: the one complete row in that tool's own dump that
 * ends in ` [selected]`. chrome-devtools-mcp selects the page it creates,
 * serializes tool calls, and appends that suffix after the ` (url)` wrapper,
 * so a single-line page title cannot put it at the end of a row. The URL is
 * not used: it can change while loading (redirects, query rewrites) and need
 * not be unique (#146, #155, #170). Not a `list_pages` call, and not every
 * `N:` line after `## Pages`. Any dump `createdPageIdFromNewPageDump` rejects
 * clears the session id so the next page-scoped call fails loud until an
 * explicit `select_page`. `close_page` of the selected id also clears it,
 * and so does the bridge when chrome-devtools-mcp reports a browser reconnect
 * that reissues every page id (`didMcpPageIdentityChange` in `src/bridge.ts`).
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
    // Best-effort: a failed write can leave a prior id on disk. Callers
    // requiring a newly persisted selection must verify it before proceeding.
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
 * Record routing after a successful browser-scoped tool. `[selected]` on
 * `list_pages` is display-only; only `new_page`'s own dump is read for it.
 *
 * `new_page` records the unique complete row MCP marked selected. Otherwise
 * the session id is cleared (do not keep a prior dump guess).
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
    const created = createdPageIdFromNewPageDump(result);
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
const MCP_SELECTED_SUFFIX = / \[selected\]$/;
// MCP moved its selection off a page that closed; the marker is no longer
// the created tab.
const MCP_SELECTION_FALLBACK = /^Note: the previously selected page /;

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

/**
 * Created page id from a `new_page` dump, or null when the dump is
 * ambiguous. The created id is the unique complete row in the one
 * `## Pages` block that ends in MCP's ` [selected]` suffix. Titles are
 * untrusted: one with newlines can split the real row and push its tail past
 * a forged header, but MCP always appends ` [selected]` to the created tab's
 * row, so the real marker is still somewhere in the dump. Every line of the
 * whole dump ending in ` [selected]` is therefore counted, and anything but
 * exactly one (the matched row) fails the dump. Title continuations such as
 * `404: Not Found` or any other non-row line in the block, a second
 * `## Pages` header, a repeated page id (a title line posing as an existing
 * tab's row), and MCP's selection-fallback note also fail it.
 * Extension pages are never routing targets. Does not walk
 * `collapsePageRows`.
 */
export function createdPageIdFromNewPageDump(text: string): number | null {
  let inPages = false;
  let seenPages = false;
  const matchedIds: number[] = [];
  const listedIds = new Set<number>();
  let markedLines = 0;
  let incomplete = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (MCP_SELECTION_FALLBACK.test(line)) return null;
    if (MCP_SELECTED_SUFFIX.test(line)) markedLines++;
    if (MCP_PAGES_HEADER.test(line)) {
      if (seenPages) return null;
      seenPages = inPages = true;
      continue;
    }
    if (MCP_OTHER_SECTION.test(line)) {
      inPages = false;
      continue;
    }
    if (!inPages || line.length === 0) continue;
    const m = line.match(PAGE_ID_LINE);
    if (!m) {
      incomplete = true;
      continue;
    }
    const id = Number.parseInt(m[1], 10);
    if (listedIds.has(id)) return null;
    listedIds.add(id);
    const rest = m[2];
    if (!isCompletePageLabel(rest)) {
      incomplete = true;
      continue;
    }
    const pageUrl = pageUrlFromLabel(rest);
    if (pageUrl.startsWith("chrome-extension:")) continue;
    if (MCP_SELECTED_SUFFIX.test(rest)) matchedIds.push(id);
  }
  if (incomplete) return null;
  if (matchedIds.length !== 1 || markedLines !== 1) return null;
  return matchedIds[0];
}
