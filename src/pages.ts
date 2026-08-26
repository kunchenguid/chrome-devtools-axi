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
 * Untitled `list_pages` rows and trailing ` (<url>)` wrappers. Any
 * `scheme://` prefix is a complete page URL (`chrome-untrusted:`,
 * `isolated-app:`, …). Colon-only schemes stay allowlisted so a title
 * like `Note: hello` is not treated as a URL.
 */
const GENERIC_SCHEME_SLASH_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const COLON_ONLY_SCHEME_URL = /^(?:about:|data:|view-source:|blob:)/i;

function isPageSchemeUrl(label: string): boolean {
  return (
    GENERIC_SCHEME_SLASH_URL.test(label) || COLON_ONLY_SCHEME_URL.test(label)
  );
}

/**
 * MCP `list_pages` section titles. Unknown `## ` lines (for example a
 * `truncateTitle` document.title that starts with `## Getting started`)
 * must fold as title text, not exit the page block.
 */
const MCP_SECTION_HEADER =
  /^##\s+(Pages|Extension Pages|Extension Service Workers|Third-party developer tools|WebMCP tools)$/;
/** `N: rest` or `N:` after trim of MCP `N: ` (title starts with a newline). */
const PAGE_ID_LINE = /^\d+:(?:\s+|$)/;
const OPEN_DIALOG_HEADER = /^# Open dialog$/;
const HANDLE_DIALOG_FOOTER =
  /^Call handle_dialog to handle it before continuing\.$/;

/**
 * MCP appends ` isolatedContext=<name>` after the URL / `[selected]`.
 * A title can mention `isolatedContext=` (or `[selected] isolatedContext=`)
 * earlier on the line; only the trailing suffix is MCP's.
 */
function stripTrailingIsolatedContext(label: string): string {
  const match = label.match(/^(.*)\s+isolatedContext=.*$/);
  if (!match) return label;
  const before = match[1];
  const withoutSelected = before.replace(/\s*\[selected\]\s*$/, "").trimEnd();
  if (matchTrailingUrl(withoutSelected) !== null) return before;
  if (isPageSchemeUrl(withoutSelected)) return before;
  return label;
}

function stripPageSuffixes(rest: string): string {
  let label = stripTrailingIsolatedContext(rest);
  if (/(?:^|\s)\[selected\]\s*$/.test(label)) {
    label = label.replace(/\s*\[selected\]\s*$/, "").trimEnd();
  }
  return label;
}

/**
 * Last MCP ` (<url>)` wrapper on a titled row. Walks ` (` candidates
 * backward from the final `)` so a URL that itself contains ` (` (data:
 * HTML like `Hi (there)`, or `file://…/My Folder (work)`) is not peeled
 * as a non-scheme slice. A title that contains `(https://…)` still loses
 * to the later scheme wrapper; `Foo_(bar)` wins on the first try.
 */
function matchTrailingUrl(
  label: string,
): { title: string; url: string } | null {
  const trimmed = label.trimEnd();
  if (!trimmed.endsWith(")")) return null;
  const close = trimmed.length - 1;
  let from = close;
  while (from > 0) {
    const open = trimmed.lastIndexOf(" (", from - 1);
    if (open === -1) return null;
    const url = trimmed.slice(open + 2, close);
    if (isPageSchemeUrl(url)) {
      return { title: trimmed.slice(0, open), url };
    }
    from = open;
  }
  return null;
}

function hasSchemeUrl(label: string): boolean {
  const rest = stripPageSuffixes(label);
  return matchTrailingUrl(rest) !== null || isPageSchemeUrl(rest);
}

function isCompletePageRow(row: string): boolean {
  return hasSchemeUrl(row.replace(/^\d+:\s*/, ""));
}

/**
 * A title newline can look like a new `N:` page. Fold only the
 * `[selected]` suffix with no real page URL (`2: Other Tab [selected]`).
 * A later real tab whose title contains `[selected]` before the URL
 * wrapper (`2: Inbox [selected] - App (https://example.com/)`) stays its
 * own row.
 */
function isTitleContinuationLine(line: string): boolean {
  const m = line.match(/^(\d+):\s+(.+)$/);
  if (!m) return false;
  const rest = stripPageSuffixes(m[2]);
  if (matchTrailingUrl(rest) !== null) return false;
  if (isPageSchemeUrl(rest)) return false;
  return /(?:^|\s)\[selected\]\s*$/.test(stripTrailingIsolatedContext(m[2]));
}

function extractPageUrl(label: string): string {
  const match = matchTrailingUrl(label);
  return match ? match.url : label.trim();
}

function pageRowRest(row: string): string {
  return stripPageSuffixes(row.replace(/^\d+:\s*/, ""));
}

/**
 * MCP prepends `# Open dialog` / `type: message` / `Call handle_dialog…`
 * and interpolates the dialog message with newlines intact, so
 * `alert("see\\n## Pages\\n0: x")` forges a page section. Drop that
 * preamble (from `# Open dialog` through the last exact MCP footer
 * `Call handle_dialog to handle it before continuing.`) so a message
 * line `Call handle_dialog` cannot end the strip early.
 */
function stripDialogPreamble(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (OPEN_DIALOG_HEADER.test(lines[i].trim())) {
      let end = -1;
      for (let idx = i + 1; idx < lines.length; idx++) {
        if (HANDLE_DIALOG_FOOTER.test(lines[idx].trim())) end = idx;
      }
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join("\n");
}

/**
 * True when lines after a `## Pages` header finish the current incomplete
 * title with MCP's trailing ` (<url>)` wrapper. A following untitled
 * `N: scheme://…` row is the real list, not title text.
 */
function followingLinesCompleteTitle(
  rawLines: string[],
  headerIndex: number,
  currentRow: string,
): boolean {
  let acc = `${currentRow} ## Pages`;
  for (let i = headerIndex + 1; i < rawLines.length; i++) {
    const next = rawLines[i].trim();
    if (next.length === 0) continue;
    if (next.match(MCP_SECTION_HEADER) !== null) return false;
    if (PAGE_ID_LINE.test(next)) {
      const rest = stripPageSuffixes(next.replace(/^\d+:\s*/, ""));
      if (isPageSchemeUrl(rest) && matchTrailingUrl(rest) === null) {
        return false;
      }
    }
    acc += ` ${next}`;
    if (matchTrailingUrl(pageRowRest(acc)) !== null) return true;
  }
  return false;
}

/**
 * Join `list_pages` text into one row per page id.
 *
 * MCP interpolates unsanitized `document.title` (and open-dialog text) with
 * newlines intact, so a title/dialog like `Error\n404: Not Found` can look
 * like a new page id. Only `## Pages` / `## Extension Pages` blocks are
 * parsed. A `N:` line folds onto the previous row when that row is still
 * incomplete, or when the new line is a title continuation (`[selected]`
 * suffix with no scheme URL) — otherwise a title such as
 * `Something (https://example.com)\n2: Other Tab [selected]` would steal
 * routing, and a later page whose title wraps (`2: Other\nTab (url)`)
 * would be merged into the previous id. A real tab titled
 * `Inbox [selected] - App (https://example.com/)` is not a continuation.
 * `raw.trim()` turns MCP `N: `
 * (title starts with a newline) into `N:`; that still counts as an
 * incomplete page row so a title like `\n2: Other Tab` folds onto the
 * real id instead of becoming page 2. Continuation lines are kept unless
 * they are known MCP section headers (`## Pages`, `## Extension Pages`,
 * `## Extension Service Workers`, `## Third-party developer tools`,
 * `## WebMCP tools`). Unknown `## ` lines stay in the current page row so
 * a title like `Intro\n## Getting started` does not drop `[selected]`.
 * Dialog preamble (`# Open dialog` … `Call handle_dialog…`) is stripped
 * first so a message that forges `## Pages` plus `0: x` cannot merge a
 * later titled `[selected]` row into that id; the real `## Pages` then
 * resets unconditionally. An incomplete current row is not enough to fold
 * `## Pages`: only fold when the following lines complete that title with
 * a trailing URL wrapper (so `x\n## Pages\n0: https://a.com/ (https://real/)`
 * keeps the real id). `## Extension Pages` does not reset.
 */
function collapsePageRows(text: string): string[] {
  const rows: string[] = [];
  let inPageBlock = false;
  const rawLines = stripDialogPreamble(text).split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index].trim();
    if (line.length === 0) continue;
    const section = line.match(MCP_SECTION_HEADER)?.[1];
    if (section !== undefined) {
      const prev = rows[rows.length - 1];
      if (
        section === "Pages" &&
        inPageBlock &&
        prev !== undefined &&
        !isCompletePageRow(prev) &&
        followingLinesCompleteTitle(rawLines, index, prev)
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
 * Untitled `N: <url> [selected]` after an already-selected page is a
 * title/dialog newline, not a second MCP tab.
 */
function isForgedUntitledSelected(
  rest: string,
  url: string,
  alreadySelected: boolean,
): boolean {
  if (!alreadySelected) return false;
  if (matchTrailingUrl(rest) !== null) return false;
  return isPageSchemeUrl(url);
}

export function parsePagesList(text: string): PageListEntry[] {
  const pages: PageListEntry[] = [];
  let haveSelected = false;
  for (const line of collapsePageRows(text)) {
    const m = line.match(/^(\d+):\s+(.+)$/);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    let rest = stripTrailingIsolatedContext(m[2]);
    const selected = /(?:^|\s)\[selected\]\s*$/.test(rest);
    if (selected) {
      rest = rest.replace(/\s*\[selected\]\s*$/, "").trimEnd();
    }
    const url = extractPageUrl(rest);
    if (selected && isForgedUntitledSelected(rest, url, haveSelected)) {
      continue;
    }
    if (selected) haveSelected = true;
    pages.push({ id, url, selected });
  }
  return pages;
}

/** Selected page id from `list_pages` text, or null if none is marked. */
export function parseSelectedPageId(text: string): number | null {
  const selected = parsePagesList(text).find((page) => page.selected);
  return selected === undefined ? null : selected.id;
}
