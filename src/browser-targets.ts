import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserTargetName = "chrome" | "comet";

export interface BrowserTarget {
  name: BrowserTargetName;
  displayName: string;
  executablePath: string | null;
  bootstrapInitialPage: boolean;
}

export interface BrowserTargetProbe {
  existsSync: (path: string) => boolean;
  homedir: () => string;
}

const DEFAULT_BROWSER_TARGET_PROBE: BrowserTargetProbe = {
  existsSync,
  homedir,
};

function normalizeTargetName(raw: string | undefined): BrowserTargetName {
  const value = (raw ?? "chrome").trim().toLowerCase();
  if (value === "" || value === "chrome") return "chrome";
  if (value === "comet") return "comet";
  throw new Error(
    `Invalid CHROME_DEVTOOLS_AXI_BROWSER_TARGET "${raw}": use chrome or comet`,
  );
}

function detectCometExecutable(probe: BrowserTargetProbe): string | null {
  const candidates = [
    "/Applications/Comet.app/Contents/MacOS/Comet",
    join(
      probe.homedir(),
      "Applications",
      "Comet.app",
      "Contents",
      "MacOS",
      "Comet",
    ),
  ];
  return candidates.find((path) => probe.existsSync(path)) ?? null;
}

export function resolveBrowserTarget(
  probe: BrowserTargetProbe = DEFAULT_BROWSER_TARGET_PROBE,
): BrowserTarget {
  const name = normalizeTargetName(
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_TARGET,
  );
  const explicitExecutable =
    process.env.CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH?.trim();

  if (name === "comet") {
    return {
      name,
      displayName: "Comet",
      executablePath:
        explicitExecutable && explicitExecutable.length > 0
          ? explicitExecutable
          : detectCometExecutable(probe),
      bootstrapInitialPage: true,
    };
  }

  return {
    name,
    displayName: "Chrome",
    executablePath:
      explicitExecutable && explicitExecutable.length > 0
        ? explicitExecutable
        : null,
    bootstrapInitialPage: false,
  };
}

export function requireLaunchExecutable(target: BrowserTarget): string {
  if (target.executablePath) return target.executablePath;
  throw new Error(
    `Could not find ${target.displayName}. Set CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH to its browser executable.`,
  );
}
