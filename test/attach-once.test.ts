import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACH_ONCE_ENV,
  isAttachOnce,
  resolveBridgeSessionName,
  resolveSessionPort,
  resolveSessionStateDir,
} from "../src/sessions.js";
import {
  detachSession,
  ensureBridge,
  type SpawnedBridge,
} from "../src/client.js";
import { getSelectedPageId, setSelectedPageId } from "../src/selected-page.js";

const KEYS = [
  "HOME",
  "CHROME_DEVTOOLS_AXI_SESSION",
  "CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
  "CHROME_DEVTOOLS_AXI_CHANNEL",
  "CHROME_DEVTOOLS_AXI_PORT",
  "CHROME_DEVTOOLS_AXI_BROWSER_URL",
  "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL",
  "CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS",
  ATTACH_ONCE_ENV,
];

let saved: Record<string, string | undefined> = {};
let tmpHome: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "axi-attach-once-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("isAttachOnce", () => {
  it("is on with autoConnect and off without it", () => {
    expect(isAttachOnce()).toBe(false);
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    expect(isAttachOnce()).toBe(true);
  });

  it("turns off with ATTACH_ONCE=0, a browser URL, a shared MCP URL or an explicit port", () => {
    for (const [key, value] of [
      [ATTACH_ONCE_ENV, "0"],
      ["CHROME_DEVTOOLS_AXI_BROWSER_URL", "http://127.0.0.1:9222"],
      ["CHROME_DEVTOOLS_AXI_MCP_SERVER_URL", "http://127.0.0.1:9333/mcp"],
      ["CHROME_DEVTOOLS_AXI_PORT", "9999"],
    ]) {
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
      process.env[key] = value;
      expect(isAttachOnce(), key).toBe(false);
      delete process.env[key];
    }
  });
});

describe("resolveBridgeSessionName", () => {
  it("is the session's own name outside attach-once", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-1";
    expect(resolveBridgeSessionName()).toBe("worker-1");
  });

  it("is one shared name per channel for every session in attach-once", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "agent-a";
    const a = resolveBridgeSessionName();
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "agent-b";
    expect(resolveBridgeSessionName()).toBe(a);
    expect(a).toBe("attach-once.stable");
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "canary";
    expect(resolveBridgeSessionName()).toBe("attach-once.canary");
  });

  it("still rejects an unsafe session name", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "../escape";
    expect(() => resolveBridgeSessionName()).toThrow(/Invalid/);
  });
});

describe("ensureBridge in attach-once mode", () => {
  async function spawnedFor(session: string): Promise<[number, string]> {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = session;
    let spawned: [number, string] | null = null;
    await expect(
      ensureBridge((port, name) => {
        spawned = [port, name];
        const fake = new EventEmitter();
        setImmediate(() => fake.emit("exit", 1, null));
        return fake as unknown as SpawnedBridge;
      }),
    ).rejects.toThrow(/before becoming ready/);
    return spawned!;
  }

  it("starts the one shared bridge for every session, keeping their state apart", async () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "20000";

    const a = await spawnedFor("agent-a");
    const b = await spawnedFor("agent-b");

    expect(a).toEqual(b);
    expect(a).toEqual([
      resolveSessionPort("attach-once.stable"),
      "attach-once.stable",
    ]);
    expect(resolveSessionStateDir("agent-a")).not.toBe(
      resolveSessionStateDir("agent-b"),
    );
  });

  it("spawns a bridge per session when attach-once is off", async () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env[ATTACH_ONCE_ENV] = "0";
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "20000";

    expect((await spawnedFor("agent-a"))[1]).toBe("agent-a");
    expect((await spawnedFor("agent-b"))[1]).toBe("agent-b");
  });
});

describe("detachSession", () => {
  it("forgets only this session's page and reports no shared bridge running", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "agent-b";
    setSelectedPageId(7);
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "agent-a";
    setSelectedPageId(3);

    expect(detachSession()).toBe(false);

    expect(getSelectedPageId()).toBeNull();
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "agent-b";
    expect(getSelectedPageId()).toBe(7);
  });
});
