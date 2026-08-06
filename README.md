<h1 align="center">chrome-devtools-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/chrome-devtools-axi"><img alt="npm" src="https://img.shields.io/npm/v/chrome-devtools-axi?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/chrome-devtools-axi/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/chrome-devtools-axi/release-please.yml?style=flat-square&label=Release" /></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://x.com/kunchenguid"><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square" /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord" /></a>
</p>

<h3 align="center">The most agent-ergonomic browser automation</h3>

`chrome-devtools-axi` wraps [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp) with an [AXI](https://axi.md)-compliant CLI.

- **Token-efficient** — TOON-encoded output cuts token usage ~40% vs raw JSON
- **Combined operations** — one command navigates, captures, and suggests next steps
- **Contextual suggestions** — every response includes actionable next-step hints

## Benchmarks

Agent ergonomics is measurable.
The [axi benchmark](https://axi.md) runs the same 14 real-world browsing tasks (Wikipedia research, GitHub navigation, multi-site comparison, and more) through 7 browser automation setups - 5 repeats each, with `claude-sonnet-4-6` as the agent and an LLM judge scoring task success.

chrome-devtools-axi posts the lowest input tokens, cost, duration, and turn count of all 7 conditions, with 100% task success:

| Condition                            | Avg Input Tokens | Avg Cost/Task | Avg Duration | Avg Turns | Success  |
| ------------------------------------ | ---------------- | ------------- | ------------ | --------- | -------- |
| **chrome-devtools-axi**              | **79,141**       | **$0.074**    | **21.5s**    | **4.5**   | **100%** |
| dev-browser                          | 82,532           | $0.078        | 28.6s        | 4.9       | 99%      |
| agent-browser (Vercel)               | 93,074           | $0.088        | 24.6s        | 4.8       | 99%      |
| chrome-devtools-mcp + compressor CLI | 130,779          | $0.091        | 29.7s        | 7.6       | 100%     |
| chrome-devtools-mcp + ToolSearch     | 133,712          | $0.096        | 29.4s        | 7.5       | 99%      |
| chrome-devtools-mcp (raw MCP)        | 184,711          | $0.101        | 26.0s        | 6.2       | 99%      |
| chrome-devtools-mcp code execution   | 129,606          | $0.120        | 36.2s        | 6.4       | 100%     |

Against raw chrome-devtools-mcp - the very server this CLI wraps - that is 57% fewer input tokens, 26% lower cost, and 27% fewer agent turns.

## Quick Start

Install the chrome-devtools-axi skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/chrome-devtools-axi --skill chrome-devtools-axi -g
```

That is the entire setup - no npm install needed.
The skill teaches your agent to run chrome-devtools-axi through `npx -y chrome-devtools-axi`, so the CLI comes along on demand.

The skill is not a user-facing slash command (`user-invocable: false`).
Just ask for anything that needs a real browser - opening a page, clicking through a flow, extracting page content, debugging console or network, auditing performance - and the agent loads the skill on its own when it recognizes the task.
For ordinary web search, curl-able pages, or static extraction, the skill tells agents to skip Chrome and use simpler fetch/curl-style tooling.
The skill frontmatter also includes Hermes Agent metadata (`author` plus `metadata.hermes` tags/category) so Hermes can list it as a first-class browser automation skill; other harnesses ignore those extra fields.

`-g` installs the skill for all projects (`~/.claude/skills/`, for example); drop it to install for the current project only (`.claude/skills/`).

## What Agent Sees

```sh
$ chrome-devtools-axi open https://example.com
page: {title: "Example Domain", url: "https://example.com", refs: 1}
snapshot:
RootWebArea "Example Domain"
  heading "Example Domain"
  paragraph "This domain is for use in illustrative examples..."
  uid=g1:1 link "More information..."
help[1]:
  Run `chrome-devtools-axi click @g1:1` to click the "More information..." link

$ chrome-devtools-axi click @g1:1
page: {title: "IANA — IANA-Managed Reserved Domains", refs: 12}
snapshot:
...
```

Refs in snapshot output carry a `g<N>:` generation prefix that bumps every time a new accessibility tree is captured. Pass refs back exactly as printed - if the page re-rendered between snapshot and action, the action fails loudly with `STALE_REF` instead of silently no-op'ing, so the agent re-snapshots and retries.
The skill also instructs agents to verify state-changing actions with a fresh snapshot, `eval`, or screenshot before reporting success, because a current ref can still produce no visible page change.

## Other Ways to Install

The skill is the recommended path, but it is not the only one.

### Zero setup

chrome-devtools-axi is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Execute `npx -y chrome-devtools-axi` to get browser automation tools.
```

### Session hook

Want ambient browser context - including the live page state of an active session - fed into every agent session instead of loading on demand?
Install the CLI globally and opt into the hook:

```sh
npm install -g chrome-devtools-axi
chrome-devtools-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode** that surfaces the current browser session and records a 120-second idle policy for later browser commands in that agent session. Activity renews the policy, and it expires after 120 seconds without a command when an agent lacks a shutdown callback. **Pi** gets the equivalent native extension: `session_start` captures ambient AXI context for its agent prompt, and `session_shutdown` stops the owned browser session. Claude Code and Codex also get a managed `SessionEnd` hook that runs `chrome-devtools-axi stop` during session teardown and clears the policy.

Pi installs into `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/chrome-devtools-axi.ts`. Run setup with `PI_CODING_AGENT_DIR` set when you use an isolated Pi profile such as Fleet's `~/.pi-fleet` profile.
**Restart your agent session after running this** so the new hook takes effect.

Development entrypoints such as `pnpm run dev` and `bin/chrome-devtools-axi.ts` are guarded from accidental hook installation.

### From source

```sh
git clone https://github.com/kunchenguid/chrome-devtools-axi.git
cd chrome-devtools-axi
pnpm install --frozen-lockfile
pnpm run build
pnpm link
```

Use a Node version allowed by the `engines.node` declaration in `package.json`; it matches the packaged `chrome-devtools-mcp` runtime requirement.

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

- **Persistent bridge** — a detached process keeps the MCP session alive across commands, so Chrome doesn't restart every invocation; optional pooling hashes many logical sessions onto a bounded number of bridge/browser processes
- **Auto-lifecycle** — the bridge starts on first command, writes an observable PID file to `~/.chrome-devtools-axi/bridge.pid`, recycles stale CDP targets after a deep health check, shuts down after 30 idle minutes, and reaps child processes on stop
- **Snapshot parsing** — accessibility tree snapshots are extracted and analyzed for interactive elements (`uid=` refs)
- **TOON encoding** — structured metadata uses [TOON format](https://www.npmjs.com/package/@toon-format/toon) for compact, token-efficient output

## CLI Reference

### Navigation

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `open <url>`      | Navigate to URL and snapshot                 |
| `snapshot`        | Capture current page state                   |
| `screenshot <p>`  | Save a screenshot to a file                  |
| `scroll <dir>`    | Scroll: up, down, top, bottom                |
| `back`            | Navigate back                                |
| `wait <ms\|text>` | Wait for time or text to appear              |
| `eval <js>`       | Evaluate a JavaScript expression or function |
| `run`             | Execute a multi-step script from stdin       |

`eval` wraps plain input as `() => (<expr>)` before sending it to DevTools. For multi-statement logic, pass an arrow function or `function`. No-arg IIFE form `(...)()` is accepted too and unwrapped automatically.

```sh
chrome-devtools-axi eval "document.title"
chrome-devtools-axi eval "() => { const rows = [...document.querySelectorAll('tr')]; return rows.map((row) => row.textContent) }"
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

| Command           | Description                              |
| ----------------- | ---------------------------------------- |
| `pages`           | List tabs; caller-owned tabs when pooled |
| `newpage <url>`   | Open a new tab                           |
| `selectpage <id>` | Switch to a tab by ID                    |
| `closepage <id>`  | Close a tab by ID                        |
| `resize <w> <h>`  | Resize the browser viewport              |

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

For large request or response bodies, prefer `network-get <id> --response-file <path>` or `--request-file <path>` so the body goes to disk instead of flooding agent context.

### Performance

| Command                     | Description                   |
| --------------------------- | ----------------------------- |
| `lighthouse`                | Run a Lighthouse audit        |
| `perf-start`                | Start a performance trace     |
| `perf-stop`                 | Stop the performance trace    |
| `perf-insight <set> <name>` | Analyze a performance insight |
| `heap <path>`               | Capture a heap snapshot       |

### Bridge

| Command       | Description                                    |
| ------------- | ---------------------------------------------- |
| `start`       | Start or reuse the session's bridge            |
| `stop`        | Stop its bridge, or release its pooled pages   |
| `sessions`    | Inspect bridge session state                   |
| `setup hooks` | Install or repair agent lifecycle integrations |

### Maintenance

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `update`         | Upgrade the installed CLI to the latest npm version    |
| `update --check` | Report current vs latest version without installing it |

Running with no command shows the CLI home view. It prepends `bin` and
`description` metadata, then includes the current snapshot when a browser
session is active or the no-session status/help block when one is not.

### Flags

| Flag                        | Description                                 |
| --------------------------- | ------------------------------------------- |
| `--help`                    | Show usage information                      |
| `-v`, `-V`, `--version`     | Show the installed CLI version              |
| `--idle-timeout-ms <ms>`    | Set unpooled bridge or pooled-route timeout |
| `--check`                   | Check for available updates (update)        |
| `--full`                    | Show complete output without truncation     |
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

Local output paths for `screenshot`, `heap`, `network-get --response-file`/`--request-file`, `lighthouse --output-dir`, and `perf-start`/`perf-stop --file` resolve against the directory where you invoke the CLI.
Saved-path output uses the resolved absolute path.

`console --type` accepts `log`, `debug`, `info`, `error`, `warn`, `dir`, `dirxml`, `table`, `trace`, `clear`, `startGroup`, `startGroupCollapsed`, `endGroup`, `assert`, `profile`, `profileEnd`, `count`, `timeEnd`, `verbose`, `issue`, and `all`.
`network --type` accepts `document`, `stylesheet`, `image`, `media`, `font`, `script`, `texttrack`, `xhr`, `fetch`, `prefetch`, `eventsource`, `websocket`, `manifest`, `signedexchange`, `ping`, `cspviolationreport`, `preflight`, `fedcm`, `other`, and `all`.
For both commands, `all` or an omitted `--type` returns every item.

## Configuration

The bridge server port defaults to `9224`. Override it with an environment variable:

```sh
export CHROME_DEVTOOLS_AXI_PORT=9225
```

An unpooled bridge stays alive between commands, then shuts down its MCP and
browser processes after 30 minutes without a request. Override that idle
window in milliseconds when a workflow needs longer pauses:

```sh
export CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS=7200000
```

Agent-facing integrations installed by `chrome-devtools-axi setup hooks`
persist a 120-second idle policy for the logical agent session, and the packaged
skill passes the equivalent portable `--idle-timeout-ms=120000` option on every
command. Direct CLI users keep the 30-minute default unless they pass the flag
or set `CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS` themselves.

The effective timeout precedence is the command-line flag, then
`CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS`, then a persisted agent-session policy,
then 30 minutes. In unpooled mode, a request carrying an effective timeout
updates the running bridge watchdog. In pooled mode, it updates only the
calling logical session's route deadline; it never shortens another route or
the physical pool-slot watchdog, which retains the 30-minute default.

Normal installs start the pinned `chrome-devtools-mcp` binary from
chrome-devtools-axi's dependency graph. `CHROME_DEVTOOLS_AXI_MCP_PATH` is an
explicit development or emergency override; if neither path is available, the
bridge checks a global npm install and finally runs the same pinned MCP version
through `npx`.

Connect to an existing Chrome instance instead of launching one:

```sh
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
```

Browser pooling can't be combined with `CHROME_DEVTOOLS_AXI_BROWSER_URL` or
`CHROME_DEVTOOLS_AXI_AUTO_CONNECT`: an attached browser survives bridge
restarts, but its page ownership does not, so cleanup could no longer identify
which logical session owns each tab.

`CHROME_DEVTOOLS_AXI_BROWSER_URL` accepts both `http://` or `https://` URLs and `ws://` or `wss://` endpoints:

- `http(s)://` uses `--browserUrl` and fetches `/json/version` to discover the WebSocket URL.
- `ws(s)://` uses `--wsEndpoint` directly.

For authenticated `ws://` or `wss://` endpoints, pass JSON headers with `CHROME_DEVTOOLS_AXI_WS_HEADERS`:

```sh
export CHROME_DEVTOOLS_AXI_BROWSER_URL=wss://cluster.example/launch
export CHROME_DEVTOOLS_AXI_WS_HEADERS='{"Authorization":"Bearer token"}'
```

Pick which installed Chrome release channel to target with `CHROME_DEVTOOLS_AXI_CHANNEL` - `stable` (the default), `beta`, `canary`, or `dev`:

```sh
export CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1
export CHROME_DEVTOOLS_AXI_CHANNEL=beta
```

This selects which Chrome `--autoConnect` attaches to, and which one is launched in the default and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` modes.
It is ignored when `CHROME_DEVTOOLS_AXI_BROWSER_URL` is set, since that connects to an explicit endpoint regardless of channel.

### Keychain isolation

When chrome-devtools-axi launches Chrome itself - the default `--isolated` mode and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` - it always passes `--use-mock-keychain` and `--password-store=basic`.
An automation browser has no business reading, writing, or offering to reset your OS password store, so it is kept off it entirely.
Password autofill and saved-password access are therefore intentionally unavailable inside browsers this tool launches.
On macOS this also means the browser can never raise the system "Keychain Not Found ... Reset To Defaults" panel, which Chrome triggers when it tries to store its `Chrome Safe Storage` key and no default keychain can be resolved for the process.

Your own externally launched Chrome is unaffected: its saved passwords remain available and untouched because this tool does not read, write, move, or reset the login keychain or its `Chrome Safe Storage` item.
The isolation flags apply only to browsers this tool starts and are deliberately not sent in the `CHROME_DEVTOOLS_AXI_AUTO_CONNECT`, `CHROME_DEVTOOLS_AXI_BROWSER_URL`, and `wsEndpoint` modes, where the browser belongs to whoever launched it.

Run multiple isolated bridges at once with `CHROME_DEVTOOLS_AXI_SESSION` - one per agent session, worktree, or test worker:

```sh
CHROME_DEVTOOLS_AXI_SESSION=worker-1 chrome-devtools-axi open https://example.com
CHROME_DEVTOOLS_AXI_SESSION=worker-2 chrome-devtools-axi open https://example.org
```

Without pooling, each session name gets its own bridge process, port (auto-derived from the name, or pinned with `CHROME_DEVTOOLS_AXI_PORT`), and on-disk state.
In the default `--isolated` and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` launch modes each bridge also launches its own Chrome, so concurrent sessions share neither browser state nor each other's stale-ref tracking.
Sessions that attach to the same external browser - multiple `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1` sessions on one running Chrome, or the same `CHROME_DEVTOOLS_AXI_BROWSER_URL`/`wsEndpoint` - drive that shared browser and are isolated only at the bridge level, where the per-session generation counter does not prevent cross-talk.
A session only isolates the bridge - the connection mode and profile are unchanged; combine with `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` for a persistent per-session profile.
The default (unset) session keeps port 9224 and the legacy state paths below.

Do not export `CHROME_DEVTOOLS_AXI_PORT` globally when running concurrent sessions: it overrides the per-session derived port and forces every session onto the same port, so the second session fails to start - its bridge cannot bind the already-taken port, and the first session's bridge is rejected as a mismatch rather than silently shared.
Rely on the per-session default ports instead, or set `CHROME_DEVTOOLS_AXI_PORT` only inline per command.

For high agent counts where one Chrome per named session is too heavy, opt into a bounded browser pool:

```sh
export CHROME_DEVTOOLS_AXI_POOL_SIZE=4
CHROME_DEVTOOLS_AXI_SESSION=worker-1 chrome-devtools-axi open https://example.com
CHROME_DEVTOOLS_AXI_SESSION=worker-2 chrome-devtools-axi open https://example.org
```

With pooling enabled, logical session state still lives under `sessions/<name>/`, but browser traffic hashes onto `pool-0` through `pool-(N-1)`.
Each pooled bridge serializes its own browser calls and restores the logical session's selected page before every routed operation, so text/code agent concurrency stays high while browser concurrency is bounded by the pool size. `pages`, `selectpage`, and `closepage` are scoped to pages owned by the calling session, and pages opened as click or script side effects are claimed by that same owner.
`chrome-devtools-axi stop` in pooled mode releases all pages owned by the calling logical session, including claimed popups: it closes them when another page exists, or navigates the last remaining page to `about:blank` because upstream cannot close the last tab. The physical pooled bridge stays available to other logical sessions.
If an agent exits without running `stop`, the route idle timeout releases that logical session's pages even while other sessions keep the pooled bridge alive. `CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS` sets the pool-slot route fallback; otherwise the fallback is the effective caller timeout captured when that slot starts. A caller's `CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS`, `--idle-timeout-ms`, or persisted agent policy overrides that fallback only for its logical route.
If `CHROME_DEVTOOLS_AXI_PORT` is set with a pool, it is treated as the base port and each pool slot uses `base + slot`; leaving it unset uses the normal derived pool-slot ports.

State is stored in `~/.chrome-devtools-axi/` (named sessions nest under `sessions/<name>/`; pooled bridge PID files nest under `pools/pool-<slot>/`):

| File                  | Purpose                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `bridge.pid`          | PID, port, session, owner, start time, and last activity for the running bridge |
| `snapshot-generation` | Per-logical-session counter used to detect stale uid refs                       |
| `agent-idle-timeout`  | Renewable per-logical-session policy from lifecycle hooks or the timeout flag   |

Use `chrome-devtools-axi sessions` to inspect bridge state without starting a browser. It inventories the default session plus named and pooled sessions such as `pool-3` when they have bridge PID state; reports PID/process-group liveness, bridge health, page count and selected URL when reachable, and flags stale PID files, reused non-bridge PIDs, health failures, session mismatches, and orphan symptoms. `--json` prints machine-readable output for watchdogs.

Cleanup is opt-in. `chrome-devtools-axi sessions --clean-stale` (also `--clean` or `--prune`) removes only well-formed `bridge.pid` files whose recorded PID is confirmed dead, and `--stop-unhealthy` stops only live PIDs that still validate as `chrome-devtools-axi-bridge` processes. Stopping an unhealthy pooled entry stops that physical pool slot, so every logical session hashed to the slot must start a fresh route afterward.

## Development

```sh
pnpm run build       # Compile TypeScript to dist/
pnpm run build:skill # Regenerate skills/chrome-devtools-axi/SKILL.md from shared CLI guidance and SDK built-ins
pnpm run dev         # Run CLI directly with tsx
pnpm test            # Run tests with vitest
pnpm run test:watch  # Run tests in watch mode
```

The committed `skills/chrome-devtools-axi/SKILL.md` is generated by `pnpm run build:skill`; `pnpm test` fails if it drifts from the shared CLI guidance or documented SDK built-ins.
The generated skill frontmatter includes Hermes Agent metadata from `src/skill.ts`; update the generator instead of hand-editing the committed `SKILL.md`.
The npm package includes `skills/chrome-devtools-axi/`, so published releases ship the same installable Agent Skill documented in Quick Start.
Prettier intentionally ignores generator-owned files listed in `.prettierignore`; use their generator checks instead of formatting them by hand.
