import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
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
export const PI_EXTENSION_FILENAME = "chrome-devtools-axi.ts";
const OPENCODE_PLUGIN_FILENAME = `axi-${HOOK_MARKER}.js`;

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
  return `${command} --agent-session-start`;
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
  const piConfigDir = resolve(
    process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
  );
  return [
    { path: join(home, ".claude", "settings.json") },
    { path: join(home, ".codex", "hooks.json") },
    { path: join(home, ".codex", "config.toml") },
    { path: join(piConfigDir, "extensions", PI_EXTENSION_FILENAME) },
  ];
}

/**
 * Build a dependency-free Pi extension that mirrors SessionStart/SessionEnd.
 * A global symbol prevents duplicate lifecycle handlers when Fleet also loads
 * its generated extension into the same Pi process.
 */
export function buildPiExtension(
  command: string,
  runtime: {
    platform?: NodeJS.Platform;
    nodeExecutable?: string;
    windowsCommandShell?: string;
  } = {},
): string {
  const platform = runtime.platform ?? process.platform;
  const extension = extname(command).toLowerCase();
  const launch =
    extension === ".js" || extension === ".mjs" || extension === ".cjs"
      ? {
          executable: runtime.nodeExecutable ?? process.execPath,
          prefixArgs: [command],
        }
      : platform === "win32" && (extension === ".cmd" || extension === ".bat")
        ? {
            executable:
              runtime.windowsCommandShell ?? process.env.ComSpec ?? "cmd.exe",
            prefixArgs: ["/d", "/s", "/c", command],
          }
        : { executable: command, prefixArgs: [] };
  return (
    `// Managed by chrome-devtools-axi setup hooks. Re-run setup to repair.\n` +
    `import { spawnSync } from "node:child_process";\n\n` +
    `const AXI_EXECUTABLE = ${JSON.stringify(launch.executable)};\n` +
    `const AXI_PREFIX_ARGS = ${JSON.stringify(launch.prefixArgs)};\n` +
    `const STATE_KEY = Symbol.for("chrome-devtools-axi.pi.lifecycle");\n\n` +
    `const shared = globalThis;\n\n` +
    `function run(args, timeout) {\n` +
    `  const result = spawnSync(AXI_EXECUTABLE, [...AXI_PREFIX_ARGS, ...args], {\n` +
    `    encoding: "utf8",\n` +
    `    stdio: ["ignore", "pipe", "ignore"],\n` +
    `    timeout,\n` +
    `    env: {\n` +
    `      ...process.env,\n` +
    `    },\n` +
    `  });\n` +
    `  if (result.error || result.status !== 0) return "";\n` +
    `  return (result.stdout ?? "").trim();\n` +
    `}\n\n` +
    `export default function (pi) {\n` +
    `  const owner = Symbol("chrome-devtools-axi.pi.extension");\n` +
    `  const state = shared[STATE_KEY] ??= {};\n` +
    `  if (state.owner) return;\n` +
    `  state.owner = owner;\n\n` +
    `  pi.on("session_start", () => {\n` +
    `    state.context = run(["--agent-session-start"], 10000);\n` +
    `  });\n\n` +
    `  pi.on("before_agent_start", (event) => {\n` +
    `    if (state.owner !== owner || !state.context) return;\n` +
    `    return { systemPrompt: event.systemPrompt + "\\n\\n" + state.context };\n` +
    `  });\n\n` +
    `  pi.on("session_shutdown", () => {\n` +
    `    if (state.owner !== owner) return;\n` +
    `    run(["--agent-session-end", "stop"], 3000);\n` +
    `    state.context = undefined;\n` +
    `    state.owner = undefined;\n` +
    `  });\n` +
    `}\n`
  );
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
  const startCommand = withAgentBridgeIdleTimeout(execPath);
  const [withSessionStart, sessionStartChanged] = computeSessionStartHookUpdate(
    settings,
    {
      marker: HOOK_MARKER,
      command: startCommand,
      timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    },
  ) as [HookSettings, boolean];
  const [updated, sessionEndChanged] = computeEventHookUpdate(
    withSessionStart,
    "SessionEnd",
    `${execPath} --agent-session-end stop`,
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

function installPiExtension(
  command: string,
  onError: (message: string) => void,
): void {
  const target = getHookTargets().find((candidate) =>
    candidate.path.endsWith(PI_EXTENSION_FILENAME),
  )?.path;
  if (!target) return;

  try {
    const content = buildPiExtension(command);
    if (existsSync(target) && readFileSync(target, "utf-8") === content) {
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError(`${target}: ${message}`);
  }
}

export function addOpenCodeSessionPolicy(source: string): string {
  const original = "spawn(command, [], {";
  const managed = 'spawn(command, ["--agent-session-start"], {';
  if (source.includes(managed)) return source;
  if (!source.includes(original)) {
    throw new Error("managed OpenCode plugin has an unsupported format");
  }
  return source.replace(original, managed);
}

function installOpenCodeSessionPolicy(
  onError: (message: string) => void,
): void {
  const target = join(
    homedir(),
    ".config",
    "opencode",
    "plugins",
    OPENCODE_PLUGIN_FILENAME,
  );
  try {
    if (!existsSync(target)) return;
    const current = readFileSync(target, "utf-8");
    const updated = addOpenCodeSessionPolicy(current);
    if (updated !== current) writeFileSync(target, updated, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError(`${target}: ${message}`);
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
  if (errors.length === 0) {
    installOpenCodeSessionPolicy((message) => {
      errors.push(message);
    });
  }
  const command = resolveInstalledHookCommand();
  if (command) {
    installJsonHooks(command, (message) => {
      errors.push(message);
    });
    installPiExtension(command, (message) => {
      errors.push(message);
    });
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
