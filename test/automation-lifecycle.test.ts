import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createIdleLifecycle,
  createTemporaryIdleLifecycle,
  ownsTemporaryHeadlessBrowser,
  testingChromePath,
} from "../src/automation-lifecycle.js";
import { buildTransportArgs } from "../src/bridge.js";

afterEach(() => vi.unstubAllEnvs());

describe("temporary automation", () => {
  it("never owns attached, persistent, or visible browsers", () => {
    expect(ownsTemporaryHeadlessBrowser({})).toBe(true);
    for (const key of [
      "AUTO_CONNECT",
      "BROWSER_URL",
      "USER_DATA_DIR",
      "HEADED",
    ]) {
      expect(
        ownsTemporaryHeadlessBrowser({ [`CHROME_DEVTOOLS_AXI_${key}`]: "1" }),
      ).toBe(false);
    }
  });

  it("selects newest matching architecture and refuses missing installations", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-testing-"));
    const add = (build: string, platform: string) => {
      const path = join(
        root,
        build,
        platform,
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
      return path;
    };
    try {
      expect(() => testingChromePath(root, "arm64")).toThrow("Refusing");
      add("mac_arm-99.0.0.0", "chrome-mac-arm64");
      const newest = add("mac_arm-150.0.0.0", "chrome-mac-arm64");
      const intel = add("mac-151.0.0.0", "chrome-mac-x64");
      expect(testingChromePath(root, "arm64")).toBe(newest);
      expect(testingChromePath(root, "x64")).toBe(intel);
      expect(() => testingChromePath(root, "other")).toThrow("Unsupported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses Testing for Mac default/stable only, preserving explicit modes", () => {
    for (const key of [
      "AUTO_CONNECT",
      "BROWSER_URL",
      "USER_DATA_DIR",
      "HEADED",
      "CHANNEL",
    ])
      vi.stubEnv(`CHROME_DEVTOOLS_AXI_${key}`, "");
    const find = vi.fn(() => "/testing/chrome");
    for (const channel of ["", "stable"]) {
      vi.stubEnv("CHROME_DEVTOOLS_AXI_CHANNEL", channel);
      const args = buildTransportArgs("darwin", find);
      expect(args).toContain("--executablePath=/testing/chrome");
      expect(args.some((arg) => arg.startsWith("--channel="))).toBe(false);
    }
    for (const [key, value] of [
      ["CHANNEL", "beta"],
      ["HEADED", "1"],
      ["USER_DATA_DIR", "/profile"],
      ["AUTO_CONNECT", "1"],
      ["BROWSER_URL", "http://localhost:9222"],
    ]) {
      vi.stubEnv("CHROME_DEVTOOLS_AXI_CHANNEL", "");
      vi.stubEnv(`CHROME_DEVTOOLS_AXI_${key}`, value);
      expect(buildTransportArgs("darwin", find)).not.toContain(
        "--executablePath=/testing/chrome",
      );
      vi.stubEnv(`CHROME_DEVTOOLS_AXI_${key}`, "");
    }
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("waits for operations to finish, then grants a full idle interval", () => {
    let time = 0;
    const idle = vi.fn();
    const lifecycle = createIdleLifecycle(100, idle, () => time);
    const end = lifecycle.begin({ method: "POST", url: "/call" });
    time = 200;
    lifecycle.check();
    expect(idle).not.toHaveBeenCalled();
    end(true);
    end();
    time = 299;
    lifecycle.check();
    expect(idle).not.toHaveBeenCalled();
    time = 300;
    lifecycle.check();
    lifecycle.check();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("does not renew the idle interval after a failed call", () => {
    let time = 0;
    const idle = vi.fn();
    const lifecycle = createIdleLifecycle(100, idle, () => time);
    const end = lifecycle.begin({ method: "POST", url: "/call" });
    time = 101;
    end(false);
    lifecycle.check();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("protects active probes without letting probes renew the idle interval", () => {
    let time = 0;
    const idle = vi.fn();
    const lifecycle = createIdleLifecycle(100, idle, () => time);
    time = 90;
    const end = lifecycle.begin({ method: "GET", url: "/health?deep=1" });
    time = 101;
    lifecycle.check();
    expect(idle).not.toHaveBeenCalled();
    end();
    lifecycle.check();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});

describe("idle cleanup opt-in", () => {
  it("leaves sessions alive unless explicitly enabled", () => {
    const idle = vi.fn();
    for (const value of [undefined, "", "0", "true"]) {
      expect(
        createTemporaryIdleLifecycle(idle, {
          CHROME_DEVTOOLS_AXI_IDLE_CLEANUP: value,
        }),
      ).toBeUndefined();
    }
    expect(idle).not.toHaveBeenCalled();
  });

  it("expires opted-in temporary sessions after ten idle minutes", () => {
    let time = 0;
    const idle = vi.fn();
    const lifecycle = createTemporaryIdleLifecycle(
      idle,
      { CHROME_DEVTOOLS_AXI_IDLE_CLEANUP: "1" },
      () => time,
    );
    expect(lifecycle).toBeDefined();
    time = 599999;
    lifecycle!.check();
    expect(idle).not.toHaveBeenCalled();
    time = 600000;
    lifecycle!.check();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("excludes attached, visible and persistent browsers even when enabled", () => {
    for (const key of [
      "AUTO_CONNECT",
      "BROWSER_URL",
      "USER_DATA_DIR",
      "HEADED",
    ]) {
      expect(
        createTemporaryIdleLifecycle(vi.fn(), {
          CHROME_DEVTOOLS_AXI_IDLE_CLEANUP: "1",
          [`CHROME_DEVTOOLS_AXI_${key}`]: "1",
        }),
      ).toBeUndefined();
    }
  });
});
