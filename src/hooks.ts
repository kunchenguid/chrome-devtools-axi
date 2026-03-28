/**
 * Session hook self-installation for chrome-devtools-axi.
 *
 * Idempotently registers a SessionStart hook in both:
 *   - Claude Code: ~/.claude/settings.json
 *   - Codex CLI:   ~/.codex/hooks.json
 *
 * So agents see browser state at session start.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

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
 * Returns hook installation targets for supported agents.
 */
export function getHookTargets(): HookTarget[] {
  const home = homedir();
  return [
    { path: join(home, ".claude", "settings.json") },
    { path: join(home, ".codex", "hooks.json") },
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
  const hookCommand = execPath;
  const updated = structuredClone(settings);

  if (!updated.hooks) {
    updated.hooks = {};
  }
  if (!updated.hooks.SessionStart) {
    updated.hooks.SessionStart = [];
  }

  // Search all SessionStart hook groups for an existing chrome-devtools-axi hook
  for (const group of updated.hooks.SessionStart) {
    for (let i = 0; i < group.hooks.length; i++) {
      const h = group.hooks[i];
      if (h.command.includes(HOOK_MARKER)) {
        // Found existing hook — check if path is correct
        if (h.command === hookCommand) {
          return [settings, false]; // no-op
        }
        // Path changed — repair
        h.command = hookCommand;
        return [updated, true];
      }
    }
  }

  // No existing hook — install new one
  updated.hooks.SessionStart.push({
    matcher: "",
    hooks: [{ type: "command", command: hookCommand, timeout: 10 }],
  });

  return [updated, true];
}

/**
 * Idempotently install session hooks into all supported agents.
 * Silently does nothing on any error.
 */
export function installHooks(): void {
  try {
    const execPath = resolve(process.argv[1]);

    for (const target of getHookTargets()) {
      try {
        let settings: HookSettings = {};
        if (existsSync(target.path)) {
          settings = JSON.parse(readFileSync(target.path, "utf-8"));
        }

        const [updated, changed] = computeHookUpdate(settings, execPath);
        if (changed) {
          mkdirSync(dirname(target.path), { recursive: true });
          writeFileSync(target.path, JSON.stringify(updated, null, 2) + "\n");
        }
      } catch {
        // Skip this target, try the next
      }
    }
  } catch {
    // Best-effort — never fail the CLI over hook installation
  }
}
