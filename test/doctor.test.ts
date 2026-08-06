import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBrowserSessionsReport,
  inspectBrowserSessions,
  parseSessionsArgs,
  type DoctorRuntime,
} from "../src/doctor.js";

describe("browser session diagnostics", () => {
  const savedHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-doctor-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function stateDir(session = "default"): string {
    if (/^pool-\d+$/.test(session)) {
      return join(home, ".chrome-devtools-axi", "pools", session);
    }
    return session === "default"
      ? join(home, ".chrome-devtools-axi")
      : join(home, ".chrome-devtools-axi", "sessions", session);
  }

  function writePid(session: string, data: unknown): string {
    const dir = stateDir(session);
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, "bridge.pid");
    writeFileSync(pidFile, JSON.stringify(data));
    return pidFile;
  }

  it("reports the default session as no-state without starting a bridge", async () => {
    mkdirSync(stateDir("old-worker"), { recursive: true });

    const report = await inspectBrowserSessions({
      runtime: { now: () => new Date("2026-08-06T12:00:00.000Z") },
    });

    expect(report.stateRoot).toBe(join(home, ".chrome-devtools-axi"));
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      session: "default",
      kind: "default",
      status: "no-state",
      flags: [],
    });
  });

  it("inventories named and pooled sessions with owner, health, and pages", async () => {
    writePid("pool-3", {
      pid: 12345,
      port: 9555,
      session: "pool-3",
      startedAt: "2026-08-06T11:00:00.000Z",
      lastActivityAt: "2026-08-06T11:59:30.000Z",
      owner: { user: "agent", cwd: "/worktree" },
    });

    const runtime: DoctorRuntime = {
      now: () => new Date("2026-08-06T12:00:00.000Z"),
      isProcessAlive: (pid) => pid === 12345,
      isBridgeProcess: (pid) => pid === 12345,
      readProcessInfo: () => ({
        ppid: 100,
        pgid: 12345,
        command: "node chrome-devtools-axi-bridge.js",
      }),
      checkHealth: async () => true,
      listPages: async () => ({
        count: 2,
        selectedUrl: "https://example.com/",
        urls: ["https://example.com/", "https://openai.com/"],
      }),
    };

    const report = await inspectBrowserSessions({ runtime });
    const pooled = report.sessions.find(
      (session) => session.session === "pool-3",
    );

    expect(pooled).toMatchObject({
      kind: "pooled",
      status: "running",
      pid: 12345,
      port: 9555,
      lastActivityAgeMs: 30_000,
      owner: { user: "agent", cwd: "/worktree" },
      process: { alive: true, isBridge: true, pgid: 12345 },
      health: { shallow: true, deep: true, sessionMatches: true },
      pages: { count: 2, selectedUrl: "https://example.com/" },
      flags: [],
    });
  });

  it("keeps a named pool-number session distinct from a physical pool slot", async () => {
    const namedDir = join(home, ".chrome-devtools-axi", "sessions", "pool-1");
    const pooledDir = join(home, ".chrome-devtools-axi", "pools", "pool-1");
    mkdirSync(namedDir, { recursive: true });
    mkdirSync(pooledDir, { recursive: true });
    writeFileSync(
      join(namedDir, "bridge.pid"),
      JSON.stringify({ pid: 101, port: 9301, session: "pool-1" }),
    );
    writeFileSync(
      join(pooledDir, "bridge.pid"),
      JSON.stringify({ pid: 202, port: 9401, session: "pool-1" }),
    );

    const report = await inspectBrowserSessions({
      runtime: { isProcessAlive: () => false },
    });
    expect(
      report.sessions.filter((entry) => entry.session === "pool-1"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "named", pid: 101, port: 9301 }),
        expect.objectContaining({ kind: "pooled", pid: 202, port: 9401 }),
      ]),
    );
  });

  it("flags session mismatches and failed deep health as unhealthy", async () => {
    writePid("worker-1", { pid: 222, port: 9444 });
    const stopSession = vi.fn();

    const report = await inspectBrowserSessions({
      stopUnhealthy: true,
      runtime: {
        isProcessAlive: (pid) => pid === 222,
        isBridgeProcess: () => true,
        readProcessInfo: () => ({
          pgid: 222,
          command: "chrome-devtools-axi-bridge",
        }),
        checkHealth: async (_port, opts) => opts?.expectedSession === undefined,
        stopSession,
      },
    });

    const worker = report.sessions.find(
      (session) => session.session === "worker-1",
    );
    expect(worker?.status).toBe("unhealthy");
    expect(worker?.flags).toContain("session_mismatch");
    expect(worker?.flags).toContain("bridge_health_failed");
    expect(stopSession).not.toHaveBeenCalled();
    expect(worker?.cleanup).toBeUndefined();
  });

  it("stops unhealthy bridges only when health fails for the same session", async () => {
    writePid("worker-1", { pid: 222, port: 9444, session: "worker-1" });
    const stopSession = vi.fn(async () => "stopped" as const);

    const report = await inspectBrowserSessions({
      stopUnhealthy: true,
      runtime: {
        isProcessAlive: (pid) => pid === 222,
        isBridgeProcess: () => true,
        readProcessInfo: () => ({
          pgid: 222,
          command: "chrome-devtools-axi-bridge",
        }),
        checkHealth: async (_port, opts) => opts?.deep !== true,
        stopSession,
      },
    });

    const worker = report.sessions.find(
      (session) => session.session === "worker-1",
    );
    expect(worker?.status).toBe("unhealthy");
    expect(worker?.flags).toContain("deep_health_failed");
    expect(worker?.flags).toContain("stop_unhealthy_stopped");
    expect(stopSession).toHaveBeenCalledWith("worker-1", {
      target: "dedicated",
    });
  });

  it("preserves the dedicated cleanup target when pooling is configured", async () => {
    const savedPoolSize = process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE;
    process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE = "2";
    writePid("worker-1", {
      pid: 222,
      port: 9444,
      session: "worker-1",
    });
    const stopSession = vi.fn(async () => "stopped" as const);

    try {
      await inspectBrowserSessions({
        stopUnhealthy: true,
        runtime: {
          isProcessAlive: (pid) => pid === 222,
          isBridgeProcess: () => true,
          readProcessInfo: () => ({
            pgid: 222,
            command: "chrome-devtools-axi-bridge",
          }),
          checkHealth: async (_port, opts) => opts?.deep !== true,
          stopSession,
        },
      });

      expect(stopSession).toHaveBeenCalledWith("worker-1", {
        target: "dedicated",
      });
    } finally {
      if (savedPoolSize === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE = savedPoolSize;
      }
    }
  });

  it("cleans stale PID files only when explicitly requested and the PID is dead", async () => {
    const pidFile = writePid("default", { pid: 99999999, port: 9224 });

    const dryRun = await inspectBrowserSessions({
      runtime: { isProcessAlive: () => false },
    });
    expect(dryRun.sessions[0]?.status).toBe("stale-pid");
    expect(existsSync(pidFile)).toBe(true);

    const cleaned = await inspectBrowserSessions({
      cleanStale: true,
      runtime: { isProcessAlive: () => false },
    });

    expect(cleaned.sessions[0]?.cleanup).toEqual({
      stalePidFileRemoved: true,
    });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not clean malformed PID files because there is no validated PID", async () => {
    mkdirSync(stateDir("default"), { recursive: true });
    const pidFile = join(stateDir("default"), "bridge.pid");
    writeFileSync(pidFile, "not json");

    const report = await inspectBrowserSessions({ cleanStale: true });

    expect(report.sessions[0]?.status).toBe("malformed-pid");
    expect(report.sessions[0]?.flags).toContain("malformed_pid_file");
    expect(readFileSync(pidFile, "utf-8")).toBe("not json");
  });

  it("formats machine-readable and human-readable reports", async () => {
    const report = await inspectBrowserSessions({
      runtime: { now: () => new Date("2026-08-06T12:00:00.000Z") },
    });

    const json = formatBrowserSessionsReport(report, { json: true });
    expect(JSON.parse(json)).toMatchObject({
      sessions: [{ session: "default" }],
    });

    const human = formatBrowserSessionsReport(report);
    expect(human).toContain("sessions{session,kind,status");
    expect(human).toContain("default,default,no-state");
  });
});

describe("parseSessionsArgs", () => {
  it("parses machine and cleanup flags", () => {
    expect(
      parseSessionsArgs(["--json", "--clean-stale", "--stop-unhealthy"]),
    ).toEqual({
      json: true,
      cleanStale: true,
      stopUnhealthy: true,
    });
  });

  it("treats cleanup aliases as explicit stale cleanup", () => {
    expect(parseSessionsArgs(["--clean"]).cleanStale).toBe(true);
    expect(parseSessionsArgs(["--prune"]).cleanStale).toBe(true);
  });
});
