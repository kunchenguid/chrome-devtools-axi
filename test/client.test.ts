import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import {
  CdpError,
  checkBridgeHealth,
  mapErrorMessage,
  resolveBridgeTimeoutMs,
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
            res.end(JSON.stringify({ status: "ok" }));
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
