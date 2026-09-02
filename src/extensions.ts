/**
 * AXI commands for the chrome-devtools-mcp Extensions category.
 *
 * These commands deliberately require CHROME_DEVTOOLS_AXI_EXTENSION_MODE=1.
 * That mode enables the upstream extension tools only for a pipe-launched
 * Chrome with a temporary --isolated profile; remote browsers and persistent
 * operator profiles are never silently modified.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { encode } from "@toon-format/toon";
import { CdpError, callTool } from "./client.js";
import {
  EXTENSION_MODE_ENV,
  extensionModeConflict,
  isExtensionModeEnabled,
} from "./bridge-script.js";
import { resolveSessionName } from "./sessions.js";

export type ExtensionOperation =
  | "install"
  | "list"
  | "reload"
  | "action"
  | "uninstall"
  | "targets"
  | "inspect";

export const EXTENSION_PROFILE_DESCRIPTION =
  "temporary isolated profile (owned by this session)";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value);
}

export function validateExtensionId(value: string | undefined): string {
  if (!value) {
    throw new CdpError("Missing extension ID", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi extensions` to list extension IDs",
    ]);
  }
  if (!isExtensionId(value)) {
    throw new CdpError(
      `Invalid extension ID: ${value}. Chrome extension IDs must be 32 lowercase letters from a-p.`,
      "VALIDATION_ERROR",
      [
        "Run `chrome-devtools-axi extensions` and copy the complete id; extension names are not accepted",
      ],
    );
  }
  return value;
}

export function validateExtensionPath(value: string | undefined): string {
  if (!value) {
    throw new CdpError("Missing unpacked extension path", "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi extension-install /absolute/path/to/extension`",
    ]);
  }
  if (!isAbsolute(value)) {
    throw new CdpError(
      `Extension path must be absolute: ${value}`,
      "VALIDATION_ERROR",
      [
        "Pass the unpacked extension folder as an absolute path; relative paths are rejected for safety",
      ],
    );
  }

  const path = resolve(value);
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new CdpError(
      `Unpacked extension folder does not exist or is not a directory: ${path}`,
      "VALIDATION_ERROR",
      [
        "Provide an existing absolute folder containing the extension manifest.json",
      ],
    );
  }
  return path;
}

/**
 * Check the explicit extension-mode safety gate before validating or invoking
 * an upstream tool. This keeps a missing opt-in from starting an ordinary
 * browser and gives remote-browser users the exact remediation.
 */
export function assertExtensionMode(): void {
  if (!isExtensionModeEnabled()) {
    throw new CdpError(
      `Extension operations require ${EXTENSION_MODE_ENV}=1. This launches a temporary isolated pipe browser and enables the upstream Extensions category; the current browser/session is not modified.`,
      "VALIDATION_ERROR",
      [
        `Set ${EXTENSION_MODE_ENV}=1 and use a dedicated CHROME_DEVTOOLS_AXI_SESSION, then retry`,
        "Example: CHROME_DEVTOOLS_AXI_EXTENSION_MODE=1 CHROME_DEVTOOLS_AXI_SESSION=extension-test chrome-devtools-axi extensions",
      ],
    );
  }

  const conflict = extensionModeConflict();
  if (conflict) {
    throw new CdpError(conflict, "VALIDATION_ERROR", [
      `Unset CHROME_DEVTOOLS_AXI_AUTO_CONNECT, CHROME_DEVTOOLS_AXI_BROWSER_URL, and CHROME_DEVTOOLS_AXI_USER_DATA_DIR for the isolated extension session`,
      "Use CHROME_DEVTOOLS_AXI_SESSION=extension-test to keep extension state separate from an ordinary session",
    ]);
  }
}

function assertNoExtraArgs(args: string[], usage: string): void {
  if (args.length > 0) {
    throw new CdpError(`Unexpected argument: ${args[0]}`, "VALIDATION_ERROR", [
      `Run \`${usage}\``,
    ]);
  }
}

function extensionMetadata(
  operation: ExtensionOperation,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation,
    session: resolveSessionName(),
    profile: EXTENSION_PROFILE_DESCRIPTION,
    transport: "pipe",
    ...extra,
  };
}

/**
 * Parse the stable, human-readable list format emitted by the official MCP
 * extension tool. Returning null for an unknown future format lets us retain
 * the upstream text instead of guessing or matching by extension name.
 */
export function parseExtensionList(text: string): Array<{
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}> | null {
  if (/No extensions installed\.?/i.test(text)) return [];

  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("id="));
  if (rows.length === 0) return null;

  const parsed = [];
  for (const row of rows) {
    const match = row.match(
      /^id=([a-p]{32})\s+"(.*)"\s+v([^\s]+)\s+(Enabled|Disabled)$/,
    );
    if (!match) return null;
    parsed.push({
      id: match[1],
      name: match[2],
      version: match[3],
      enabled: match[4] === "Enabled",
    });
  }
  return parsed;
}

function formatExtensionOutput(
  operation: ExtensionOperation,
  result: string,
  extra: Record<string, unknown> = {},
): string {
  const metadata = encode({
    extension: extensionMetadata(operation, extra),
  });
  const text = result.trimEnd();

  if (operation === "list") {
    const extensions = parseExtensionList(result);
    if (extensions !== null) {
      return encode({
        extension: extensionMetadata(operation, { count: extensions.length }),
        extensions,
      });
    }
    return [metadata, `extensions:\n${text}`].join("\n");
  }
  return text.length > 0 ? [metadata, `result:\n${text}`].join("\n") : metadata;
}

function extractInstalledId(result: string): string | undefined {
  const match = result.match(/\bId:\s*([a-p]{32})\b/i);
  return match?.[1];
}

export async function handleExtensionInstall(args: string[]): Promise<string> {
  assertExtensionMode();
  if (args.length !== 1) {
    throw new CdpError(
      "Missing or unexpected unpacked extension path",
      "VALIDATION_ERROR",
      [
        "Run `chrome-devtools-axi extension-install /absolute/path/to/extension`",
      ],
    );
  }
  const path = validateExtensionPath(args[0]);
  const result = await callTool("install_extension", { path });
  const id = extractInstalledId(result);
  return formatExtensionOutput("install", result, {
    path,
    ...(id ? { id } : {}),
  });
}

export async function handleExtensionList(args: string[]): Promise<string> {
  assertExtensionMode();
  assertNoExtraArgs(args, "chrome-devtools-axi extensions");
  const result = await callTool("list_extensions");
  return formatExtensionOutput("list", result);
}

async function handleExtensionIdOperation(
  operation: Exclude<ExtensionOperation, "install" | "list">,
  args: string[],
  usage: string,
  toolName: string,
): Promise<string> {
  assertExtensionMode();
  if (args.length !== 1) {
    throw new CdpError(
      "Missing or unexpected extension ID",
      "VALIDATION_ERROR",
      [`Run \`${usage}\``],
    );
  }
  const id = validateExtensionId(args[0]);
  const result = await callTool(toolName, { id });
  return formatExtensionOutput(operation, result, { id });
}

export function handleExtensionReload(args: string[]): Promise<string> {
  return handleExtensionIdOperation(
    "reload",
    args,
    "chrome-devtools-axi extension-reload <id>",
    "reload_extension",
  );
}

export function handleExtensionAction(args: string[]): Promise<string> {
  return handleExtensionIdOperation(
    "action",
    args,
    "chrome-devtools-axi extension-action <id>",
    "trigger_extension_action",
  );
}

export function handleExtensionUninstall(args: string[]): Promise<string> {
  return handleExtensionIdOperation(
    "uninstall",
    args,
    "chrome-devtools-axi extension-uninstall <id>",
    "uninstall_extension",
  );
}

/**
 * List all extension-related targets (service workers and extension pages).
 * Uses list_pages to identify extension targets in the browser session.
 */
export async function handleExtensionTargets(args: string[]): Promise<string> {
  assertExtensionMode();
  assertNoExtraArgs(args, "chrome-devtools-axi extension-targets");
  const result = await callTool("list_pages");

  const metadata = encode({
    extension: extensionMetadata("targets"),
  });

  // Parse the list_pages output for extension targets
  const lines = result.split(/\r?\n/).map((l) => l.trim());
  const targetLines: string[] = [];
  let inExtensionSection = false;

  for (const line of lines) {
    if (line.match(/^##\s+(Extension Pages|Extension Service Workers)$/)) {
      inExtensionSection = true;
      continue;
    }
    if (line.match(/^##\s+/)) {
      inExtensionSection = false;
      continue;
    }
    if (inExtensionSection && line.length > 0) {
      targetLines.push(line);
    }
  }

  const content =
    targetLines.length > 0
      ? `targets:\n${targetLines.join("\n")}`
      : "No extension targets found. Install an extension with extension-install first.";

  return [metadata, content].join("\n");
}

/**
 * Parse extension list to get detailed info about a specific extension.
 */
export async function handleExtensionInspect(args: string[]): Promise<string> {
  assertExtensionMode();
  if (args.length !== 1) {
    throw new CdpError(
      "Missing or unexpected extension ID",
      "VALIDATION_ERROR",
      [`Run \`chrome-devtools-axi extension-inspect <id>\``],
    );
  }
  const id = validateExtensionId(args[0]);

  // Get the extension list
  const listResult = await callTool("list_extensions");
  const extensions = parseExtensionList(listResult);

  if (!extensions) {
    throw new CdpError("Unable to parse extension list", "BROWSER_ERROR", [
      "Run `chrome-devtools-axi extensions` to see the current extension list format",
    ]);
  }

  const extension = extensions.find((ext) => ext.id === id);
  if (!extension) {
    throw new CdpError(`Extension ${id} not found`, "VALIDATION_ERROR", [
      "Run `chrome-devtools-axi extensions` to list all extension IDs",
      "Copy the exact 32-character id from the list",
    ]);
  }

  const metadata = encode({
    extension: extensionMetadata("inspect", { id }),
  });

  const details = encode({
    details: {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      enabled: extension.enabled,
    },
  });

  return [metadata, details].join("\n");
}
