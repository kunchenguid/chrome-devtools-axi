import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  computeCodexConfigUpdate as computeAxiCodexConfigUpdate,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  resolvePortableHookCommand,
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
export const AGENT_BRIDGE_IDLE_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_SECONDS = 10;
export const SESSION_END_HOOK_TIMEOUT_SECONDS = 3;

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

export function withAgentBridgeIdleTimeout(command: string): string {
  return `CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS=${AGENT_BRIDGE_IDLE_TIMEOUT_MS} ${command}`;
}

function isManagedHook(hook: HookEntry, marker = HOOK_MARKER): boolean {
  return typeof hook.command === "string" && hook.command.includes(marker);
}

function computeEventHookUpdate(
  settings: HookSettings,
  event: string,
  command: string,
  timeoutSeconds = HOOK_TIMEOUT_SECONDS,
): [HookSettings, boolean] {
  const updated = structuredClone(settings);
  let changed = false;

  if (!updated.hooks) {
    updated.hooks = {};
    changed = true;
  }
  if (!Array.isArray(updated.hooks[event])) {
    updated.hooks[event] = [];
    changed = true;
  }

  const groups = updated.hooks[event] as HookGroup[];
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (!isManagedHook(hook)) continue;
      const isCorrect =
        hook.command === command &&
        hook.type === "command" &&
        hook.timeout === timeoutSeconds;
      if (isCorrect && !changed) {
        return [settings, false];
      }
      hook.command = command;
      hook.type = "command";
      hook.timeout = timeoutSeconds;
      return [updated, true];
    }
  }

  groups.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command,
        timeout: timeoutSeconds,
      },
    ],
  });
  return [updated, true];
}

function removeManagedEventHooks(
  settings: HookSettings,
  event: string,
): [HookSettings, boolean] {
  if (!settings.hooks || !Array.isArray(settings.hooks[event])) {
    return [settings, false];
  }

  const updated = structuredClone(settings);
  const groups = updated.hooks?.[event] ?? [];
  const nextGroups: HookGroup[] = [];
  let changed = false;

  for (const group of groups) {
    if (!Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isManagedHook(hook));
    if (hooks.length !== group.hooks.length) {
      changed = true;
    }
    if (hooks.length > 0) {
      nextGroups.push({ ...group, hooks });
    }
  }

  if (!changed) return [settings, false];
  if (nextGroups.length > 0) {
    updated.hooks![event] = nextGroups;
  } else {
    delete updated.hooks![event];
  }
  return [updated, true];
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
  const baseCommand = withAgentBridgeIdleTimeout(execPath);
  const [withSessionStart, sessionStartChanged] = computeSessionStartHookUpdate(
    settings,
    {
      marker: HOOK_MARKER,
      command: baseCommand,
      timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    },
  ) as [HookSettings, boolean];
  const [updated, sessionEndChanged] = computeEventHookUpdate(
    withSessionStart,
    "SessionEnd",
    `${baseCommand} stop`,
    SESSION_END_HOOK_TIMEOUT_SECONDS,
  );
  const [withoutBadStop, removedBadStop] = removeManagedEventHooks(
    updated,
    "Stop",
  );
  return [
    withoutBadStop,
    sessionStartChanged || sessionEndChanged || removedBadStop,
  ];
}

function buildPortableHookCommandContext() {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    pathEntries: rawPath.split(delimiter).filter(Boolean),
    pathExtensions:
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
        : [""],
    resolveRealPath: (absolutePath: string) => {
      try {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) return undefined;
        return realpathSync(absolutePath);
      } catch {
        return undefined;
      }
    },
  };
}

function resolveInstalledHookCommand(
  execPath = process.argv[1] ?? "",
): string | null {
  const resolvedExecPath = resolve(execPath);
  if (!shouldInstallHooksForExecPath(resolvedExecPath)) return null;
  return resolvePortableHookCommand(
    resolvedExecPath,
    [HOOK_MARKER],
    HOOK_MARKER,
    buildPortableHookCommandContext(),
  );
}

function installJsonHooks(command: string, onError: (message: string) => void) {
  const targets = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".codex", "hooks.json"),
  ];

  for (const target of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      const current = existsSync(target)
        ? (JSON.parse(readFileSync(target, "utf-8")) as HookSettings)
        : {};
      const [updated, changed] = computeHookUpdate(current, command);
      if (changed) {
        writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(`${target}: ${message}`);
    }
  }
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
    installHooksOrThrow();
  } catch {
    // Best-effort — never fail the CLI over hook installation
  }
}

export function installHooksOrThrow(): void {
  const errors: string[] = [];
  installSessionStartHooks({
    marker: HOOK_MARKER,
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    shouldInstall: shouldInstallHooksForExecPath,
    onError: (message) => {
      errors.push(message);
    },
  });
  const command = resolveInstalledHookCommand();
  if (command) {
    installJsonHooks(command, (message) => {
      errors.push(message);
    });
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
