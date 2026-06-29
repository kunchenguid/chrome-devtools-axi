import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { BRIDGE_PORT_IN_USE_EXIT_CODE } from "../src/bridge.js";
import {
  buildBridgeEarlyExitError,
  CdpError,
  checkBridgeHealth,
  ensureBridge,
  getSessionSnapshotIfRunning,
  mapErrorMessage,
  resolveBridgeTimeoutMs,
  type SpawnedBridge,
  stopBridge,
  terminateBridgeProcess,
  waitForProcessExit,
} from "../src/client.js";

describe("CdpError", () => {
  it("uses the shared axi-sdk-js error contract", () => {
    const error = new CdpError("boom", "UNKNOWN", ["try again"]);

    expect(error).toBeInstanceOf(AxiError);
    expect(error.code).toBe("UNKNOWN");
    expect(error.suggestions).toEqual(["try again"]);
  });
});

describe("mapErrorMessage", () => {
  it("maps bridge connectivity failures", () => {
    const error = mapErrorMessage("connect ECONNREFUSED 127.0.0.1:9224");

    expect(error.code).toBe("BRIDGE_NOT_READY");
    expect(error.message).toContain("Bridge is not running");
  });

  it("maps element lookup failures", () => {
    const error = mapErrorMessage("element uid not found");

    expect(error.code).toBe("REF_NOT_FOUND");
  });

  it("maps JSON-encoded browser errors", () => {
    const error = mapErrorMessage(JSON.stringify({ error: "Page crashed" }));

    expect(error.code).toBe("BROWSER_ERROR");
    expect(error.message).toBe("Page crashed");
  });
});

describe("unsafe session names are rejected on action entry points", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = saved;
    }
  });

  it("stopBridge rejects a dot-only session instead of killing the default bridge", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(stopBridge()).rejects.toThrow(/Invalid/);
  });

  it("ensureBridge rejects a dot-only session instead of targeting the default bridge", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(ensureBridge()).rejects.toThrow(/Invalid/);
  });

  it("getSessionSnapshotIfRunning degrades an invalid session to null instead of throwing", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
  });
});

describe("resolveBridgeTimeoutMs", () => {
  let savedTimeout: string | undefined;

  beforeEach(() => {
    savedTimeout = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (savedTimeout === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = savedTimeout;
    }
  });

  it("defaults to 30s when env var is unset", () => {
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("honors a numeric env value", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "60000";
    expect(resolveBridgeTimeoutMs()).toBe(60_000);
  });

  it("clamps tiny values to a 1s floor (avoids pathological retries)", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "10";
    expect(resolveBridgeTimeoutMs()).toBe(1_000);
  });

  it("falls back to default when value is non-numeric", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "soon";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("falls back to default when value is zero or negative", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "0";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "-100";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });
});

interface FakeBridgeOptions {
  shallow: "ok" | "error";
  deep: "ok" | "error";
  deepDelayMs?: number;
  session?: string;
}

function startFakeBridgeServer(opts: FakeBridgeOptions): Promise<{
  port: number;
  server: Server;
  close: () => Promise<void>;
}> {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        const wantsDeep = req.url.includes("deep=1");
        const outcome = wantsDeep ? opts.deep : opts.shallow;
        res.setHeader("Content-Type", "application/json");
        const sendResponse = () => {
          if (outcome === "ok") {
            res.statusCode = 200;
            res.end(JSON.stringify({ status: "ok", session: opts.session }));
          } else {
            res.statusCode = 503;
            res.end(JSON.stringify({ status: "error" }));
          }
        };
        if (wantsDeep && opts.deepDelayMs) {
          setTimeout(sendResponse, opts.deepDelayMs);
        } else {
          sendResponse();
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        port,
        server,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

describe("checkBridgeHealth (deep probe)", () => {
  it("returns true on a shallow probe when /health responds 200 ok", async () => {
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "error" });
    try {
      expect(await checkBridgeHealth(fake.port)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("returns false on the deep probe when the bridge reports CDP target unreachable", async () => {
    // This is the exact stale-bridge scenario from issue #43: the local MCP
    // server still answers /health, but the attached browser is gone, so the
    // deep probe correctly reports unhealthy.
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "error" });
    try {
      expect(await checkBridgeHealth(fake.port)).toBe(true);
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("returns true on the deep probe when the bridge reports both layers healthy", async () => {
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "ok" });
    try {
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("allows a slower deep probe to complete successfully", async () => {
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      deepDelayMs: 2200,
    });
    try {
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(true);
    } finally {
      await fake.close();
    }
  }, 10_000);

  it("returns false when nothing is listening on the port", async () => {
    // Port 1 is privileged and unbound — connection should be refused immediately.
    expect(await checkBridgeHealth(1)).toBe(false);
    expect(await checkBridgeHealth(1, { deep: true })).toBe(false);
  });

  it("treats a session-name mismatch as unhealthy (another session's bridge)", async () => {
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      session: "worker-1",
    });
    try {
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-2" }),
      ).toBe(false);
      expect(
        await checkBridgeHealth(fake.port, {
          deep: true,
          expectedSession: "worker-2",
        }),
      ).toBe(false);
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-1" }),
      ).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("accepts a bridge that omits the session field (older version)", async () => {
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "ok" });
    try {
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-1" }),
      ).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("buildBridgeEarlyExitError", () => {
  const savedMcpPath = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CHROME_DEVTOOLS_AXI_MCP_PATH", savedMcpPath);
  });

  it("names the session, port, exit code, and the port-in-use remedy on the EADDRINUSE code", () => {
    const err = buildBridgeEarlyExitError(
      "worker-2",
      9231,
      BRIDGE_PORT_IN_USE_EXIT_CODE,
      null,
    );

    expect(err).toBeInstanceOf(CdpError);
    expect(err.code).toBe("BRIDGE_NOT_READY");
    expect(err.message).toContain("worker-2");
    expect(err.message).toContain("9231");
    expect(err.message).toContain(
      `exited with code ${BRIDGE_PORT_IN_USE_EXIT_CODE}`,
    );
    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("9231");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_PORT");
    // Balanced wording: not over-attributed to a session collision - also
    // names stale/crashed bridges and unrelated processes, with the
    // free-the-port remedy stated directly.
    expect(suggestions).toContain("unrelated process");
    expect(suggestions).toMatch(/stale|crashed/);
    expect(suggestions).toContain("free");
  });

  it("gives generic startup guidance (not port collision) for a non-EADDRINUSE early exit", () => {
    delete process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    const err = buildBridgeEarlyExitError("worker-2", 9231, 1, null);

    expect(err.code).toBe("BRIDGE_NOT_READY");
    expect(err.message).toContain("exited with code 1");
    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("chrome-devtools-mcp");
    expect(suggestions).not.toContain("hashed-port collision");
    expect(suggestions).not.toContain("another session's bridge");
  });

  it("points at CHROME_DEVTOOLS_AXI_MCP_PATH when an explicit path is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp.js";
    const err = buildBridgeEarlyExitError("worker-2", 9231, 1, null);

    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_MCP_PATH");
    expect(suggestions).not.toContain("npm prefix -g");
  });

  it("reports the terminating signal when the bridge was killed", () => {
    const err = buildBridgeEarlyExitError("worker-2", 9231, null, "SIGKILL");

    expect(err.message).toContain("was killed by SIGKILL");
  });
});

describe("ensureBridge early-exit fast-fail", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedTimeout = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;
  let tmpHome: string;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    // Isolate state under a throwaway HOME so no real bridge.pid is found and
    // ensureBridge is forced down the spawn-a-new-bridge path.
    tmpHome = mkdtempSync(join(tmpdir(), "axi-ensure-bridge-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "early-exit-worker";
    delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    // A long deadline so the assertion proves the *early-exit* path returns
    // fast, not that it merely hit the timeout.
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "20000";
  });

  afterEach(() => {
    restore("CHROME_DEVTOOLS_AXI_SESSION", savedSession);
    restore("HOME", savedHome);
    restore("CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS", savedTimeout);
    restore("CHROME_DEVTOOLS_AXI_PORT", savedPort);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("fails fast with a port-collision error when the bridge exits with the EADDRINUSE code", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await ensureBridge(() => {
        const fake = new EventEmitter();
        // Emit *after* ensureBridge attaches its exit listener.
        setImmediate(() =>
          fake.emit("exit", BRIDGE_PORT_IN_USE_EXIT_CODE, null),
        );
        return fake as unknown as SpawnedBridge;
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("BRIDGE_NOT_READY");
    expect((caught as CdpError).message).toContain("before becoming ready");
    expect((caught as CdpError).suggestions.join("\n")).toContain(
      "CHROME_DEVTOOLS_AXI_PORT",
    );
    // The whole point: detecting the early exit must beat the 20s deadline.
    expect(elapsed).toBeLessThan(5000);
  });

  it("fails fast with generic startup guidance for a non-EADDRINUSE early exit", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await ensureBridge(() => {
        const fake = new EventEmitter();
        setImmediate(() => fake.emit("exit", 1, null));
        return fake as unknown as SpawnedBridge;
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(CdpError);
    const suggestions = (caught as CdpError).suggestions.join("\n");
    expect(suggestions).toContain("chrome-devtools-mcp");
    expect(suggestions).not.toContain("hashed-port collision");
    expect(elapsed).toBeLessThan(5000);
  });

  it("reuses a healthy same-session bridge that won the bind race instead of failing on the loser's early exit", async () => {
    // A concurrent same-session bridge owns the port and reports healthy only on
    // the *second* deep probe, so the loser's first in-loop check fails and the
    // pre-throw final deep check is what catches the winner.
    let deepProbes = 0;
    const winner = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        const wantsDeep = req.url.includes("deep=1");
        if (wantsDeep) deepProbes++;
        res.setHeader("Content-Type", "application/json");
        const healthy = !wantsDeep || deepProbes >= 2;
        res.statusCode = healthy ? 200 : 503;
        res.end(
          JSON.stringify(
            healthy
              ? { status: "ok", session: "early-exit-worker" }
              : { status: "error" },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => winner.listen(0, "127.0.0.1", () => r()));
    const winnerPort = (winner.address() as AddressInfo).port;
    process.env.CHROME_DEVTOOLS_AXI_PORT = String(winnerPort);

    try {
      const port = await ensureBridge(() => {
        const loser = new EventEmitter();
        setImmediate(() =>
          loser.emit("exit", BRIDGE_PORT_IN_USE_EXIT_CODE, null),
        );
        return loser as unknown as SpawnedBridge;
      });
      expect(port).toBe(winnerPort);
      expect(deepProbes).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((r) => winner.close(() => r()));
    }
  });
});

describe("waitForProcessExit", () => {
  it("returns true once the process is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid as number;
    child.unref();

    // Process is alive at first
    expect(await waitForProcessExit(pid, 50)).toBe(false);

    // After it exits naturally, the wait should succeed
    expect(await waitForProcessExit(pid, 2000)).toBe(true);
  });

  it("returns false when the process outlives the timeout", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
      },
    );
    const pid = child.pid as number;
    try {
      expect(await waitForProcessExit(pid, 100)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});

describe("terminateBridgeProcess", () => {
  function waitForFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        try {
          resolve(readFileSync(path, "utf-8").trim());
          return;
        } catch (err) {
          if (Date.now() >= deadline) {
            reject(err);
            return;
          }
          setTimeout(poll, 25);
        }
      };
      poll();
    });
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("waits for the bridge process to actually exit before returning", async () => {
    // Mimics a well-behaved bridge: exits cleanly on SIGTERM.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000);",
      ],
      { stdio: "ignore", detached: true },
    );
    const pid = child.pid as number;
    child.unref();

    // Give the listener a moment to register before we send the signal.
    await new Promise((r) => setTimeout(r, 50));
    await terminateBridgeProcess(pid);

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("escalates to SIGKILL when the bridge ignores SIGTERM", async () => {
    // Mimics a stuck bridge: ignores SIGTERM. Without escalation, stop +
    // start can't recover (issue #43). The 2s SIGTERM grace window means
    // the test takes ~2s to drive the escalation path.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);"],
      { stdio: "ignore", detached: true },
    );
    const pid = child.pid as number;
    child.unref();

    await new Promise((r) => setTimeout(r, 50));
    await terminateBridgeProcess(pid);

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10_000);

  it("is a no-op when the pid is already gone", async () => {
    // Pick a likely-unused pid by spawning + waiting for it to exit.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise<void>((r) => child.on("exit", () => r()));

    await expect(terminateBridgeProcess(pid)).resolves.toBeUndefined();
  });

  it("does not kill the process group unless group termination is trusted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-devtools-axi-test-"));
    const childPidFile = join(dir, "child.pid");
    const parent = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
          `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
          "process.on('SIGTERM', () => {});",
          "setTimeout(() => {}, 30000);",
        ].join(""),
      ],
      { stdio: "ignore", detached: true },
    );
    const parentPid = parent.pid as number;
    parent.unref();

    const childPid = Number.parseInt(await waitForFile(childPidFile), 10);
    try {
      await terminateBridgeProcess(parentPid);

      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
