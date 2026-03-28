import { encode } from "@toon-format/toon";
import { CdpError, callTool, ensureBridge, getSessionStatus, stopBridge } from "./client.js";
import { installHooks } from "./hooks.js";
import { countRefs, extractTitle, truncateSnapshot } from "./snapshot.js";
import { getSuggestions } from "./suggestions.js";

const HELP = `usage: chrome-devtools-axi <command> [args]
commands[12]:
  open <url>, snapshot, click @<uid>, fill @<uid> <text>, type <text>,
  press <key>, scroll <dir>, back, wait <ms|text>, eval <js>, start, stop
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
};

export function getCommandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
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

/** Strip the `## Latest page snapshot` header that chrome-devtools-mcp prepends. */
function stripSnapshotHeader(text: string): string {
  return text.replace(/^##\s+Latest page snapshot\s*\n/, "");
}

/** Strip leading @ from uid ref. */
function parseUid(arg: string): string {
  return arg.startsWith("@") ? arg.slice(1) : arg;
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

  await callTool("navigate_page", { type: "url", url });
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "open", url, full);
}

async function handleSnapshot(full: boolean): Promise<string> {
  const snapshot = stripSnapshotHeader(await callTool("take_snapshot"));
  return formatPageOutput(snapshot, "snapshot", undefined, full);
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

async function handleEval(args: string[]): Promise<string> {
  const js = args.join(" ");
  if (!js) {
    throw new CdpError("Missing JavaScript expression", "VALIDATION_ERROR", [
      'Run `chrome-devtools-axi eval "document.title"` to evaluate JavaScript',
    ]);
  }

  const output = await callTool("evaluate_script", { function: js });

  const blocks: string[] = [];
  blocks.push(encode({ result: output.trim() }));
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

async function handleHome(full: boolean): Promise<string> {
  const result = await getSessionStatus();
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

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

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

  try {
    let output: string;

    switch (command) {
      case "open":
        output = await handleOpen(commandArgs, full);
        break;
      case "snapshot":
        output = await handleSnapshot(full);
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
