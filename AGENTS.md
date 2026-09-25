# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

chrome-devtools-axi is an agent-ergonomic CLI wrapper around [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp). Every invocation is short-lived; state that must survive lives in a detached bridge or under `~/.chrome-devtools-axi/`. [README How It Works](README.md#how-it-works) owns the process model. [README Configuration](README.md#configuration) owns transport selection, named sessions, and keychain isolation. [README Page Management](README.md#page-management) owns page selection.

## Invariants

- Node 20+, TypeScript, ESM-only (`"type": "module"`, module resolution `Node16`). Relative imports use `.js` extensions even from `.ts` files.
- `ensureBridge` (`src/client.ts`) reuses a bridge only after `/health?deep=1`. A dead browser is terminated and respawned, never reused as a stale endpoint.
- Launch modes (`--isolated` / `--userDataDir`) pass `KEYCHAIN_ISOLATION_CHROME_ARGS`; attach modes omit them. `test/keychain-isolation.test.ts` owns that split.
- `resolveSessionName` (`src/sessions.ts`) rejects path-traversal, unsafe, and all-dot names. A session isolates only the bridge. Two sessions forced onto one port fail loudly (`BRIDGE_PORT_IN_USE_EXIT_CODE`, 48); do not export `CHROME_DEVTOOLS_AXI_PORT` globally across sessions.
- Page identity is never self-healed. `callTool` injects the last AXI `select_page` id (`src/selected-page.ts`); `list_pages` never sets it. Missing selection fails with "No page is currently selected". After a reconnect, `open` creates a new tab.
- `didMcpPageIdentityChange` (`src/bridge.ts`) and `isMissingPageError` (`src/client.ts`) own the positional reconnect and missing-page matchers. Read them before changing either. The page-identity notice holder is per `callTool`, never module state. `clearSelectedPageId` reports a drop only when the read-back shows the id is gone.
- File-writing commands go through `callTool` / `handleCallRequest`: MCP roots for the cwd and output path, and an MCP `isError` is a failure, not printed success. `resolveOutputPath` (`src/paths.ts`) is the chokepoint for any new caller-supplied output file or directory.
- UID actions fail loud with `STALE_REF` unless `parseUidFresh` (`src/uid-freshness.ts`) sees the persisted generation and zero mutations. Generation and selected-page writes are best-effort (`src/generation.ts`, `src/selected-page.ts`): a failed write misses one detection or fails the next call loud, and never hangs.
- `getSessionSnapshotIfRunning` never starts the bridge and degrades an invalid session name to null. `ensureBridge` / `stopBridge` still fail loud on an invalid name.
- `src/version.ts` is a leaf (node builtins only). The CLI graph stays free of `@modelcontextprotocol/sdk`; only the bridge constructs an MCP client, so `resolveBridgeScript` and `BRIDGE_PORT_IN_USE_EXIT_CODE` live in `src/bridge-script.ts`. `test/version-path.test.ts` enforces this and must stay free of wall-clock assertions. `resolveBridgeScript` prefers a sibling `.ts` and falls back to the built `.js`.
- chrome-devtools-mcp `evaluate_script` invokes its function payload, so every payload must be callable (`callFunction` in `src/run.ts`). `test/main.test.ts` and `test/run.test.ts` execute the sent source. `run` prints only the script's `console.log` (`RAW_STDOUT_MARKER` / `wrapStdout` in `src/cli.ts`).
- `src/skill.ts` renders a discovery stub. CLI help is the source of truth; do not copy CLI instructions into the skill. `shouldInstallHooksForExecPath` (`src/hooks.ts`) blocks dev entrypoints such as `pnpm run dev` from installing hooks.
- Transport selection is `resolveTransport`, `resolveTransportSpec`, and `buildTransportArgs` in `src/bridge.ts`. `test/bridge.test.ts` covers them.
- `pnpm-workspace.yaml` enforces a minimum release age; `axi-sdk-js` and `chrome-devtools-axi` are exempt.
- `.airlock/lint.sh` must use pnpm (never `npm install` or `npx`). `test/airlock-lint.test.ts` enforces this.
- Some `test/client.test.ts` cases take a couple of seconds on real SIGTERM/SIGKILL escalation. That is expected.

## Commands

```sh
pnpm run build       # tsc to dist/ + chmod the CLI entrypoint
pnpm run build:skill # Regenerate skills/chrome-devtools-axi/SKILL.md from src/skill.ts
pnpm run dev         # Run the CLI from source with tsx
pnpm test            # vitest run (test/*.test.ts)
pnpm run test:watch  # vitest watch mode
```

Run one file: `pnpm test test/cli.test.ts`. Filter by name: `pnpm test -- -t "formatStopOutput"`. Check formatting: `pnpm exec prettier --check .`.
Run `pnpm run build` and `pnpm test` before pushing.
Do not hand-edit `CHANGELOG.md`, `.release-please-manifest.json`, or `skills/chrome-devtools-axi/SKILL.md`. Update `src/skill.ts` and run `pnpm run build:skill`. Generated files are listed in `.prettierignore`; validate them with their generator checks. Keep `skills/chrome-devtools-axi/` in the npm `files` list.

## Release and the contribution gate

[CONTRIBUTING.md](CONTRIBUTING.md) owns the no-mistakes workflow, the pinned `no-mistakes-required.yml` caller, and `paths-ignore` for the release-please output set. Human-authored PRs to `main` go through [no-mistakes](https://github.com/kunchenguid/no-mistakes) (>= 1.46.0). Push through `git push no-mistakes` so the attestation matches the current head.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
