import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

export function ownsTemporaryHeadlessBrowser(env = process.env): boolean {
  return (
    env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT !== "1" &&
    !env.CHROME_DEVTOOLS_AXI_BROWSER_URL &&
    !env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR &&
    env.CHROME_DEVTOOLS_AXI_HEADED !== "1"
  );
}

export function testingChromePath(
  root = join(homedir(), ".cache", "puppeteer", "chrome"),
  arch: string = process.arch,
): string {
  const prefix = arch === "arm64" ? "mac_arm-" : arch === "x64" ? "mac-" : null;
  if (!prefix)
    throw new Error(
      `Unsupported Mac architecture for Chrome for Testing: ${arch}`,
    );
  const platformDir = arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
  const builds = existsSync(root)
    ? readdirSync(root).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      )
    : [];
  for (const build of builds) {
    if (!build.startsWith(prefix)) continue;
    const path = join(
      root,
      build,
      platformDir,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    if (existsSync(path)) return path;
  }
  throw new Error(
    "Headless automation requires a separate Google Chrome for Testing installation in ~/.cache/puppeteer/chrome. Install Chrome for Testing into that cache before retrying. Refusing to launch the everyday Google Chrome app invisibly.",
  );
}

export function createIdleLifecycle(
  timeoutMs: number,
  onIdle: () => void,
  now = Date.now,
) {
  let lastActivity = now();
  let active = 0;
  let stopped = false;
  return {
    begin(req: Pick<IncomingMessage, "method" | "url">) {
      active++;
      const meaningful = req.method === "POST" && req.url === "/call";
      if (meaningful) lastActivity = now();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active--;
        if (meaningful) lastActivity = now();
      };
    },
    check() {
      if (!stopped && active === 0 && now() - lastActivity >= timeoutMs) {
        stopped = true;
        onIdle();
      }
    },
  };
}
