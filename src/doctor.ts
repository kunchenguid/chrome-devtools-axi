import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import {
  checkBridgeHealth,
  isBridgeProcess,
  isProcessAlive,
  stopBridgeSession,
  type StopBridgeSessionResult,
} from "./client.js";
import {
  DEFAULT_SESSION_NAME,
  defaultPortForSession,
  isPooledBridgeSessionName,
  resolveBridgePidFileForBridgeSession,
  resolveBridgeStateDirForBridgeSession,
  resolveBrowserPoolsDir,
  resolveNamedSessionsDir,
  resolveSessionPidFile,
  resolveSessionStateDir,
  resolveStateRoot,
  validateSessionName,
} from "./sessions.js";

export type SessionKind = "default" | "named" | "pooled";
export type PidFileStatus = "missing" | "ok" | "malformed";
export type BridgeStatus =
  | "no-state"
  | "running"
  | "stale-pid"
  | "suspicious-pid"
  | "unhealthy"
  | "malformed-pid";

export interface DoctorPidFile {
  path: string;
  status: PidFileStatus;
  mtime?: string;
  error?: string;
}

export interface DoctorProcessInfo {
  alive: boolean;
  isBridge: boolean;
  pid?: number;
  ppid?: number;
  pgid?: number;
  command?: string;
}

export interface DoctorPageSummary {
  count: number;
  selectedUrl?: string;
  urls: string[];
  error?: string;
}

export interface BrowserSessionDiagnostic {
  session: string;
  kind: SessionKind;
  stateDir: string;
  pidFile: DoctorPidFile;
  status: BridgeStatus;
  pid?: number;
  port?: number;
  expectedPort: number;
  startedAt?: string;
  lastActivityAt?: string;
  pidFileAgeMs?: number;
  lastActivityAgeMs?: number;
  owner?: unknown;
  process: DoctorProcessInfo;
  health?: {
    shallow: boolean;
    deep: boolean;
    sessionMatches: boolean;
  };
  pages?: DoctorPageSummary;
  flags: string[];
  cleanup?: {
    stalePidFileRemoved?: boolean;
    stopResult?: StopBridgeSessionResult;
  };
}

export interface BrowserSessionsReport {
  generatedAt: string;
  stateRoot: string;
  sessions: BrowserSessionDiagnostic[];
}

interface ParsedPidFile {
  pid: number;
  port: number;
  session?: string;
  startedAt?: string;
  lastActivityAt?: string;
  owner?: unknown;
}

export interface DoctorRuntime {
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  isBridgeProcess?: (pid: number) => boolean;
  readProcessInfo?: (pid: number) => Partial<DoctorProcessInfo> | null;
  checkHealth?: (
    port: number,
    opts?: { deep?: boolean; expectedSession?: string },
  ) => Promise<boolean>;
  listPages?: (port: number) => Promise<DoctorPageSummary>;
  unlinkFile?: (path: string) => void;
  stopSession?: (
    sessionName: string,
    opts?: { physicalPool?: boolean },
  ) => Promise<StopBridgeSessionResult>;
}

export interface InspectBrowserSessionsOptions {
  cleanStale?: boolean;
  stopUnhealthy?: boolean;
  runtime?: DoctorRuntime;
}

interface ResolvedInspectBrowserSessionsOptions {
  cleanStale: boolean;
  stopUnhealthy: boolean;
  runtime: Required<DoctorRuntime>;
}

export interface SessionsCommandArgs {
  json: boolean;
  cleanStale: boolean;
  stopUnhealthy: boolean;
}

export function parseSessionsArgs(args: string[]): SessionsCommandArgs {
  return {
    json: args.includes("--json"),
    cleanStale:
      args.includes("--clean-stale") ||
      args.includes("--clean") ||
      args.includes("--prune"),
    stopUnhealthy: args.includes("--stop-unhealthy"),
  };
}

interface SessionInventoryEntry {
  session: string;
  kind: SessionKind;
}

function listSessionEntries(): SessionInventoryEntry[] {
  const entries = new Map<string, SessionInventoryEntry>([
    [
      `default:${DEFAULT_SESSION_NAME}`,
      { session: DEFAULT_SESSION_NAME, kind: "default" },
    ],
  ]);
  const sessionsDir = resolveNamedSessionsDir();
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!existsSync(join(sessionsDir, name, "bridge.pid"))) continue;
      try {
        validateSessionName(name);
      } catch {
        continue;
      }
      entries.set(`named:${name}`, { session: name, kind: "named" });
    }
  } catch {
    // No named sessions yet.
  }
  const poolsDir = resolveBrowserPoolsDir();
  try {
    for (const entry of readdirSync(poolsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!isPooledBridgeSessionName(name)) continue;
      if (!existsSync(join(poolsDir, name, "bridge.pid"))) continue;
      entries.set(`pooled:${name}`, { session: name, kind: "pooled" });
    }
  } catch {
    // Pooling may never have been enabled.
  }
  return [...entries.values()].sort((a, b) => {
    if (a.kind === "default") return -1;
    if (b.kind === "default") return 1;
    return a.session.localeCompare(b.session) || a.kind.localeCompare(b.kind);
  });
}

function readPidFileForDoctor(pidFile: string): {
  pidFile: DoctorPidFile;
  parsed?: ParsedPidFile;
} {
  if (!existsSync(pidFile)) {
    return { pidFile: { path: pidFile, status: "missing" } };
  }

  let mtime: string | undefined;
  try {
    mtime = statSync(pidFile).mtime.toISOString();
  } catch {
    // Preserve the parse attempt; the error below will carry the useful detail.
  }

  try {
    const data = JSON.parse(readFileSync(pidFile, "utf-8")) as Record<
      string,
      unknown
    >;
    if (typeof data.pid !== "number" || typeof data.port !== "number") {
      return {
        pidFile: {
          path: pidFile,
          status: "malformed",
          mtime,
          error: "expected numeric pid and port",
        },
      };
    }
    return {
      pidFile: { path: pidFile, status: "ok", mtime },
      parsed: {
        pid: data.pid,
        port: data.port,
        session: typeof data.session === "string" ? data.session : undefined,
        startedAt:
          typeof data.startedAt === "string" ? data.startedAt : undefined,
        lastActivityAt:
          typeof data.lastActivityAt === "string"
            ? data.lastActivityAt
            : undefined,
        owner: data.owner,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pidFile: { path: pidFile, status: "malformed", mtime, error: message },
    };
  }
}

function readPsField(pid: number, field: string): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
  } catch {
    return undefined;
  }
}

function defaultReadProcessInfo(
  pid: number,
): Partial<DoctorProcessInfo> | null {
  const command = readPsField(pid, "command");
  if (!command) return null;
  const ppid = Number.parseInt(readPsField(pid, "ppid") ?? "", 10);
  const pgid = Number.parseInt(readPsField(pid, "pgid") ?? "", 10);
  return {
    command,
    ...(Number.isNaN(ppid) ? {} : { ppid }),
    ...(Number.isNaN(pgid) ? {} : { pgid }),
  };
}

function httpPost(
  port: number,
  path: string,
  body: unknown,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(data));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

function parsePagesList(
  text: string,
): { id: number; url: string; selected: boolean }[] {
  const pages: { id: number; url: string; selected: boolean }[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^(\d+):\s+(\S+)(\s+\[selected\])?/);
    if (!match) continue;
    pages.push({
      id: Number.parseInt(match[1], 10),
      url: match[2],
      selected: Boolean(match[3]),
    });
  }
  return pages;
}

async function defaultListPages(port: number): Promise<DoctorPageSummary> {
  const resp = await httpPost(port, "/call", { name: "list_pages", args: {} });
  const data = JSON.parse(resp) as { result?: unknown; error?: unknown };
  if (data.error) throw new Error(String(data.error));
  const pages = parsePagesList(
    typeof data.result === "string" ? data.result : "",
  );
  return {
    count: pages.length,
    selectedUrl: pages.find((page) => page.selected)?.url ?? pages[0]?.url,
    urls: pages.map((page) => page.url),
  };
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function ageMs(now: Date, value: string | undefined): number | undefined {
  const ms = parseTime(value);
  return ms === undefined ? undefined : Math.max(0, now.getTime() - ms);
}

async function inspectOneSession(
  session: string,
  kind: SessionKind,
  options: ResolvedInspectBrowserSessionsOptions,
): Promise<BrowserSessionDiagnostic> {
  const now = options.runtime.now();
  const stateDir =
    kind === "pooled"
      ? resolveBridgeStateDirForBridgeSession(session, true)
      : resolveSessionStateDir(session);
  const pidFilePath =
    kind === "pooled"
      ? resolveBridgePidFileForBridgeSession(session, true)
      : resolveSessionPidFile(session);
  const { pidFile, parsed } = readPidFileForDoctor(pidFilePath);
  const flags: string[] = [];
  let status: BridgeStatus = "no-state";
  let processInfo: DoctorProcessInfo = { alive: false, isBridge: false };
  let health: BrowserSessionDiagnostic["health"];
  let pages: DoctorPageSummary | undefined;
  let cleanup: BrowserSessionDiagnostic["cleanup"];

  if (pidFile.status === "missing") {
    status = "no-state";
  } else if (pidFile.status === "malformed") {
    status = "malformed-pid";
    flags.push("malformed_pid_file");
  }

  if (parsed) {
    const alive = options.runtime.isProcessAlive(parsed.pid);
    const isBridge = alive
      ? options.runtime.isBridgeProcess(parsed.pid)
      : false;
    const psInfo = alive ? options.runtime.readProcessInfo(parsed.pid) : null;
    processInfo = {
      alive,
      isBridge,
      pid: parsed.pid,
      ...(psInfo ?? {}),
    };

    if (!alive) {
      status = "stale-pid";
      flags.push("pid_not_alive");
      if (
        options.cleanStale &&
        options.runtime.isProcessAlive(parsed.pid) === false
      ) {
        options.runtime.unlinkFile(pidFilePath);
        cleanup = { stalePidFileRemoved: true };
        flags.push("stale_pid_file_removed");
      }
    } else if (!isBridge) {
      status = "suspicious-pid";
      flags.push("pid_alive_but_not_bridge");
    } else {
      if (processInfo.pgid !== undefined && processInfo.pgid !== parsed.pid) {
        flags.push("bridge_not_process_group_leader");
      }
      const shallowAny = await options.runtime.checkHealth(parsed.port);
      const shallowExpected = await options.runtime.checkHealth(parsed.port, {
        expectedSession: session,
      });
      const deepExpected = await options.runtime.checkHealth(parsed.port, {
        deep: true,
        expectedSession: session,
      });
      health = {
        shallow: shallowExpected,
        deep: deepExpected,
        sessionMatches: !shallowAny || shallowExpected,
      };
      const sessionMismatch = shallowAny && !shallowExpected;
      if (sessionMismatch) flags.push("session_mismatch");
      if (!shallowExpected) flags.push("bridge_health_failed");
      if (shallowExpected && !deepExpected) flags.push("deep_health_failed");

      if (deepExpected) {
        status = "running";
        try {
          pages = await options.runtime.listPages(parsed.port);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          pages = { count: 0, urls: [], error: message };
          flags.push("list_pages_failed");
        }
      } else {
        status = "unhealthy";
        if (options.stopUnhealthy && !sessionMismatch) {
          const stopResult =
            kind === "pooled"
              ? await options.runtime.stopSession(session, {
                  physicalPool: true,
                })
              : await options.runtime.stopSession(session);
          cleanup = { ...(cleanup ?? {}), stopResult };
          flags.push(`stop_unhealthy_${stopResult.replace("-", "_")}`);
        }
      }
    }
  }

  return {
    session,
    kind,
    stateDir,
    pidFile,
    status,
    ...(parsed
      ? {
          pid: parsed.pid,
          port: parsed.port,
          startedAt: parsed.startedAt,
          lastActivityAt: parsed.lastActivityAt,
          owner: parsed.owner,
        }
      : {}),
    expectedPort: defaultPortForSession(session),
    pidFileAgeMs: ageMs(now, pidFile.mtime),
    lastActivityAgeMs: ageMs(now, parsed?.lastActivityAt),
    process: processInfo,
    ...(health ? { health } : {}),
    ...(pages ? { pages } : {}),
    flags,
    ...(cleanup ? { cleanup } : {}),
  };
}

export async function inspectBrowserSessions(
  opts: InspectBrowserSessionsOptions = {},
): Promise<BrowserSessionsReport> {
  const runtime: Required<DoctorRuntime> = {
    now: opts.runtime?.now ?? (() => new Date()),
    isProcessAlive: opts.runtime?.isProcessAlive ?? isProcessAlive,
    isBridgeProcess: opts.runtime?.isBridgeProcess ?? isBridgeProcess,
    readProcessInfo: opts.runtime?.readProcessInfo ?? defaultReadProcessInfo,
    checkHealth: opts.runtime?.checkHealth ?? checkBridgeHealth,
    listPages: opts.runtime?.listPages ?? defaultListPages,
    unlinkFile: opts.runtime?.unlinkFile ?? unlinkSync,
    stopSession: opts.runtime?.stopSession ?? stopBridgeSession,
  };
  const options: ResolvedInspectBrowserSessionsOptions = {
    cleanStale: opts.cleanStale ?? false,
    stopUnhealthy: opts.stopUnhealthy ?? false,
    runtime,
  };
  const sessions = await Promise.all(
    listSessionEntries().map(({ session, kind }) =>
      inspectOneSession(session, kind, options),
    ),
  );
  return {
    generatedAt: runtime.now().toISOString(),
    stateRoot: resolveStateRoot(),
    sessions,
  };
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).replaceAll(",", "%2C");
}

export function formatBrowserSessionsReport(
  report: BrowserSessionsReport,
  opts: { json?: boolean } = {},
): string {
  if (opts.json) return `${JSON.stringify(report, null, 2)}\n`;

  const rows = report.sessions.map((session) =>
    [
      session.session,
      session.kind,
      session.status,
      session.pid,
      session.port,
      session.process.pgid,
      formatAge(session.pidFileAgeMs),
      formatAge(session.lastActivityAgeMs),
      session.pages?.count,
      session.pages?.selectedUrl,
      session.flags.length > 0 ? session.flags.join("|") : "ok",
    ]
      .map(formatCell)
      .join(","),
  );

  const summary = {
    stateRoot: report.stateRoot,
    sessions: report.sessions.length,
    running: report.sessions.filter((session) => session.status === "running")
      .length,
    flagged: report.sessions.filter((session) => session.flags.length > 0)
      .length,
  };
  return [
    encode(summary),
    "sessions{session,kind,status,pid,port,pgid,pidFileAge,lastActivityAge,pages,selectedUrl,flags}:",
    ...rows.map((row) => `  ${row}`),
  ].join("\n");
}
