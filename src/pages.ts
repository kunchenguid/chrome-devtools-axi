/**
 * Parse chrome-devtools-mcp `list_pages` output and identify page-scoped tools.
 *
 * MCP 1.8+ requires `pageId` on page-scoped tools by default (`pageIdRouting`).
 * AXI still presents a selected-page CLI, so `callTool` resolves the selected
 * page from `list_pages` and injects it. This module is the shared parser so
 * the CLI `pages` command and that injection path cannot drift.
 */

export type PageListEntry = {
  id: number;
  url: string;
  selected: boolean;
};

/**
 * MCP tools AXI wraps that are page-scoped. chrome-devtools-mcp 1.8+ requires
 * `pageId` on these when `--pageIdRouting` is on (the default). Browser-scoped
 * tools (`list_pages`, `new_page`, `select_page`, `close_page`) are omitted:
 * they either take no page, create one, or take a caller-supplied target id.
 *
 * Keep this in sync with AXI call sites in `src/cli.ts` / `src/run.ts` and
 * the upstream page-scoped set. Adding a tool AXI does not call is harmless;
 * omitting one AXI does call reintroduces `Required at pageId`.
 */
export const PAGE_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "drag",
  "emulate",
  "evaluate_script",
  "fill",
  "fill_form",
  "get_console_message",
  "get_network_request",
  "handle_dialog",
  "hover",
  "lighthouse_audit",
  "list_console_messages",
  "list_network_requests",
  "navigate_page",
  "performance_analyze_insight",
  "performance_start_trace",
  "performance_stop_trace",
  "press_key",
  "resize_page",
  "take_memory_snapshot",
  "take_screenshot",
  "take_snapshot",
  "type_text",
  "upload_file",
  "wait_for",
]);

/**
 * True when AXI must supply `pageId` before forwarding `name` to MCP.
 *
 * Skips tools that already carry a numeric `pageId`, and `evaluate_script`
 * aimed at a service worker (`serviceWorkerId` replaces `pageId` when
 * `--categoryExtensions` is on).
 */
export function needsPageId(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  if (typeof args.pageId === "number") return false;
  if (
    name === "evaluate_script" &&
    typeof args.serviceWorkerId === "string" &&
    args.serviceWorkerId.length > 0
  ) {
    return false;
  }
  return PAGE_SCOPED_TOOLS.has(name);
}

/**
 * Schemes MCP/Puppeteer emit on untitled `list_pages` rows (and in the
 * trailing ` (<url>)` title wrapper). Shared so completeness and URL
 * peeling cannot drift. Includes blob:/devtools:/view-source:/edge: so an
 * earlier unselected tab with one of those URLs is not left "incomplete"
 * (which would fold the real `[selected]` page into it).
 */
const PAGE_URL_SCHEMES = [
  "https?:\\/\\/",
  "about:",
  "data:",
  "chrome-extension:",
  "chrome:",
  "file:",
  "blob:",
  "devtools:",
  "view-source:",
  "edge:",
] as const;
const PAGE_URL_SCHEME_SOURCE = `(?:${PAGE_URL_SCHEMES.join("|")})`;
const UNTITLED_SCHEME_URL = new RegExp(`^${PAGE_URL_SCHEME_SOURCE}`, "i");

/**
 * MCP `list_pages` section titles. Unknown `## ` lines (for example a
 * `truncateTitle` document.title that starts with `## Getting started`)
 * must fold as title text, not exit the page block.
 */
const MCP_SECTION_HEADER =
  /^##\s+(Pages|Extension Pages|Extension Service Workers|Third-party developer tools|WebMCP tools)$/;
/** `N: rest` or `N:` after trim of MCP `N: ` (title starts with a newline). */
const PAGE_ID_LINE = /^\d+:(?:\s+|$)/;

function stripPageSuffixes(rest: string): string {
  let label = rest.replace(/\s+isolatedContext=.*$/, "");
  if (/(?:^|\s)\[selected\]\s*$/.test(label)) {
    label = label.replace(/\s*\[selected\]\s*$/, "").trimEnd();
  }
  return label;
}

/**
 * Last MCP ` (<url>)` wrapper on a titled row. Walks from the final `)` so a
 * title that itself contains `(https://…)` is not mistaken for the page URL.
 */
function matchTrailingUrl(
  label: string,
): { title: string; url: string } | null {
  const trimmed = label.trimEnd();
  if (!trimmed.endsWith(")")) return null;
  const close = trimmed.length - 1;
  const open = trimmed.lastIndexOf(" (");
  if (open === -1) return null;
  const url = trimmed.slice(open + 2, close);
  if (!UNTITLED_SCHEME_URL.test(url)) return null;
  return { title: trimmed.slice(0, open), url };
}

function hasSchemeUrl(label: string): boolean {
  const rest = stripPageSuffixes(label);
  return matchTrailingUrl(rest) !== null || UNTITLED_SCHEME_URL.test(rest);
}

function isCompletePageRow(row: string): boolean {
  if (/\sisolatedContext=/.test(row)) return true;
  return hasSchemeUrl(row.replace(/^\d+:\s*/, ""));
}

/**
 * A title newline can look like a new `N:` page. Fold only when the line
 * is `[selected]` without a real page URL, or `[selected]` sits in the
 * title before the trailing URL wrapper. A later real page whose title
 * wraps (`2: Other\nTab (https://b.com/) [selected]`) must start a new
 * row — any `N: <non-scheme>` text is not a continuation.
 */
function isTitleContinuationLine(line: string): boolean {
  const m = line.match(/^(\d+):\s+(.+)$/);
  if (!m) return false;
  const rest = stripPageSuffixes(m[2]);
  const trailing = matchTrailingUrl(rest);
  if (trailing !== null) {
    return /\[selected\]/.test(trailing.title);
  }
  if (UNTITLED_SCHEME_URL.test(rest)) return false;
  return /(?:^|\s)\[selected\]\s*$/.test(
    m[2].replace(/\s+isolatedContext=.*$/, ""),
  );
}

function extractPageUrl(label: string): string {
  const match = matchTrailingUrl(label);
  return match ? match.url : label.trim();
}

/**
 * Join `list_pages` text into one row per page id.
 *
 * MCP interpolates unsanitized `document.title` (and open-dialog text) with
 * newlines intact, so a title/dialog like `Error\n404: Not Found` can look
 * like a new page id. Only `## Pages` / `## Extension Pages` blocks are
 * parsed. A `N:` line folds onto the previous row when that row is still
 * incomplete, or when the new line is a title continuation (`[selected]`
 * without a scheme URL, or `[selected]` in the title before the URL
 * wrapper) — otherwise a title such as
 * `Something (https://example.com)\n2: Other Tab [selected]` would steal
 * routing, and a later page whose title wraps (`2: Other\nTab (url)`)
 * would be merged into the previous id. `raw.trim()` turns MCP `N: `
 * (title starts with a newline) into `N:`; that still counts as an
 * incomplete page row so a title like `\n2: Other Tab` folds onto the
 * real id instead of becoming page 2. Continuation lines are kept unless
 * they are known MCP section headers (`## Pages`, `## Extension Pages`,
 * `## Extension Service Workers`, `## Third-party developer tools`,
 * `## WebMCP tools`). Unknown `## ` lines stay in the current page row so
 * a title like `Intro\n## Getting started` does not drop `[selected]`. A
 * later `## Pages` after complete rows replaces earlier rows so dialog
 * text that forges `## Pages` cannot prepend a selected page; while the
 * current row is still incomplete, `## Pages` folds as title text so a
 * title like `x\n## Pages\n0: https://a.com/` cannot discard the real id.
 * `## Extension Pages` does not reset.
 */
function collapsePageRows(text: string): string[] {
  const rows: string[] = [];
  let inPageBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const section = line.match(MCP_SECTION_HEADER)?.[1];
    if (section !== undefined) {
      const prev = rows[rows.length - 1];
      if (
        section === "Pages" &&
        inPageBlock &&
        prev !== undefined &&
        !isCompletePageRow(prev)
      ) {
        rows[rows.length - 1] += ` ${line}`;
        continue;
      }
      if (section === "Pages") {
        rows.length = 0;
        inPageBlock = true;
      } else if (section === "Extension Pages") {
        inPageBlock = true;
      } else {
        inPageBlock = false;
      }
      continue;
    }
    if (!inPageBlock) continue;
    if (PAGE_ID_LINE.test(line)) {
      const prev = rows[rows.length - 1];
      if (
        prev !== undefined &&
        (!isCompletePageRow(prev) || isTitleContinuationLine(line))
      ) {
        rows[rows.length - 1] += ` ${line}`;
      } else {
        rows.push(line);
      }
      continue;
    }
    if (rows.length > 0) {
      rows[rows.length - 1] += ` ${line}`;
    }
  }
  return rows.map((row) => row.replace(/\s+/g, " "));
}

/**
 * Parse MCP `list_pages` markdown into structured rows.
 *
 * Upstream formats each page as:
 *   `<id>: <url>`
 *   `<id>: <title> (<url>)`
 * optionally followed by ` [selected]` and ` isolatedContext=<name>`
 * (`isolatedContext` is a free-form zod string and may contain spaces).
 */
export function parsePagesList(text: string): PageListEntry[] {
  const pages: PageListEntry[] = [];
  for (const line of collapsePageRows(text)) {
    const m = line.match(/^(\d+):\s+(.+)$/);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    let rest = m[2];
    rest = rest.replace(/\s+isolatedContext=.*$/, "");
    const selected = /(?:^|\s)\[selected\]\s*$/.test(rest);
    if (selected) {
      rest = rest.replace(/\s*\[selected\]\s*$/, "").trimEnd();
    }
    pages.push({ id, url: extractPageUrl(rest), selected });
  }
  return pages;
}

/** Selected page id from `list_pages` text, or null if none is marked. */
export function parseSelectedPageId(text: string): number | null {
  const selected = parsePagesList(text).find((page) => page.selected);
  return selected === undefined ? null : selected.id;
}
