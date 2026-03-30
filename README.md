<h1 align="center">chrome-devtools-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/chrome-devtools-axi"><img alt="npm" src="https://img.shields.io/npm/v/chrome-devtools-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/chrome-devtools-axi/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/chrome-devtools-axi/release-please.yml?style=flat-square&label=Release" /></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://x.com/kunchenguid"><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square" /></a>
  <a href="https://discord.gg/BW4aJuQhTf"><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord" /></a>
</p>

<h3 align="center">The most agent-ergonomic browser automation</h3>

`chrome-devtools-axi` wraps [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp) with an [AXI](https://axi.md)-compliant CLI.

- **Token-efficient** — TOON-encoded output cuts token usage ~40% vs raw JSON
- **Combined operations** — one command navigates, captures, and suggests next steps
- **Contextual suggestions** — every response includes actionable next-step hints

## Quick Start

```sh
$ chrome-devtools-axi open https://example.com
page: {title: "Example Domain", url: "https://example.com", refs: 1}
snapshot:
RootWebArea "Example Domain"
  heading "Example Domain"
  paragraph "This domain is for use in illustrative examples..."
  uid=1 link "More information..."
help[1]:
  Run `chrome-devtools-axi click @1` to click the "More information..." link

$ chrome-devtools-axi click @1
page: {title: "IANA — IANA-Managed Reserved Domains", refs: 12}
snapshot:
...
```

## Install

**Tell your agent:**

```
Execute `npm i -g chrome-devtools-axi` and run `chrome-devtools-axi` for browser automation.
```

## How It Works

```
┌───────────────────────┐
│  chrome-devtools-axi  │  CLI — parse args, format output
└──────────┬────────────┘
           │ HTTP (localhost:9224)
           ▼
┌───────────────────────┐
│     Bridge Server     │  Persistent process, manages MCP session
└──────────┬────────────┘
           │ stdio
           ▼
┌───────────────────────┐
│  chrome-devtools-mcp  │  Headless Chrome via DevTools Protocol
└───────────────────────┘
```

- **Persistent bridge** — a detached process keeps the MCP session alive across commands, so Chrome doesn't restart every invocation
- **Auto-lifecycle** — the bridge starts on first command and writes a PID file to `~/.chrome-devtools-axi/bridge.pid`
- **Snapshot parsing** — accessibility tree snapshots are extracted and analyzed for interactive elements (`uid=` refs)
- **TOON encoding** — structured metadata uses [TOON format](https://www.npmjs.com/package/@toon-format/toon) for compact, token-efficient output

## CLI Reference

### Navigation

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `open <url>`      | Navigate to URL and snapshot        |
| `snapshot`        | Capture current page state          |
| `screenshot <p>`  | Save a screenshot to a file         |
| `scroll <dir>`    | Scroll: up, down, top, bottom       |
| `back`            | Navigate back                       |
| `wait <ms\|text>` | Wait for time or text to appear     |
| `eval <js>`       | Evaluate a JavaScript expression or function |
| `run`             | Execute a multi-step script from stdin |

`eval` wraps plain input as `() => (<expr>)` before sending it to DevTools. For multi-statement logic, pass an arrow function, `function`, or IIFE yourself.

```sh
chrome-devtools-axi eval "document.title"
chrome-devtools-axi eval "(() => { const rows = [...document.querySelectorAll('tr')]; return rows.map((row) => row.textContent) })()"
```

### Interaction

| Command                    | Description                    |
| -------------------------- | ------------------------------ |
| `click @<uid>`             | Click an element by ref        |
| `fill @<uid> <text>`       | Fill a form field              |
| `type <text>`              | Type text at current focus     |
| `press <key>`              | Press a keyboard key           |
| `hover @<uid>`             | Hover over an element          |
| `drag @<from> @<to>`       | Drag an element onto another   |
| `fillform @<uid>=<val>...` | Fill multiple form fields      |
| `dialog <accept\|dismiss>` | Handle a browser dialog        |
| `upload @<uid> <path>`     | Upload a file through an input |

### Page Management

| Command           | Description                 |
| ----------------- | --------------------------- |
| `pages`           | List all open tabs          |
| `newpage <url>`   | Open a new tab              |
| `selectpage <id>` | Switch to a tab by ID       |
| `closepage <id>`  | Close a tab by ID           |
| `resize <w> <h>`  | Resize the browser viewport |

### Emulation

| Command   | Description                     |
| --------- | ------------------------------- |
| `emulate` | Emulate device/network/viewport |

### DevTools Debugging

| Command            | Description                    |
| ------------------ | ------------------------------ |
| `console`          | List console messages          |
| `console-get <id>` | Get a specific console message |
| `network`          | List network requests          |
| `network-get [id]` | Get a specific network request |

### Performance

| Command                     | Description                   |
| --------------------------- | ----------------------------- |
| `lighthouse`                | Run a Lighthouse audit        |
| `perf-start`                | Start a performance trace     |
| `perf-stop`                 | Stop the performance trace    |
| `perf-insight <set> <name>` | Analyze a performance insight |
| `heap <path>`               | Capture a heap snapshot       |

### Bridge

| Command | Description             |
| ------- | ----------------------- |
| `start` | Start the bridge server |
| `stop`  | Stop the bridge server  |

Running with no command is equivalent to `snapshot`.

### Flags

| Flag                        | Description                                 |
| --------------------------- | ------------------------------------------- |
| `--help`                    | Show usage information                      |
| `--full`                    | Show complete snapshot without truncation   |
| `--background`              | Open new page in background (newpage)       |
| `--uid @<uid>`              | Target a specific element (screenshot)      |
| `--full-page`               | Capture entire scrollable page (screenshot) |
| `--format <fmt>`            | Image format: png, jpeg, webp (screenshot)  |
| `--viewport <spec>`         | Viewport like "390x844x3,mobile" (emulate)  |
| `--color-scheme <value>`    | dark, light, or auto (emulate)              |
| `--network <condition>`     | Network throttle: Slow 3G, etc. (emulate)   |
| `--cpu <rate>`              | CPU throttling rate 1-20 (emulate)          |
| `--geolocation <lat>x<lon>` | Set geolocation (emulate)                   |
| `--user-agent <string>`     | Custom user agent (emulate)                 |
| `--type <type>`             | Filter by type (console, network)           |
| `--limit <n>`               | Max items to return (console, network)      |
| `--page <n>`                | Pagination (console, network)               |
| `--device <device>`         | desktop or mobile (lighthouse)              |
| `--mode <mode>`             | navigation or snapshot (lighthouse)         |
| `--output-dir <path>`       | Directory for reports (lighthouse)          |
| `--no-reload`               | Skip page reload (perf-start)               |
| `--no-auto-stop`            | Disable auto-stop (perf-start)              |
| `--file <path>`             | Save trace data to file (perf-start/stop)   |
| `--response-file <path>`    | Save response body (network-get)            |
| `--request-file <path>`     | Save request body (network-get)             |

## Configuration

The bridge server port defaults to `9224`. Override it with an environment variable:

```sh
export CHROME_DEVTOOLS_AXI_PORT=9225
```

State is stored in `~/.chrome-devtools-axi/`:

| File         | Purpose                            |
| ------------ | ---------------------------------- |
| `bridge.pid` | PID and port of the running bridge |

## Development

```sh
npm run build      # Compile TypeScript to dist/
npm run dev        # Run CLI directly with tsx
npm test           # Run tests with vitest
npm run test:watch # Run tests in watch mode
```
