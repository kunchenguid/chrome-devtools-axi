import { encode } from "@toon-format/toon";
import { CdpError, callTool, ensureBridge, getSessionSnapshotIfRunning, stopBridge } from "./client.js";
import { installHooks } from "./hooks.js";
import { countRefs, extractTitle, truncateSnapshot } from "./snapshot.js";
import { getSuggestions } from "./suggestions.js";

const HELP = `usage: chrome-devtools-axi <command> [args]
commands[33]:
  open <url>, snapshot, screenshot <path>, click @<uid>, fill @<uid> <text>,
  type <text>, press <key>, scroll <dir>, back, wait <ms|text>, eval <js>,
  hover @<uid>, drag @<from> @<to>, fillform @<uid>=<val>..., dialog <action>,
  upload @<uid> <path>, pages, newpage <url>, selectpage <id>, closepage <id>,
  resize <w> <h>, emulate, console, console-get <id>, network,
  network-get [id], lighthouse, perf-start, perf-stop,
  perf-insight <set> <name>, heap <path>, start, stop
`;

const COMMAND_HELP: Record<string, string> = {
  open: `usage: chrome-devtools-axi open <url> [--full]
Navigate to a URL and capture an accessibility snapshot.

args:
  <url>   URL to navigate to (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi open https://example.com
  chrome-devtools-axi open https://example.com --full`,

  screenshot: `usage: chrome-devtools-axi screenshot <path> [--uid @<uid>] [--full-page] [--format png|jpeg|webp]
Save a screenshot to a file.

args:
  <path>  File path to save the screenshot (required)

flags:
  --uid @<uid>    Capture a specific element instead of the full viewport
  --full-page     Capture the entire scrollable page
  --format <fmt>  Image format: png (default), jpeg, or webp

examples:
  chrome-devtools-axi screenshot ./page.png
  chrome-devtools-axi screenshot ./element.png --uid @3
  chrome-devtools-axi screenshot ./full.png --full-page --format jpeg`,

  snapshot: `usage: chrome-devtools-axi snapshot [--full]
Capture the current page accessibility snapshot.

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi snapshot
  chrome-devtools-axi snapshot --full`,

  click: `usage: chrome-devtools-axi click @<uid> [--full]
Click an interactive element by its ref from the snapshot.

args:
  @<uid>  Element ref from snapshot (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi click @1
  chrome-devtools-axi click @12 --full`,

  fill: `usage: chrome-devtools-axi fill @<uid> <text> [--full]
Fill a form field with text.

args:
  @<uid>  Element ref from snapshot (required)
  <text>  Text to fill (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi fill @3 "hello world"
  chrome-devtools-axi fill @3 "search query" --full`,

  type: `usage: chrome-devtools-axi type <text> [--full]
Type text at the currently focused element.

args:
  <text>  Text to type (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi type "hello"
  chrome-devtools-axi type "search query" --full`,

  press: `usage: chrome-devtools-axi press <key> [--full]
Press a keyboard key.

args:
  <key>  Key name, e.g. Enter, Tab, Escape, ArrowDown (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi press Enter
  chrome-devtools-axi press Tab --full`,

  scroll: `usage: chrome-devtools-axi scroll <direction> [--full]
Scroll the page in a direction.

args:
  <direction>  up, down, top, or bottom (default: down)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi scroll down
  chrome-devtools-axi scroll top --full`,

  back: `usage: chrome-devtools-axi back [--full]
Navigate back in browser history.

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi back
  chrome-devtools-axi back --full`,

  wait: `usage: chrome-devtools-axi wait <ms|text>
Wait for a duration or for text to appear on the page.

args:
  <ms>    Milliseconds to wait (numeric)
  <text>  Text to wait for (string)

examples:
  chrome-devtools-axi wait 2000
  chrome-devtools-axi wait "Submit"`,

  eval: `usage: chrome-devtools-axi eval <js>
Evaluate JavaScript in the page context.

args:
  <js>  JavaScript expression (required)

examples:
  chrome-devtools-axi eval "document.title"
  chrome-devtools-axi eval "document.querySelectorAll('a').length"`,

  start: `usage: chrome-devtools-axi start
Start the bridge server (launches headless Chrome).

examples:
  chrome-devtools-axi start`,

  stop: `usage: chrome-devtools-axi stop
Stop the bridge server and close the browser.

examples:
  chrome-devtools-axi stop`,

  // Page management
  pages: `usage: chrome-devtools-axi pages
List all open pages/tabs in the browser.

examples:
  chrome-devtools-axi pages`,

  newpage: `usage: chrome-devtools-axi newpage <url> [--background] [--full]
Open a new tab and navigate to a URL.

args:
  <url>  URL to open (required)

flags:
  --background  Open in background without bringing to front
  --full        Show complete snapshot without truncation

examples:
  chrome-devtools-axi newpage https://example.com
  chrome-devtools-axi newpage https://example.com --background`,

  selectpage: `usage: chrome-devtools-axi selectpage <id> [--full]
Switch to a tab by page ID.

args:
  <id>  Page ID from the pages command (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi selectpage 1`,

  closepage: `usage: chrome-devtools-axi closepage <id>
Close a tab by page ID. The last open page cannot be closed.

args:
  <id>  Page ID from the pages command (required)

examples:
  chrome-devtools-axi closepage 2`,

  resize: `usage: chrome-devtools-axi resize <width> <height>
Resize the browser viewport.

args:
  <width>   Width in pixels (required)
  <height>  Height in pixels (required)

examples:
  chrome-devtools-axi resize 1280 720
  chrome-devtools-axi resize 390 844`,

  // Interaction
  hover: `usage: chrome-devtools-axi hover @<uid> [--full]
Hover over an element to trigger hover states.

args:
  @<uid>  Element ref from snapshot (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi hover @5`,

  drag: `usage: chrome-devtools-axi drag @<from> @<to> [--full]
Drag an element onto another element.

args:
  @<from>  Element to drag (required)
  @<to>    Element to drop onto (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi drag @3 @7`,

  fillform: `usage: chrome-devtools-axi fillform @<uid>=<value>... [--full]
Fill multiple form fields at once.

args:
  @<uid>=<value>  One or more field entries (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi fillform @1="hello" @2="world"
  chrome-devtools-axi fillform @3="user@email.com" @4="password123"`,

  dialog: `usage: chrome-devtools-axi dialog <accept|dismiss> [text]
Handle a browser dialog (alert, confirm, prompt).

args:
  <action>  accept or dismiss (required)
  [text]    Optional text to enter into a prompt dialog

examples:
  chrome-devtools-axi dialog accept
  chrome-devtools-axi dialog dismiss
  chrome-devtools-axi dialog accept "confirmed"`,

  upload: `usage: chrome-devtools-axi upload @<uid> <path> [--full]
Upload a file through a file input element.

args:
  @<uid>  File input element ref from snapshot (required)
  <path>  Local file path to upload (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  chrome-devtools-axi upload @5 ./photo.jpg`,

  // Emulation
  emulate: `usage: chrome-devtools-axi emulate [flags]
Emulate device features on the selected page.

flags:
  --viewport <spec>          Viewport like "390x844x3,mobile,touch"
  --color-scheme <value>     dark | light | auto
  --network <condition>      Offline | Slow 3G | Fast 3G | Slow 4G | Fast 4G
  --cpu <rate>               CPU throttling rate 1-20
  --geolocation <lat>x<lon>  Geolocation like "37.7749x-122.4194"
  --user-agent <string>      Custom user agent string

examples:
  chrome-devtools-axi emulate --viewport "390x844x3,mobile" --color-scheme dark
  chrome-devtools-axi emulate --network "Slow 3G" --cpu 4`,

  // DevTools debugging
  console: `usage: chrome-devtools-axi console [--type <type>] [--limit <n>] [--page <n>]
List console messages for the current page.

flags:
  --type <type>  Filter by message type (error, warn, log, etc.)
  --limit <n>    Maximum messages to return
  --page <n>     Page number (0-based)

examples:
  chrome-devtools-axi console
  chrome-devtools-axi console --type error --limit 50`,

  "console-get": `usage: chrome-devtools-axi console-get <id>
Get a specific console message by ID.

args:
  <id>  Message ID from the console command (required)

examples:
  chrome-devtools-axi console-get 3`,

  network: `usage: chrome-devtools-axi network [--type <type>] [--limit <n>] [--page <n>]
List network requests for the current page.

flags:
  --type <type>  Filter by resource type (fetch, xhr, document, etc.)
  --limit <n>    Maximum requests to return
  --page <n>     Page number (0-based)

examples:
  chrome-devtools-axi network
  chrome-devtools-axi network --type fetch --limit 50`,

  "network-get": `usage: chrome-devtools-axi network-get [id] [--response-file <path>] [--request-file <path>]
Get a specific network request. If id is omitted, gets the selected request.

args:
  [id]  Request ID from the network command (optional)

flags:
  --response-file <path>  Save response body to file
  --request-file <path>   Save request body to file

examples:
  chrome-devtools-axi network-get 42
  chrome-devtools-axi network-get 42 --response-file ./response.json`,

  // Performance
  lighthouse: `usage: chrome-devtools-axi lighthouse [--device <device>] [--mode <mode>] [--output-dir <path>]
Run a Lighthouse audit for accessibility, SEO, and best practices.

flags:
  --device <device>      desktop (default) or mobile
  --mode <mode>          navigation (default) or snapshot
  --output-dir <path>    Directory for reports

examples:
  chrome-devtools-axi lighthouse
  chrome-devtools-axi lighthouse --device mobile --output-dir ./reports`,

  "perf-start": `usage: chrome-devtools-axi perf-start [--no-reload] [--no-auto-stop] [--file <path>]
Start a performance trace recording.

flags:
  --no-reload     Don't reload the page when starting
  --no-auto-stop  Don't automatically stop the trace
  --file <path>   Save raw trace data to file

examples:
  chrome-devtools-axi perf-start
  chrome-devtools-axi perf-start --no-reload --file trace.json.gz`,

  "perf-stop": `usage: chrome-devtools-axi perf-stop [--file <path>]
Stop the active performance trace recording.

flags:
  --file <path>  Save raw trace data to file

examples:
  chrome-devtools-axi perf-stop
  chrome-devtools-axi perf-stop --file trace.json.gz`,

  "perf-insight": `usage: chrome-devtools-axi perf-insight <set-id> <insight-name>
Analyze a specific performance insight from a trace.

args:
  <set-id>        Insight set ID from trace results (required)
  <insight-name>  Insight name, e.g. "DocumentLatency" (required)

examples:
  chrome-devtools-axi perf-insight set1 DocumentLatency
  chrome-devtools-axi perf-insight set1 LCPBreakdown`,

  heap: `usage: chrome-devtools-axi heap <path>
Capture a heap snapshot for memory leak debugging.

args:
  <path>  File path to save the .heapsnapshot file (required)

examples:
  chrome-devtools-axi heap ./snapshot.heapsnapshot`,
};

export function getCommandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}

export interface ScreenshotArgs {
  filePath: string | null;
  uid: string | undefined;
  fullPage: boolean;
  format: string | undefined;
}

export function parseScreenshotArgs(args: string[]): ScreenshotArgs {
  let filePath: string | null = null;
  let uid: string | undefined;
  let fullPage = false;
  let format: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--uid" && i + 1 < args.length) {
      const raw = args[++i];
      uid = raw.startsWith("@") ? raw.slice(1) : raw;
    } else if (a === "--full-page") {
      fullPage = true;
    } else if (a === "--format" && i + 1 < args.length) {
      format = args[++i];
    } else if (!a.startsWith("--")) {
      filePath = a;
    }
  }

  return { filePath, uid, fullPage, format };
}

export function formatScreenshotOutput(filePath: string): string {
  return encode({ screenshot: filePath });
}

/** Parse MCP list_pages markdown into structured data. */
export function parsePagesList(text: string): { id: number; url: string; selected: boolean }[] {
  const pages: { id: number; url: string; selected: boolean }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+):\s+(\S+)(\s+\[selected\])?/);
    if (m) {
      pages.push({ id: parseInt(m[1], 10), url: m[2], selected: !!m[3] });
    }
  }
  return pages;
}

/** Format raw MCP text result as AXI output: labeled block + truncation + suggestions. */
export function formatMcpResult(label: string, text: string, suggestions: string[]): string {
  const blocks: string[] = [];
  const tr = truncateSnapshot(text, false, 2000);
  blocks.push(`${label}:\n${tr.text.trimEnd()}`);
  if (tr.truncated) {
    blocks[0] += `\n    ... (truncated, ${tr.totalLength} chars total)`;
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return renderOutput(blocks);
}

export function parseFillFormArgs(args: string[]): { entries: { uid: string; value: string }[] } {
  const entries: { uid: string; value: string }[] = [];
  for (const arg of args) {
    if (arg === "--full") continue;
    const match = arg.match(/^@([^=]+)=(.+)$/);
    if (!match) continue;
    const uid = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries.push({ uid, value });
  }
  return { entries };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface EmulateArgs extends Record<string, unknown> {
  viewport?: string;
  colorScheme?: string;
  networkConditions?: string;
  cpuThrottlingRate?: number;
  geolocation?: string;
  userAgent?: string;
}

export function parseEmulateArgs(args: string[]): EmulateArgs {
  const result: EmulateArgs = {};
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--viewport": result.viewport = args[++i]; break;
      case "--color-scheme": result.colorScheme = args[++i]; break;
      case "--network": result.networkConditions = args[++i]; break;
      case "--cpu": {
        const cpuThrottlingRate = parseOptionalInteger(args[++i]);
        if (cpuThrottlingRate !== undefined) {
          result.cpuThrottlingRate = cpuThrottlingRate;
        }
        break;
      }
      case "--geolocation": result.geolocation = args[++i]; break;
      case "--user-agent": result.userAgent = args[++i]; break;
    }
    i++;
  }
  return result;
}

export function parseConsoleArgs(args: string[]): { types?: string[]; pageSize?: number; pageIdx?: number } {
  const result: { types?: string[]; pageSize?: number; pageIdx?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) { result.types = [args[++i]]; }
    else if (args[i] === "--limit" && i + 1 < args.length) {
      const pageSize = parseOptionalInteger(args[++i]);
      if (pageSize !== undefined) result.pageSize = pageSize;
    }
    else if (args[i] === "--page" && i + 1 < args.length) {
      const pageIdx = parseOptionalInteger(args[++i]);
      if (pageIdx !== undefined) result.pageIdx = pageIdx;
    }
  }
  return result;
}

export function parseNetworkArgs(args: string[]): { resourceTypes?: string[]; pageSize?: number; pageIdx?: number } {
  const result: { resourceTypes?: string[]; pageSize?: number; pageIdx?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) { result.resourceTypes = [args[++i]]; }
    else if (args[i] === "--limit" && i + 1 < args.length) {
      const pageSize = parseOptionalInteger(args[++i]);
      if (pageSize !== undefined) result.pageSize = pageSize;
    }
    else if (args[i] === "--page" && i + 1 < args.length) {
      const pageIdx = parseOptionalInteger(args[++i]);
      if (pageIdx !== undefined) result.pageIdx = pageIdx;
    }
  }
  return result;
}

export function parseNetworkGetArgs(args: string[]): { reqid?: number; responseFilePath?: string; requestFilePath?: string } {
  const result: { reqid?: number; responseFilePath?: string; requestFilePath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--response-file" && i + 1 < args.length) { result.responseFilePath = args[++i]; }
    else if (args[i] === "--request-file" && i + 1 < args.length) { result.requestFilePath = args[++i]; }
    else if (!args[i].startsWith("--")) {
      const reqid = parseOptionalInteger(args[i]);
      if (reqid !== undefined) result.reqid = reqid;
    }
  }
  return result;
}

export function parseLighthouseArgs(args: string[]): { device?: string; mode?: string; outputDirPath?: string } {
  const result: { device?: string; mode?: string; outputDirPath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--device": result.device = args[++i]; break;
      case "--mode": result.mode = args[++i]; break;
      case "--output-dir": result.outputDirPath = args[++i]; break;
    }
  }
  return result;
}

export function parsePerfStartArgs(args: string[]): { reload?: boolean; autoStop?: boolean; filePath?: string } {
  const result: { reload?: boolean; autoStop?: boolean; filePath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--no-reload": result.reload = false; break;
      case "--no-auto-stop": result.autoStop = false; break;
      case "--file": result.filePath = args[++i]; break;
    }
  }
  return result;
}

function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

function renderError(message: string, code: string, suggestions: string[] = []): string {
  const blocks = [encode({ error: message, code })];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join("\n");
}

function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}

/**
 * Parse snapshot from an includeSnapshot response.
 * The response contains a "## Latest page snapshot" section.
 */
function parseSnapshotFromResponse(response: string): string | null {
  const marker = "## Latest page snapshot";
  const idx = response.indexOf(marker);
  if (idx === -1) return null;
  const after = response.slice(idx + marker.length);
  // The snapshot follows after the header line, possibly with a blank line
  const trimmed = after.replace(/^\s*\n/, "");
  // Snapshot ends at the next ## heading or end of text
  const nextHeading = trimmed.indexOf("\n## ");
  return nextHeading === -1 ? trimmed.trimEnd() : trimmed.slice(0, nextHeading).trimEnd();
}

/** Format page metadata (TOON) + raw snapshot + suggestions. */
function formatPageOutput(snapshot: string, command: string, url?: string, full = false): string {
  const title = extractTitle(snapshot);
  const refs = countRefs(snapshot);

  const blocks: string[] = [];

  // Page metadata as TOON
  const page: Record<string, unknown> = {};
  if (title) page.title = title;
  if (url) page.url = url;
  page.refs = refs;
  blocks.push(encode({ page }));

  // Raw snapshot (not TOON-encoded — already token-efficient tree format)
  const tr = truncateSnapshot(snapshot, full);
  let snapshotBlock = `snapshot:\n${tr.text.trimEnd()}`;
  if (tr.truncated) {
    snapshotBlock += `\n    ... (truncated, ${tr.totalLength} chars total)`;
  }
  blocks.push(snapshotBlock);

  // Contextual suggestions
  const suggestions = getSuggestions({ command, url, snapshot });
  if (tr.truncated) {
    suggestions.push(`Run \`chrome-devtools-axi ${command}${url ? " " + url : ""} --full\` to see complete snapshot`);
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }

  return renderOutput(blocks);
}

/** Strip everything before the actual accessibility tree (MCP may prepend status lines and headers). */
function stripSnapshotHeader(text: string): string {
  // Find the first line that looks like a tree node (uid= or RootWebArea)
  const lines = text.split("\n");
  const treeStart = lines.findIndex((l) => /\bRootWebArea\b|\buid=/.test(l));
  if (treeStart > 0) return lines.slice(treeStart).join("\n");
  // Fallback: strip known headers
  return text.replace(/^[\s\S]*?##\s+Latest page snapshot\s*\n/, "");
}

/** Strip leading @ from uid ref. */
function parseUid(arg: string): string {
  return arg.startsWith("@") ? arg.slice(1) : arg;
}

function isRecoverableOpenError(error: unknown): error is CdpError {
  if (!(error instanceof CdpError)) return false;
  if (error.code !== "BROWSER_ERROR") return false;
  return /not connected|session (?:closed|not found)|no page/i.test(error.message);
}

/**
 * Call a tool with includeSnapshot:true and extract the snapshot.
 * Falls back to a separate take_snapshot() if parsing fails.
 */
async function callWithSnapshot(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await callTool(name, { ...args, includeSnapshot: true });
  const snapshot = parseSnapshotFromResponse(result);
  if (snapshot && snapshot.length > 0) return stripSnapshotHeader(snapshot);
  // Fallback: take snapshot separately
  return stripSnapshotHeader(await callTool("take_snapshot"));
}

const SCROLL_FUNCTIONS: Record<string, string> = {
  up: "window.scrollBy(0, -500)",
  down: "window.scrollBy(0, 500)",
  top: "window.scrollTo(0, 0)",
  bottom: "window.scrollTo(0, document.body.scrollHeight)",
};

async function handleOpen(args: string[], full: boolean): Promise<string> {
  const url = args[0];
  if (!url) {
    throw new CdpError("Missing URL", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi open https://example.com` to navigate to a page",
    ]);
  }

  try {
    await callTool("navigate_page", { type: "url", url });
  } catch (error) {
    if (!isRecoverableOpenError(error)) {
      throw error;
    }
    await callTool("new_page", { url });
  }
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "open", url, full);
}

async function handleSnapshot(full: boolean): Promise<string> {
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "snapshot", undefined, full);
}

async function handleScreenshot(args: string[]): Promise<string> {
  const parsed = parseScreenshotArgs(args);
  if (!parsed.filePath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi screenshot ./page.png` to save a screenshot",
    ]);
  }

  const toolArgs: Record<string, unknown> = { filePath: parsed.filePath };
  if (parsed.uid) toolArgs.uid = parsed.uid;
  if (parsed.fullPage) toolArgs.fullPage = true;
  if (parsed.format) toolArgs.format = parsed.format;

  await callTool("take_screenshot", toolArgs);
  return formatScreenshotOutput(parsed.filePath);
}

async function handleClick(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi click @<uid>` — get uid from snapshot",
    ]);
  }

  const snapshot = await callWithSnapshot("click", { uid: parseUid(uid) });
  return formatPageOutput(snapshot, "click", undefined, full);
}

async function handleFill(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  const value = args.slice(1).join(" ");
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi fill @<uid> "text"` — get uid from snapshot',
    ]);
  }
  if (!value) {
    throw new CdpError("Missing fill text", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi fill @<uid> "text"` to fill the field',
    ]);
  }

  const snapshot = await callWithSnapshot("fill", { uid: parseUid(uid), value });
  return formatPageOutput(snapshot, "fill", undefined, full);
}

async function handlePress(args: string[], full: boolean): Promise<string> {
  const key = args[0];
  if (!key) {
    throw new CdpError("Missing key name", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi press Enter` to press a key",
    ]);
  }

  const snapshot = await callWithSnapshot("press_key", { key });
  return formatPageOutput(snapshot, "press", undefined, full);
}

async function handleType(args: string[], full: boolean): Promise<string> {
  const text = args.join(" ");
  if (!text) {
    throw new CdpError("Missing text", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi type "hello"` to type text',
    ]);
  }

  await callTool("type_text", { text });
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "type", undefined, full);
}

async function handleScroll(args: string[], full: boolean): Promise<string> {
  const dir = (args[0] ?? "down").toLowerCase();
  const fn = SCROLL_FUNCTIONS[dir];
  if (!fn) {
    throw new CdpError(`Unknown scroll direction: ${dir}`, "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi scroll down` — directions: up, down, top, bottom",
    ]);
  }

  await callTool("evaluate_script", { function: fn });
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "scroll", undefined, full);
}

async function handleBack(full: boolean): Promise<string> {
  await callTool("navigate_page", { type: "back" });
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "back", undefined, full);
}

async function handleWait(args: string[]): Promise<string> {
  const target = args[0];
  if (!target) {
    throw new CdpError("Missing wait target (milliseconds or text)", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi wait 2000` to wait 2 seconds",
      'Run `chrome-devtools-axi wait "Submit"` to wait for text to appear',
    ]);
  }

  const isNumeric = /^\d+$/.test(target);
  if (isNumeric) {
    await callTool("evaluate_script", {
      function: `new Promise(r => setTimeout(r, ${target}))`,
    });
  } else {
    await callTool("wait_for", { text: [target] });
  }

  const blocks: string[] = [];
  blocks.push(encode({ waited: target }));
  const suggestions = getSuggestions({ command: "wait" });
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return renderOutput(blocks);
}

/** Wrap JS input in an arrow function for MCP evaluate_script. */
function wrapJsExpression(js: string): string {
  return `() => (${js.trim()})`;
}

/** Extract the actual value from MCP evaluate_script response. */
function parseEvalResult(output: string): string {
  // MCP wraps results in: "Script ran on page and returned:\n```json\n<value>\n```"
  const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlock) return jsonBlock[1].trim();
  // Fallback: strip the preamble if present
  const preamble = "Script ran on page and returned:";
  if (output.includes(preamble)) return output.slice(output.indexOf(preamble) + preamble.length).trim();
  return output.trim();
}

async function handleEval(args: string[]): Promise<string> {
  const js = args.join(" ");
  if (!js) {
    throw new CdpError("Missing JavaScript expression", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi eval "document.title"` to evaluate JavaScript',
    ]);
  }

  const output = await callTool("evaluate_script", { function: wrapJsExpression(js) });

  const blocks: string[] = [];
  blocks.push(encode({ result: parseEvalResult(output) }));
  const suggestions = getSuggestions({ command: "eval" });
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return renderOutput(blocks);
}

async function handleStart(): Promise<string> {
  const port = await ensureBridge();
  return encode({ status: "ready", port });
}

export function formatStopOutput(wasStopped: boolean): string {
  return encode({ status: wasStopped ? "stopped" : "stopped (no-op)" });
}

async function handleStop(): Promise<string> {
  const wasStopped = await stopBridge();
  return formatStopOutput(wasStopped);
}

// --- Page management handlers ---

async function handlePages(): Promise<string> {
  const result = await callTool("list_pages");
  const pages = parsePagesList(result);
  if (pages.length === 0) {
    return "pages: 0 pages open";
  }
  const blocks: string[] = [];
  const header = `pages[${pages.length}]{id,url,selected}:`;
  const rows = pages.map((p) => `  ${p.id},${p.url},${p.selected}`);
  blocks.push(`${header}\n${rows.join("\n")}`);
  blocks.push(renderHelp([
    "Run `chrome-devtools-axi selectpage <id>` to switch tabs",
    "Run `chrome-devtools-axi newpage <url>` to open a new tab",
  ]));
  return renderOutput(blocks);
}

async function handleNewPage(args: string[], full: boolean): Promise<string> {
  const url = args.filter((a) => !a.startsWith("--"))[0];
  if (!url) {
    throw new CdpError("Missing URL", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi newpage https://example.com` to open a new tab",
    ]);
  }
  const background = args.includes("--background");
  const toolArgs: Record<string, unknown> = { url };
  if (background) toolArgs.background = true;
  await callTool("new_page", toolArgs);
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "newpage", url, full);
}

async function handleSelectPage(args: string[], full: boolean): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing page ID", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi selectpage <id>` — get ID from `pages` command",
    ]);
  }
  const pageId = parseInt(id, 10);
  if (isNaN(pageId)) {
    throw new CdpError(`Invalid page ID: ${id}`, "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi pages` to list available page IDs",
    ]);
  }
  await callTool("select_page", { pageId });
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "selectpage", undefined, full);
}

async function handleClosePage(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing page ID", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi closepage <id>` — get ID from `pages` command",
    ]);
  }
  const pageId = parseInt(id, 10);
  if (isNaN(pageId)) {
    throw new CdpError(`Invalid page ID: ${id}`, "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi pages` to list available page IDs",
    ]);
  }
  // Check page count before closing — last page can't be closed
  const beforeResult = await callTool("list_pages");
  const pagesBefore = parsePagesList(beforeResult);
  if (pagesBefore.length <= 1) {
    const blocks = [encode({ status: "cannot close the last open page (no-op)" })];
    blocks.push(renderHelp([
      "Run `chrome-devtools-axi newpage <url>` to open another tab first",
      "Run `chrome-devtools-axi stop` to shut down the browser entirely",
    ]));
    return renderOutput(blocks);
  }
  await callTool("close_page", { pageId });
  return encode({ status: "closed", pageId });
}

async function handleResize(args: string[]): Promise<string> {
  const [widthStr, heightStr] = args;
  if (!widthStr || !heightStr) {
    throw new CdpError("Missing width and/or height", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi resize 1280 720` to resize the viewport",
    ]);
  }
  const width = parseInt(widthStr, 10);
  const height = parseInt(heightStr, 10);
  if (isNaN(width) || isNaN(height)) {
    throw new CdpError("Width and height must be numbers", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi resize 1280 720` to resize the viewport",
    ]);
  }
  await callTool("resize_page", { width, height });
  return encode({ resized: { width, height } });
}

// --- Interaction handlers ---

async function handleHover(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi hover @<uid>` — get uid from snapshot",
    ]);
  }
  const snapshot = await callWithSnapshot("hover", { uid: parseUid(uid) });
  return formatPageOutput(snapshot, "hover", undefined, full);
}

async function handleDrag(args: string[], full: boolean): Promise<string> {
  const from = args[0];
  const to = args[1];
  if (!from || !to) {
    throw new CdpError("Missing element refs", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi drag @<from> @<to>` — get uids from snapshot",
    ]);
  }
  const snapshot = await callWithSnapshot("drag", { from_uid: parseUid(from), to_uid: parseUid(to) });
  return formatPageOutput(snapshot, "drag", undefined, full);
}

async function handleFillForm(args: string[], full: boolean): Promise<string> {
  const { entries } = parseFillFormArgs(args);
  if (entries.length === 0) {
    throw new CdpError("No valid field entries", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi fillform @1="hello" @2="world"` to fill multiple fields',
    ]);
  }
  const snapshot = await callWithSnapshot("fill_form", { elements: entries });
  return formatPageOutput(snapshot, "fillform", undefined, full);
}

async function handleDialog(args: string[]): Promise<string> {
  const action = args[0];
  if (!action || (action !== "accept" && action !== "dismiss")) {
    throw new CdpError("Missing or invalid action", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi dialog accept` or `chrome-devtools-axi dialog dismiss`",
    ]);
  }
  const params: Record<string, unknown> = { action };
  const promptText = args.slice(1).join(" ");
  if (promptText) params.promptText = promptText;
  await callTool("handle_dialog", params);
  return encode({ dialog: action });
}

async function handleUpload(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  const filePath = args[1];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi upload @<uid> <path>` — get uid from snapshot",
    ]);
  }
  if (!filePath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi upload @<uid> /path/to/file` to upload a file",
    ]);
  }
  const snapshot = await callWithSnapshot("upload_file", { uid: parseUid(uid), filePath });
  return formatPageOutput(snapshot, "upload", undefined, full);
}

// --- Emulation handler ---

async function handleEmulate(args: string[]): Promise<string> {
  const parsed = parseEmulateArgs(args);
  await callTool("emulate", parsed);
  return encode({ emulated: parsed });
}

// --- DevTools debugging handlers ---

async function handleConsole(args: string[]): Promise<string> {
  const parsed = parseConsoleArgs(args);
  const result = await callTool("list_console_messages", parsed);
  return formatMcpResult("console", result, [
    "Run `chrome-devtools-axi console-get <id>` to see a specific message",
    "Run `chrome-devtools-axi console --type error` to filter by type",
  ]);
}

async function handleConsoleGet(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing console message id", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi console-get <id>` — get id from `chrome-devtools-axi console`",
    ]);
  }
  const msgid = parseOptionalInteger(id);
  if (msgid === undefined) {
    throw new CdpError(`Invalid console message id: ${id}`, "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi console` to list available message ids",
    ]);
  }
  const result = await callTool("get_console_message", { msgid });
  return formatMcpResult("message", result, []);
}

async function handleNetwork(args: string[]): Promise<string> {
  const parsed = parseNetworkArgs(args);
  const result = await callTool("list_network_requests", parsed);
  return formatMcpResult("network", result, [
    "Run `chrome-devtools-axi network-get <id>` to see request details",
    "Run `chrome-devtools-axi network --type fetch` to filter by type",
  ]);
}

async function handleNetworkGet(args: string[]): Promise<string> {
  const parsed = parseNetworkGetArgs(args);
  const result = await callTool("get_network_request", parsed);
  return formatMcpResult("request", result, []);
}

// --- Performance handlers ---

async function handleLighthouse(args: string[]): Promise<string> {
  const opts = parseLighthouseArgs(args);
  const result = await callTool("lighthouse_audit", opts);
  return formatMcpResult("lighthouse", result, []);
}

async function handlePerfStart(args: string[]): Promise<string> {
  const opts = parsePerfStartArgs(args);
  await callTool("performance_start_trace", opts);
  return encode({ trace: "started", ...opts });
}

async function handlePerfStop(args: string[]): Promise<string> {
  const toolArgs: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") toolArgs.filePath = args[++i];
  }
  const result = await callTool("performance_stop_trace", toolArgs);
  return formatMcpResult("trace", result, [
    "Run `chrome-devtools-axi perf-insight <set-id> <insight-name>` to analyze insights",
  ]);
}

async function handlePerfInsight(args: string[]): Promise<string> {
  const [setId, insightName] = args;
  if (!setId || !insightName) {
    throw new CdpError("Missing required arguments", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi perf-insight <set-id> <insight-name>` to analyze an insight",
    ]);
  }
  const result = await callTool("performance_analyze_insight", { insightSetId: setId, insightName });
  return formatMcpResult("insight", result, []);
}

async function handleHeap(args: string[]): Promise<string> {
  const filePath = args[0];
  if (!filePath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi heap ./snapshot.heapsnapshot` to take a heap snapshot",
    ]);
  }
  await callTool("take_memory_snapshot", { filePath });
  return encode({ heap: filePath });
}

async function handleHome(full: boolean): Promise<string> {
  const result = await getSessionSnapshotIfRunning();
  if (!result) {
    const blocks = [encode({ browser: "no active session" })];
    blocks.push(renderHelp(["Run `chrome-devtools-axi open <url>` to start browsing"]));
    return renderOutput(blocks);
  }
  const snapshot = stripSnapshotHeader(result);
  return formatPageOutput(snapshot, "snapshot", undefined, full);
}

export async function main(argv: string[]): Promise<void> {
  // Best-effort hook installation on every invocation
  try { installHooks(); } catch { /* silent */ }

  const args = [...argv];

  const full = args.includes("--full");
  const filteredArgs = args.filter((a) => a !== "--full");
  const command = filteredArgs[0] ?? "";
  const commandArgs = filteredArgs.slice(1);

  // Per-subcommand help: `chrome-devtools-axi open --help`
  if (command && (commandArgs.includes("--help") || commandArgs.includes("-h"))) {
    const help = getCommandHelp(command);
    if (help) {
      process.stdout.write(help + "\n");
      return;
    }
  }

  // Global help: `chrome-devtools-axi --help`
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  try {
    let output: string;

    switch (command) {
      case "open":
        output = await handleOpen(commandArgs, full);
        break;
      case "snapshot":
        output = await handleSnapshot(full);
        break;
      case "screenshot":
        output = await handleScreenshot(commandArgs);
        break;
      case "click":
        output = await handleClick(commandArgs, full);
        break;
      case "fill":
        output = await handleFill(commandArgs, full);
        break;
      case "type":
        output = await handleType(commandArgs, full);
        break;
      case "press":
        output = await handlePress(commandArgs, full);
        break;
      case "scroll":
        output = await handleScroll(commandArgs, full);
        break;
      case "back":
        output = await handleBack(full);
        break;
      case "wait":
        output = await handleWait(commandArgs);
        break;
      case "eval":
        output = await handleEval(commandArgs);
        break;
      case "hover":
        output = await handleHover(commandArgs, full);
        break;
      case "drag":
        output = await handleDrag(commandArgs, full);
        break;
      case "fillform":
        output = await handleFillForm(commandArgs, full);
        break;
      case "dialog":
        output = await handleDialog(commandArgs);
        break;
      case "upload":
        output = await handleUpload(commandArgs, full);
        break;
      case "pages":
        output = await handlePages();
        break;
      case "newpage":
        output = await handleNewPage(commandArgs, full);
        break;
      case "selectpage":
        output = await handleSelectPage(commandArgs, full);
        break;
      case "closepage":
        output = await handleClosePage(commandArgs);
        break;
      case "resize":
        output = await handleResize(commandArgs);
        break;
      case "emulate":
        output = await handleEmulate(commandArgs);
        break;
      case "console":
        output = await handleConsole(commandArgs);
        break;
      case "console-get":
        output = await handleConsoleGet(commandArgs);
        break;
      case "network":
        output = await handleNetwork(commandArgs);
        break;
      case "network-get":
        output = await handleNetworkGet(commandArgs);
        break;
      case "lighthouse":
        output = await handleLighthouse(commandArgs);
        break;
      case "perf-start":
        output = await handlePerfStart(commandArgs);
        break;
      case "perf-stop":
        output = await handlePerfStop(commandArgs);
        break;
      case "perf-insight":
        output = await handlePerfInsight(commandArgs);
        break;
      case "heap":
        output = await handleHeap(commandArgs);
        break;
      case "start":
        output = await handleStart();
        break;
      case "stop":
        output = await handleStop();
        break;
      case "":
        // No command = home view (status if running, hint if not)
        output = await handleHome(full);
        break;
      default:
        process.stdout.write(
          renderError(`Unknown command: ${command}`, "UNKNOWN", [
            "Run `chrome-devtools-axi --help` to see available commands",
          ]) + "\n",
        );
        process.exitCode = 1;
        return;
    }

    process.stdout.write(output + "\n");
  } catch (err) {
    if (err instanceof CdpError) {
      process.stdout.write(renderError(err.message, err.code, err.suggestions) + "\n");
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(renderError(message, "UNKNOWN") + "\n");
    }
    process.exitCode = 1;
  }
}
