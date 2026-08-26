/**
 * Session-selected page routing. chrome-devtools-mcp 1.8+ requires `pageId`
 * on page-scoped tools; AXI injects the last page this session selected
 * rather than parsing `[selected]` out of `list_pages` (titles and dialog
 * text can forge that marker).
 *
 * Survives across short-lived CLI processes the same way the snapshot
 * generation counter does: a file in the active session's state dir.
 * `select_page` writes the caller-supplied id. `new_page` (open / newpage)
 * records the created tab from that tool's own pages dump — not a
 * `list_pages` call, and not the `[selected]` marker. `close_page` of the
 * selected id clears it so the next page-scoped call fails loudly.
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
 * Record routing after a successful browser-scoped tool. Never reads
 * `[selected]` — that marker is display-only on `list_pages`.
 *
 * MCP `new_page` always selects the created tab and dumps `## Pages`.
 * Page ids are monotonic, so the created tab is the highest regular-page
 * id in that dump. Extension pages are not AXI routing targets.
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
    return;
  }
  if (name === "close_page" && typeof args.pageId === "number") {
    if (getSelectedPageId() === args.pageId) clearSelectedPageId();
  }
}

const MCP_PAGES_HEADER = /^## Pages$/;
const MCP_OTHER_SECTION =
  /^##\s+(Extension Pages|Extension Service Workers|Third-party developer tools|WebMCP tools)$/;

/**
 * Highest page id in the last `## Pages` dump of a `new_page` result.
 * Does not look at `[selected]` and does not call `parsePagesList`.
 * `chrome-extension:` rows are skipped so extension tabs cannot become
 * the routing target.
 */
function createdPageIdFromNewPageDump(text: string): number | null {
  let inPages = false;
  let max: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (MCP_PAGES_HEADER.test(line)) {
      inPages = true;
      max = null;
      continue;
    }
    if (MCP_OTHER_SECTION.test(line)) {
      inPages = false;
      continue;
    }
    if (!inPages) continue;
    const m = line.match(/^(\d+):\s+(\S.*)$/);
    if (!m) continue;
    if (m[2].startsWith("chrome-extension:")) continue;
    const id = Number.parseInt(m[1], 10);
    if (max === null || id > max) max = id;
  }
  return max;
}
