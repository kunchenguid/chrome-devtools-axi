import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeCodexConfigUpdate as computeAxiCodexConfigUpdate,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  shouldInstallHooksForNodeAxiExecPath,
} from "axi-sdk-js";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface HookSettings {
  hooks?: {
    SessionStart?: HookGroup[];
    [event: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
}

export interface HookTarget {
  path: string;
}

const HOOK_MARKER = "chrome-devtools-axi";

/**
 * Only install hooks from packaged or installed entrypoints.
 * Development TypeScript entrypoints should not self-register.
 */
export function shouldInstallHooksForExecPath(execPath: string): boolean {
  return shouldInstallHooksForNodeAxiExecPath(execPath, {
    marker: HOOK_MARKER,
    binaryNames: [HOOK_MARKER],
    distEntrypoints: ["dist/bin/chrome-devtools-axi.js"],
  });
}

/**
 * Returns hook installation targets for supported agents.
 */
export function getHookTargets(): HookTarget[] {
  const home = homedir();
  return [
    { path: join(home, ".claude", "settings.json") },
    { path: join(home, ".codex", "hooks.json") },
    { path: join(home, ".codex", "config.toml") },
  ];
}

/**
 * Pure function: compute the hook update for agent settings.
 * Works for both Claude Code (settings.json) and Codex CLI (hooks.json).
 * Returns [updatedSettings, changed].
 */
export function computeHookUpdate(
  settings: HookSettings,
  execPath: string,
): [HookSettings, boolean] {
  return computeSessionStartHookUpdate(settings, {
    marker: HOOK_MARKER,
    command: execPath,
    timeoutSeconds: 10,
  }) as [HookSettings, boolean];
}

/**
 * Pure function: ensure Codex hooks are enabled in config.toml.
 * Returns [updatedToml, changed].
 */
export function computeCodexConfigUpdate(content: string): [string, boolean] {
  return computeAxiCodexConfigUpdate(content);
}

/**
 * Idempotently install session hooks into all supported agents.
 * Silently does nothing on any error.
 */
export function installHooks(): void {
  try {
    installSessionStartHooks({
      marker: HOOK_MARKER,
      timeoutSeconds: 10,
      shouldInstall: shouldInstallHooksForExecPath,
    });
  } catch {
    // Best-effort — never fail the CLI over hook installation
  }
}
