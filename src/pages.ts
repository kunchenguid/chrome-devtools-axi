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
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const m = line.match(/^(\d+):\s+(.+)$/);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    let rest = m[2];
    rest = rest.replace(/\s+isolatedContext=.*$/, "");
    const selected = /(?:^|\s)\[selected\]\s*$/.test(rest);
    if (selected) {
      rest = rest.replace(/\s*\[selected\]\s*$/, "").trimEnd();
    }
    const urlMatch = rest.match(/\(([^)]+)\)\s*$/);
    const url = urlMatch ? urlMatch[1] : rest.trim();
    pages.push({ id, url, selected });
  }
  return pages;
}

/** Selected page id from `list_pages` text, or null if none is marked. */
export function parseSelectedPageId(text: string): number | null {
  const selected = parsePagesList(text).find((page) => page.selected);
  return selected === undefined ? null : selected.id;
}
