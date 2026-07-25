import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  KEYCHAIN_ISOLATION_CHROME_ARGS,
  buildTransportArgs,
} from "../src/bridge.js";

/**
 * Regression cover for the "Keychain Not Found" modal.
 *
 * Observed failure chain on macOS, from the unified log:
 *
 *   Chrome (launched without --use-mock-keychain, with a HOME that has no
 *   Library/Keychains/login.keychain-db)
 *     -> SecItemCopyMatching misses "Chrome Safe Storage" (the login keychain
 *        is not in that process's keychain search list)
 *     -> SecItemAdd -> OSStatus -25307 (errSecNoDefaultKeychain)
 *     -> AuthorizationCreate for the right `system.keychain.create.loginkc`,
 *        whose own authorization-db comment reads "Used by the Security
 *        framework when you add an item to an unconfigured default keychain"
 *     -> mechanism loginKC:queryCreate -> SecurityAgent draws
 *        "Keychain Not Found - A keychain cannot be found to store \"Chrome.\""
 *        with a Cancel / Reset To Defaults choice on the machine owner's screen.
 *
 * A browser this tool launches must never be able to reach that panel, because
 * "Reset To Defaults" offers to recreate the owner's login keychain. The
 * defence is to keep the automation browser off the real keychain entirely.
 *
 * These assertions are structural rather than mode-by-mode: any future launch
 * mode that forgets the isolation flags fails here, and the flags must stay
 * absent in the attach modes, where the browser belongs to somebody else.
 */

const LAUNCH_ONLY_ENV_MATRIX: Array<{
  name: string;
  env: Record<string, string>;
}> = [
  { name: "default isolated mode", env: {} },
  { name: "headed isolated mode", env: { CHROME_DEVTOOLS_AXI_HEADED: "1" } },
  {
    name: "persistent profile mode",
    env: { CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/profile" },
  },
  {
    name: "headed persistent profile mode",
    env: {
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/profile",
      CHROME_DEVTOOLS_AXI_HEADED: "1",
    },
  },
  {
    name: "isolated mode with a release channel",
    env: { CHROME_DEVTOOLS_AXI_CHANNEL: "beta" },
  },
  {
    name: "isolated mode with caller-supplied chrome args",
    env: { CHROME_DEVTOOLS_AXI_CHROME_ARGS: "--enable-unsafe-webgpu" },
  },
];

const ATTACH_ONLY_ENV_MATRIX: Array<{
  name: string;
  env: Record<string, string>;
}> = [
  {
    name: "autoConnect mode",
    env: { CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1" },
  },
  {
    name: "browserUrl mode",
    env: { CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222" },
  },
  {
    name: "wsEndpoint mode",
    env: { CHROME_DEVTOOLS_AXI_BROWSER_URL: "ws://127.0.0.1:9222/devtools" },
  },
];

const MANAGED_ENV_KEYS = [
  "CHROME_DEVTOOLS_AXI_HEADED",
  "CHROME_DEVTOOLS_AXI_CHROME_ARGS",
  "CHROME_DEVTOOLS_AXI_BROWSER_URL",
  "CHROME_DEVTOOLS_AXI_USER_DATA_DIR",
  "CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
  "CHROME_DEVTOOLS_AXI_CHANNEL",
  "CHROME_DEVTOOLS_AXI_WS_HEADERS",
] as const;

/** True when these args ask chrome-devtools-mcp to launch its own browser. */
function launchesOwnBrowser(args: string[]): boolean {
  return (
    args.includes("--isolated") ||
    args.some((arg) => arg.startsWith("--userDataDir="))
  );
}

describe("keychain isolation for launched browsers", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("keeps the automation browser off the real keychain and password store", () => {
    // Losing either flag re-opens the path to the modal: --use-mock-keychain
    // stops OSCrypt touching the login keychain, --password-store=basic stops
    // the password store reaching for the platform secret service.
    expect([...KEYCHAIN_ISOLATION_CHROME_ARGS]).toEqual([
      "--use-mock-keychain",
      "--password-store=basic",
    ]);
  });

  for (const { name, env } of LAUNCH_ONLY_ENV_MATRIX) {
    it(`isolates the keychain in ${name}`, () => {
      Object.assign(process.env, env);
      const args = buildTransportArgs();

      expect(launchesOwnBrowser(args)).toBe(true);
      for (const flag of KEYCHAIN_ISOLATION_CHROME_ARGS) {
        expect(args).toContain(`--chrome-arg=${flag}`);
      }
    });
  }

  for (const { name, env } of ATTACH_ONLY_ENV_MATRIX) {
    it(`leaves the keychain policy alone in ${name}`, () => {
      Object.assign(process.env, env);
      const args = buildTransportArgs();

      // Nothing is launched here, so the flags would be inert noise at best -
      // and a claim we cannot honour at worst, since the browser is the user's.
      expect(launchesOwnBrowser(args)).toBe(false);
      for (const flag of KEYCHAIN_ISOLATION_CHROME_ARGS) {
        expect(args).not.toContain(`--chrome-arg=${flag}`);
      }
    });
  }

  it("survives caller-supplied chrome args without dropping the isolation", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--flag-a --flag-b";
    const args = buildTransportArgs();

    expect(args).toContain("--chrome-arg=--flag-a");
    expect(args).toContain("--chrome-arg=--flag-b");
    for (const flag of KEYCHAIN_ISOLATION_CHROME_ARGS) {
      expect(args).toContain(`--chrome-arg=${flag}`);
    }
  });
});
