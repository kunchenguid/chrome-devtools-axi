/**
 * Session hook self-installation for chrome-devtools-axi.
 *
 * Idempotently registers a SessionStart hook in both:
 *   - Claude Code: ~/.claude/settings.json
 *   - Codex CLI:   ~/.codex/hooks.json
 *   - Codex CLI:   ~/.codex/config.toml ([features].codex_hooks = true)
 *
 * So agents see browser state at session start.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
 * Only install hooks from packaged or installed entrypoints.
 * Development TypeScript entrypoints should not self-register.
 */
export function shouldInstallHooksForExecPath(execPath: string): boolean {
  const normalized = resolve(execPath);
  const fileName = basename(normalized);

  if (!normalized.includes(HOOK_MARKER)) {
    return false;
  }
  if (normalized.endsWith(".ts")) {
    return false;
  }

  return (
    normalized.endsWith("/dist/bin/chrome-devtools-axi.js") ||
    normalized.endsWith("\\dist\\bin\\chrome-devtools-axi.js") ||
    fileName === "chrome-devtools-axi"
  );
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
 * Pure function: ensure Codex hooks are enabled in config.toml.
 * Returns [updatedToml, changed].
 */
export function computeCodexConfigUpdate(content: string): [string, boolean] {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.length === 0 ? "" : content;

  if (normalized.trim().length === 0) {
    return [`[features]${newline}codex_hooks = true${newline}`, true];
  }

  const lines = normalized.split(/\r?\n/);
  const updated = [...lines];
  let inFeatures = false;
  let sawFeatures = false;

  for (let i = 0; i < updated.length; i++) {
    const line = updated[i];
    const section = line.match(/^\s*(\[{1,2})([^\]]+)(\]{1,2})\s*(?:#.*)?$/);

    if (section) {
      const isTableHeader =
        (section[1] === "[" && section[3] === "]") ||
        (section[1] === "[[" && section[3] === "]]");
      if (!isTableHeader) {
        continue;
      }

      const sectionName = section[2].trim();
      if (inFeatures) {
        updated.splice(i, 0, "codex_hooks = true");
        return [updated.join(newline), true];
      }
      inFeatures = sectionName === "features";
      sawFeatures ||= inFeatures;
      continue;
    }

    if (!inFeatures) {
      continue;
    }

    const flag = line.match(
      /^(\s*codex_hooks\s*=\s*)(true|false)(\s*(?:#.*)?)$/,
    );
    if (!flag) {
      continue;
    }
    if (flag[2] === "true") {
      return [content, false];
    }
    updated[i] = `${flag[1]}true${flag[3] ?? ""}`;
    return [updated.join(newline), true];
  }

  if (sawFeatures) {
    const suffix =
      normalized.endsWith(newline) || normalized.length === 0 ? "" : newline;
    return [`${normalized}${suffix}codex_hooks = true${newline}`, true];
  }

  const separator =
    normalized.endsWith(newline + newline) || normalized.length === 0
      ? ""
      : normalized.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
  return [
    `${normalized}${separator}[features]${newline}codex_hooks = true${newline}`,
    true,
  ];
}

/**
 * Idempotently install session hooks into all supported agents.
 * Silently does nothing on any error.
 */
export function installHooks(): void {
  try {
    const execPath = resolve(process.argv[1]);
    if (!shouldInstallHooksForExecPath(execPath)) return;

    for (const target of getHookTargets()) {
      try {
        mkdirSync(dirname(target.path), { recursive: true });

        if (target.path.endsWith(".toml")) {
          const content = existsSync(target.path)
            ? readFileSync(target.path, "utf-8")
            : "";
          const [updated, changed] = computeCodexConfigUpdate(content);
          if (changed) {
            writeFileSync(target.path, updated);
          }
          continue;
        }

        let settings: HookSettings = {};
        if (existsSync(target.path)) {
          settings = JSON.parse(readFileSync(target.path, "utf-8"));
        }

        const [updated, changed] = computeHookUpdate(settings, execPath);
        if (changed) {
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
