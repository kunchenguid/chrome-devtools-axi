import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeServer, type BridgeClient } from "../src/bridge.js";
import { callTool, checkBridgeHealth, ensureBridge } from "../src/client.js";
import { getSelectedPageId, setSelectedPageId } from "../src/selected-page.js";
import { resolveSessionPidFile } from "../src/sessions.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("busy bridge health", () => {
  let home: string;
  let savedEnv: NodeJS.ProcessEnv;
  let server: Server;
  let owner: ChildProcess;
  let port: number;
  let connected: boolean;
  let targetAlive: boolean;
  let probes: number;
  let failWait: boolean;
  let queue: Promise<unknown>;
  let entered: ReturnType<typeof deferred>;
  let release: ReturnType<typeof deferred>;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    home = mkdtempSync(join(tmpdir(), "axi-busy-test-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "busy-test";
    connected = targetAlive = true;
    failWait = false;
    probes = 0;
    entered = deferred();
    release = deferred();
    queue = Promise.resolve();
    const client: BridgeClient = {
      listTools: async () => {
        if (!connected) throw new Error("MCP disconnected");
        return { tools: [] };
      },
      callTool: ({ name, arguments: args }) => {
        // Match the roots wrapper's serialized tool calls. MCP list_pages is
        // also exclusive against a pending page wait, unlike tools/list.
        const result = queue.then(async () => {
          if (name === "list_pages") {
            probes++;
            if (!targetAlive) throw new Error("Target closed");
          }
          if (name === "wait_for") {
            entered.resolve();
            await release.promise;
            if (failWait) throw new Error("Wait failed");
          }
          if (name !== "list_pages") expect(args.pageId).toBe(7);
          return { content: [{ type: "text", text: `${name} completed` }] };
        });
        queue = result.catch(() => {});
        return result;
      },
      close: async () => {},
    };
    server = createBridgeServer(client, "busy-test");
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
    process.env.CHROME_DEVTOOLS_AXI_PORT = String(port);
    // An owned disposable process makes unintended health-triggered termination
    // observable without ever risking the test runner or a developer's bridge.
    owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pidFile = resolveSessionPidFile();
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ pid: owner.pid, port }));
    setSelectedPageId(7);
  });

  afterEach(async () => {
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    owner.kill("SIGKILL");
    process.env = savedEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the bridge and selection during a wait longer than the health deadline and a concurrent snapshot", async () => {
    const receipt = readFileSync(resolveSessionPidFile(), "utf8");
    const waiting = callTool("wait_for", { text: "synthetic absent text" });
    await entered.promise;
    const timer = setTimeout(release.resolve, 6_000);
    try {
      expect(
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: "busy-test",
        }),
      ).toBe(true);
      expect(
        await ensureBridge(() => {
          throw new Error("Busy bridge must not be replaced");
        }),
      ).toBe(port);
      const snapshot = callTool("take_snapshot", {});
      expect(await Promise.all([waiting, snapshot])).toEqual([
        "wait_for completed",
        "take_snapshot completed",
      ]);
      expect(owner.exitCode).toBeNull();
      expect(owner.signalCode).toBeNull();
      expect(readFileSync(resolveSessionPidFile(), "utf8")).toBe(receipt);
      expect(getSelectedPageId()).toBe(7);
      // Only the wait's initial idle probe ran; neither concurrent health
      // check queued list_pages. An idle check must resume target probing.
      expect(probes).toBe(1);
      expect(await checkBridgeHealth(port, { deep: true })).toBe(true);
      expect(probes).toBe(2);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await waiting.catch(() => {});
    }
  }, 20_000);

  it("refuses a busy bridge from another session and still detects a disconnected MCP", async () => {
    const waiting = callTool("wait_for", {});
    await entered.promise;
    try {
      expect(
        await checkBridgeHealth(port, { deep: true, expectedSession: "other" }),
      ).toBe(false);
      expect(await checkBridgeHealth(port, { deep: true })).toBe(false);
      expect(
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: "busy-test",
        }),
      ).toBe(true);
      connected = false;
      expect(
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: "busy-test",
        }),
      ).toBe(false);
    } finally {
      release.resolve();
      await waiting;
    }
  });

  it("resumes dead-target recovery after a pending tool rejects", async () => {
    const waiting = callTool("wait_for", {}).catch((error: unknown) => error);
    await entered.promise;
    failWait = true;
    targetAlive = false;
    release.resolve();
    expect(await waiting).toBeInstanceOf(Error);
    expect(
      await checkBridgeHealth(port, {
        deep: true,
        expectedSession: "busy-test",
      }),
    ).toBe(false);
    const oldOwner = owner;
    expect(
      await ensureBridge(() => {
        expect(getSelectedPageId()).toBeNull();
        targetAlive = true;
        owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        writeFileSync(
          resolveSessionPidFile(),
          JSON.stringify({ pid: owner.pid, port }),
        );
        return owner;
      }),
    ).toBe(port);
    expect(oldOwner.signalCode).toBe("SIGTERM");
    expect(getSelectedPageId()).toBeNull();
  });
});
