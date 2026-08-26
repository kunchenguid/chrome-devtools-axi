/**
 * Session-selected page routing. chrome-devtools-mcp 1.8+ requires `pageId`
 * on page-scoped tools; AXI injects the last page this session selected
 * rather than parsing `[selected]` out of `list_pages` (titles and dialog
 * text can forge that marker).
 *
 * Survives across short-lived CLI processes the same way the snapshot
 * generation counter does: a file in the active session's state dir.
 * `select_page` writes the caller-supplied id. `new_page` (open / newpage)
 * records the created tab only when that tool's own dump is unambiguous —
 * not a `list_pages` call, not `[selected]`, and not every `N:` line after
 * `## Pages`. An ambiguous dump clears the session id so the next
 * page-scoped call fails loud until an explicit `select_page`. `close_page`
 * of the selected id also clears it.
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

export function clearSelectedPageId(): void {
  const file = selectedPageFile();
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
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
 * `new_page` records only an unambiguous created id from its own dump.
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
 * ambiguous. Only a single complete page row in the last `## Pages`
 * block (and no other `N:` lines) is unambiguous. Title continuations
 * such as `404: Not Found` are not page ids. Extra complete `N:` rows
 * (real extra tabs or a forged untitled URL) are also ambiguous — do
 * not take max-id. Extension pages are never routing targets.
 */
export function createdPageIdFromNewPageDump(text: string): number | null {
  let inPages = false;
  let completeIds: number[] = [];
  let incomplete = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (MCP_PAGES_HEADER.test(line)) {
      inPages = true;
      completeIds = [];
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
    if (pageUrlFromLabel(rest).startsWith("chrome-extension:")) continue;
    completeIds.push(id);
  }
  if (incomplete) return null;
  if (completeIds.length !== 1) return null;
  return completeIds[0];
}
