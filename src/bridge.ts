/**
 * Persistent MCP bridge server for chrome-devtools-axi.
 *
 * Spawns chrome-devtools-mcp as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok", session } or 503 { status: "error", error }
 *   GET  /health?deep=1         → also verifies the attached CDP target; 503 may include reason
 *
 * Writes a PID file to the active bridge's state dir on startup
 * (~/.chrome-devtools-axi/bridge.pid for the unpooled default session, named
 * sessions under sessions/<name>/, or pooled bridges under pools/pool-<slot>/).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  resolveActiveBridgePidFile,
  resolveBrowserPoolSize,
  resolveSessionName,
  resolveSessionPort,
} from "./sessions.js";
import { withPidFileLock } from "./pid-file.js";

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
  routeSession?: string;
  routeIdleTimeoutMs?: number;
}

export const AMBIENT_SNAPSHOT_TOOL = "__axi_snapshot_if_owned";

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export const DEFAULT_BRIDGE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_ROUTE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve how long an unused bridge stays alive. The bridge is intentionally
 * persistent across short-lived CLI invocations, but it must eventually reap
 * its MCP/Chrome process tree when the owning agent disappears without
 * running `stop`.
 */
export function resolveBridgeIdleTimeoutMs(
  value = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS,
): number {
  if (value === undefined || value === "") {
    return DEFAULT_BRIDGE_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS must be an integer >= 1000",
    );
  }
  return parsed;
}

export function resolvePhysicalBridgeIdleTimeoutMs(
  pooled: boolean,
  value = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS,
): number {
  return pooled
    ? DEFAULT_BRIDGE_IDLE_TIMEOUT_MS
    : resolveBridgeIdleTimeoutMs(value);
}

/**
 * Resolve the default idle window for a logical route in a pooled bridge.
 * An explicit route timeout wins; otherwise route cleanup inherits the
 * independently resolved physical bridge timeout. Individual requests may
 * still supply a shorter or longer timeout for their route only.
 */
export function resolveRouteIdleTimeoutMs(
  value = process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS,
  bridgeIdleTimeoutMs = DEFAULT_ROUTE_IDLE_TIMEOUT_MS,
): number {
  if (value === undefined || value === "") {
    return bridgeIdleTimeoutMs;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS must be an integer >= 1000",
    );
  }
  return parsed;
}

export function resolveBridgeLifecycleTimeouts(
  pooled: boolean,
  bridgeValue = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS,
): { bridgeIdleTimeoutMs: number; routeIdleTimeoutMs?: number } {
  const bridgeIdleTimeoutMs = resolvePhysicalBridgeIdleTimeoutMs(
    pooled,
    bridgeValue,
  );
  return {
    bridgeIdleTimeoutMs,
    ...(pooled
      ? {
          routeIdleTimeoutMs: bridgeIdleTimeoutMs,
        }
      : {}),
  };
}

export interface BridgeIdleWatchdog {
  beginRequest(): () => void;
  setTimeoutMs(timeoutMs: number): void;
  stop(): void;
}

/**
 * Shut down a bridge after a bounded period with no HTTP clients. In-flight
 * requests suspend the timer, and every completed request starts a fresh idle
 * window. The returned completion callback is idempotent so request error
 * paths cannot accidentally underflow the active-request count.
 */
export function createBridgeIdleWatchdog(
  initialTimeoutMs: number,
  onIdle: () => void | Promise<void>,
): BridgeIdleWatchdog {
  let timeoutMs = initialTimeoutMs;
  let activeRequests = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    clearTimer();
    if (stopped || activeRequests > 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || activeRequests > 0) return;
      stopped = true;
      void onIdle();
    }, timeoutMs);
    timer.unref();
  };

  arm();

  return {
    beginRequest() {
      if (stopped) return () => {};
      clearTimer();
      activeRequests++;
      let finished = false;
      return () => {
        if (finished || stopped) return;
        finished = true;
        activeRequests--;
        arm();
      };
    },
    setTimeoutMs(nextTimeoutMs) {
      timeoutMs = nextTimeoutMs;
      arm();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

export async function isBridgeClientConnected(
  client: BridgeClient,
): Promise<boolean> {
  try {
    await client.listTools();
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether the bridge's underlying CDP target is reachable. Drives one
 * round-trip MCP tool call (`list_pages`) that requires a live browser/CDP
 * connection — `listTools()` alone only confirms the local MCP server is up,
 * not that the attached browser is still alive. Used by `/health?deep=1` so
 * `ensureBridge` can detect a stale bridge after the user kills + restarts
 * the underlying Chrome/Electron target.
 */
export async function isBridgeTargetReachable(
  client: BridgeClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await client.callTool({ name: "list_pages", arguments: {} });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }
}

function resolveOwnerMetadata(): Record<string, unknown> {
  const owner: Record<string, unknown> = {
    pid: process.pid,
    ppid: process.ppid,
    hostname: hostname(),
    cwd: process.cwd(),
  };
  if (typeof process.getuid === "function") owner.uid = process.getuid();
  try {
    owner.user = userInfo().username;
  } catch {
    // userInfo can fail in restricted environments; the PID file remains useful.
  }
  return owner;
}

function writePidFile(port: number, instanceId: string): void {
  const pidFile = resolveActiveBridgePidFile();
  const now = new Date().toISOString();
  const session = resolveSessionName();
  mkdirSync(dirname(pidFile), { recursive: true });
  replacePidFileAtomically(pidFile, {
    pid: process.pid,
    port,
    session,
    instanceId,
    startedAt: now,
    lastActivityAt: now,
    owner: resolveOwnerMetadata(),
  });
}

let pidFileWriteSequence = 0;

export function replacePidFileAtomically(
  pidFile: string,
  data: Record<string, unknown>,
): void {
  withPidFileLock(pidFile, () => {
    const temporaryFile = `${pidFile}.${process.pid}.${pidFileWriteSequence++}.tmp`;
    try {
      writeFileSync(temporaryFile, JSON.stringify(data));
      renameSync(temporaryFile, pidFile);
    } catch (error) {
      try {
        unlinkSync(temporaryFile);
      } catch {}
      throw error;
    }
  });
}

function touchPidFileActivity(): void {
  const pidFile = resolveActiveBridgePidFile();
  try {
    const existing = JSON.parse(readFileSync(pidFile, "utf-8")) as Record<
      string,
      unknown
    >;
    if (existing.pid !== process.pid) return;
    replacePidFileAtomically(pidFile, {
      ...existing,
      lastActivityAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort observability only.
  }
}

/**
 * Remove the session PID file, but only when this process owns it. On a
 * same-session bind race the losing bridge exits via EADDRINUSE after the
 * winning bridge has already written the shared PID file; an unconditional
 * unlink would delete the still-running winner's handle and orphan it (later
 * `stop`/reuse can no longer find it). A missing, unreadable, or malformed
 * file — or one recording a different pid — is left untouched. `ownerPid` is
 * injectable for tests.
 */
export function removePidFile(
  pidFile: string = resolveActiveBridgePidFile(),
  ownerPid: number = process.pid,
): void {
  try {
    withPidFileLock(pidFile, () => {
      try {
        const data = JSON.parse(readFileSync(pidFile, "utf-8")) as {
          pid?: unknown;
        };
        if (data.pid !== ownerPid) return;
      } catch {
        return;
      }
      try {
        unlinkSync(pidFile);
      } catch {}
    });
  } catch {
    return;
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hostnames that identify the loopback interface. The bridge is a persistent
 * unauthenticated loopback service on a known port, so it is the target of
 * DNS-rebinding: a malicious page rebinds its own domain to 127.0.0.1 and the
 * browser then issues same-origin requests that hit the bridge. Binding to
 * 127.0.0.1 does NOT stop this - the packets still arrive on loopback. The one
 * thing a rebound request cannot hide is that it carries the attacker's own
 * domain in the `Host` (and `Origin`) header, and those are forbidden headers
 * page JavaScript cannot forge. Requiring both to name loopback is therefore
 * THE anti-rebinding control (see GHSA-x439-jhfh-v9x2).
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  // Node's URL parser keeps IPv6 hostnames bracketed (`[::1]`); strip the
  // brackets so the bare literal matches LOOPBACK_HOSTNAMES.
  const normalized = hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * Extract the hostname from a `Host` header value, dropping any `:port` suffix.
 * Handles bracketed IPv6 (`[::1]:9224` -> `::1`) and bare IPv6 literals
 * (`::1`). Returns null for an empty/whitespace-only value.
 */
export function extractHostHeaderHostname(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    // Anything after the closing bracket must be a `:port` suffix. Reject
    // trailing garbage (e.g. "[::1]evil.com") instead of treating it as the
    // loopback literal "::1" - this keeps the Host parser as strict as the
    // Origin path (new URL(...).hostname), which already rejects the analogue.
    const rest = trimmed.slice(end + 1);
    if (rest.length > 0 && !rest.startsWith(":")) return null;
    return trimmed.slice(1, end);
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed;
  // A second colon means this is a bare (unbracketed) IPv6 literal with no
  // port, not a host:port pair - keep the whole string as the hostname.
  if (trimmed.indexOf(":", firstColon + 1) !== -1) return trimmed;
  return trimmed.slice(0, firstColon);
}

/**
 * True when the `Host` header is present and names the loopback interface.
 * A missing Host, or one naming any other host (e.g. a rebound
 * `evil.attacker.com`), is rejected.
 */
export function isAllowedBridgeHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = extractHostHeaderHostname(host);
  if (hostname === null) return false;
  return isLoopbackHostname(hostname);
}

/**
 * True when the request carries no `Origin` (the CLI client sends none) or an
 * `Origin` whose hostname is loopback. A present-but-non-loopback or
 * unparseable Origin is rejected.
 */
export function isRequestOriginAllowed(req: IncomingMessage): boolean {
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return true;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin === undefined || origin.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

/**
 * Anti-rebinding gate: a request is allowed only when its `Host` header names
 * loopback and any `Origin` header also names loopback. Checked FIRST on every
 * route (health included) so a rebound request is refused before any CDP tool
 * can run.
 */
export function isRequestAllowed(req: IncomingMessage): boolean {
  return isAllowedBridgeHost(req.headers.host) && isRequestOriginAllowed(req);
}

export function extractToolText(content: BridgeContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function getToolContent(result: unknown): BridgeContentBlock[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return [];
  }
  return result.content as BridgeContentBlock[];
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: {
    name?: unknown;
    args?: unknown;
    routeSession?: unknown;
    routeIdleTimeoutMs?: unknown;
  };
  try {
    payload = JSON.parse(body) as { name?: unknown; args?: unknown };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  const routeIdleTimeoutMs =
    payload.routeIdleTimeoutMs === undefined
      ? undefined
      : parseIdleTimeout(payload.routeIdleTimeoutMs);
  if (payload.args === undefined) {
    return {
      name: payload.name,
      args: {},
      routeSession:
        typeof payload.routeSession === "string"
          ? payload.routeSession
          : undefined,
      routeIdleTimeoutMs,
    };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return {
    name: payload.name,
    args: payload.args as Record<string, unknown>,
    routeSession:
      typeof payload.routeSession === "string"
        ? payload.routeSession
        : undefined,
    routeIdleTimeoutMs,
  };
}

function parseIdleTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000) {
    throw new Error("Invalid idle timeout");
  }
  return value;
}

interface ParsedPage {
  id: number;
  url: string;
  selected: boolean;
}

function parsePagesList(text: string): ParsedPage[] {
  const pages: ParsedPage[] = [];
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

function textFromToolResult(result: unknown): string {
  return extractToolText(getToolContent(result));
}

type BridgeToolCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Serializes page-routed MCP calls within one bridge and restores the selected
 * page before each routed operation. chrome-devtools-mcp has one selected page
 * per MCP session, so routing must be bridge-local and serialized; the pool
 * size controls browser parallelism while text agents remain unconstrained.
 */
export class BrowserPageRouter {
  private readonly pagesByRouteSession = new Map<string, Set<number>>();
  private readonly activePageByRouteSession = new Map<string, number>();
  private readonly routeSessionByPage = new Map<number, string>();
  private readonly lastActivityByRouteSession = new Map<string, number>();
  private readonly activeRouteSessions = new Set<string>();
  private readonly idleTimeoutByRouteSession = new Map<string, number>();
  private readonly routeIdleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly routeIdleTimeoutMs = DEFAULT_ROUTE_IDLE_TIMEOUT_MS,
  ) {}

  async run(payload: BridgeCallPayload, call: BridgeToolCall): Promise<string> {
    const routeSession = payload.routeSession;
    if (!routeSession) {
      return call(payload.name, payload.args);
    }

    const run = this.queue.then(() =>
      this.runLocked(routeSession, payload, call),
    );
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private async runLocked(
    routeSession: string,
    payload: BridgeCallPayload,
    call: BridgeToolCall,
  ): Promise<string> {
    if (payload.name === "__axi_release_session") {
      return await this.releaseSession(routeSession, call, "explicit");
    }

    if (payload.name === "list_pages") {
      const pages = await this.listPages(call);
      this.forgetMissingPages(pages);
      this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
      return this.formatOwnedPages(routeSession, pages);
    }

    if (payload.name === AMBIENT_SNAPSHOT_TOOL) {
      return await this.snapshotOwnedPageIfPresent(routeSession, payload, call);
    }

    this.activeRouteSessions.add(routeSession);
    try {
      if (payload.name === "select_page") {
        const pageId = numericArg(payload.args.pageId);
        if (pageId === null) return await call(payload.name, payload.args);
        await this.requireOwnedPage(routeSession, pageId);
        const result = await call(payload.name, payload.args);
        this.activePageByRouteSession.set(routeSession, pageId);
        this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
        return result;
      }

      if (payload.name === "close_page") {
        const result = await this.closeOwnedPage(
          routeSession,
          payload.args,
          call,
        );
        this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
        return result;
      }

      if (payload.name === "new_page") {
        const result = await this.openOwnedPage(
          routeSession,
          payload.args,
          call,
        );
        this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
        return result;
      }

      const pagesBeforeCall = await this.ensureSessionPage(routeSession, call);
      let result: string;
      try {
        result = await call(payload.name, payload.args);
      } catch (error) {
        // A failed click/script can still have opened or closed a page. Reconcile
        // best-effort so route cleanup does not leak that side effect, while
        // preserving the original tool error for the caller.
        try {
          await this.reconcilePagesAfterCall(
            routeSession,
            pagesBeforeCall,
            call,
          );
        } catch {
          // The original MCP error is more useful than a follow-up list failure.
        }
        this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
        throw error;
      }
      await this.reconcilePagesAfterCall(routeSession, pagesBeforeCall, call);
      this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
      return result;
    } finally {
      this.activeRouteSessions.delete(routeSession);
    }
  }

  private async listPages(call: BridgeToolCall): Promise<ParsedPage[]> {
    return parsePagesList(await call("list_pages", {}));
  }

  private formatOwnedPages(routeSession: string, pages: ParsedPage[]): string {
    const owned = this.pagesByRouteSession.get(routeSession) ?? new Set();
    const activePageId = this.activePageByRouteSession.get(routeSession);
    return pages
      .filter((page) => owned.has(page.id))
      .map(
        (page) =>
          `${page.id}: ${page.url}${page.id === activePageId ? " [selected]" : ""}`,
      )
      .join("\n");
  }

  private rememberPage(
    routeSession: string,
    pageId: number,
    active: boolean,
  ): void {
    const previousOwner = this.routeSessionByPage.get(pageId);
    if (previousOwner && previousOwner !== routeSession) {
      this.pagesByRouteSession.get(previousOwner)?.delete(pageId);
      if (this.activePageByRouteSession.get(previousOwner) === pageId) {
        this.activePageByRouteSession.delete(previousOwner);
      }
    }
    let pages = this.pagesByRouteSession.get(routeSession);
    if (!pages) {
      pages = new Set();
      this.pagesByRouteSession.set(routeSession, pages);
    }
    pages.add(pageId);
    this.routeSessionByPage.set(pageId, routeSession);
    if (active) this.activePageByRouteSession.set(routeSession, pageId);
  }

  private async ensureSessionPage(
    routeSession: string,
    call: BridgeToolCall,
  ): Promise<ParsedPage[]> {
    let pages = await this.listPages(call);
    const ownedPages = this.pagesByRouteSession.get(routeSession) ?? new Set();
    const activePageId = this.activePageByRouteSession.get(routeSession);
    const existing =
      activePageId === undefined
        ? pages.find((page) => ownedPages.has(page.id))
        : pages.find((page) => page.id === activePageId);

    if (existing) {
      if (!existing.selected) {
        await call("select_page", { pageId: existing.id, bringToFront: false });
      }
      this.rememberPage(routeSession, existing.id, true);
      return pages;
    }

    this.forgetMissingPages(pages);

    await call("new_page", { url: "about:blank" });
    pages = await this.listPages(call);
    const target =
      pages.find((page) => page.selected) ??
      pages.reduce<ParsedPage | undefined>(
        (latest, page) => (!latest || page.id > latest.id ? page : latest),
        undefined,
      );

    if (!target) return pages;
    if (!target.selected) {
      await call("select_page", { pageId: target.id, bringToFront: false });
    }
    this.rememberPage(routeSession, target.id, true);
    return pages;
  }

  private async snapshotOwnedPageIfPresent(
    routeSession: string,
    payload: BridgeCallPayload,
    call: BridgeToolCall,
  ): Promise<string> {
    const pages = await this.listPages(call);
    this.forgetMissingPages(pages);
    const ownedPages = this.pagesByRouteSession.get(routeSession);
    const activePageId = this.activePageByRouteSession.get(routeSession);
    const target =
      activePageId === undefined
        ? pages.find((page) => ownedPages?.has(page.id))
        : pages.find(
            (page) => page.id === activePageId && ownedPages?.has(page.id),
          );
    if (!target) return "";
    if (!target.selected) {
      await call("select_page", { pageId: target.id, bringToFront: false });
    }
    this.rememberPage(routeSession, target.id, true);
    const result = await call("take_snapshot", payload.args);
    this.touchRoute(routeSession, call, payload.routeIdleTimeoutMs);
    return result;
  }

  /**
   * Claim pages created as a side effect of a routed tool call. Interactions
   * such as clicks and evaluated scripts can open a popup without going
   * through the explicit `new_page` tool; without this reconciliation those
   * pages have no route owner and survive both `stop` and route-idle cleanup.
   */
  private async reconcilePagesAfterCall(
    routeSession: string,
    before: ParsedPage[],
    call: BridgeToolCall,
  ): Promise<void> {
    const beforeIds = new Set(before.map((page) => page.id));
    const after = await this.listPages(call);
    this.forgetMissingPages(after);

    const created = after.filter((page) => !beforeIds.has(page.id));
    for (const page of created) {
      this.rememberPage(routeSession, page.id, page.selected);
    }

    const selected = after.find((page) => page.selected);
    if (selected && this.routeSessionByPage.get(selected.id) === routeSession) {
      this.activePageByRouteSession.set(routeSession, selected.id);
    }
  }

  private async openOwnedPage(
    routeSession: string,
    args: Record<string, unknown>,
    call: BridgeToolCall,
  ): Promise<string> {
    const before = await this.listPages(call);
    const beforeIds = new Set(before.map((page) => page.id));
    const previousActive = this.activePageByRouteSession.get(routeSession);
    const result = await call("new_page", args);
    const after = await this.listPages(call);
    const created = after.filter((page) => !beforeIds.has(page.id));

    for (const page of created) {
      this.rememberPage(routeSession, page.id, args.background !== true);
    }

    if (args.background === true) {
      if (previousActive !== undefined) {
        const previous = after.find((page) => page.id === previousActive);
        if (previous && !previous.selected) {
          await call("select_page", {
            pageId: previous.id,
            bringToFront: false,
          });
        }
        if (previous) {
          this.activePageByRouteSession.set(routeSession, previousActive);
        }
      }
    } else {
      const selected = created.find((page) => page.selected) ?? created.at(-1);
      if (selected) this.rememberPage(routeSession, selected.id, true);
    }

    return result;
  }

  private async closeOwnedPage(
    routeSession: string,
    args: Record<string, unknown>,
    call: BridgeToolCall,
  ): Promise<string> {
    const pageId = numericArg(args.pageId);
    if (pageId === null) return await call("close_page", args);
    await this.requireOwnedPage(routeSession, pageId);

    const pages = await this.listPages(call);
    const target = pages.find((page) => page.id === pageId);
    if (!target || pages.length <= 1) {
      return await call("close_page", args);
    }

    if (target.selected) {
      const survivor =
        pages.find(
          (page) =>
            page.id !== pageId &&
            this.routeSessionByPage.get(page.id) === routeSession,
        ) ?? pages.find((page) => page.id !== pageId);
      if (survivor) {
        await call("select_page", {
          pageId: survivor.id,
          bringToFront: false,
        });
      }
    }

    const result = await call("close_page", args);
    this.forgetPage(pageId);
    const ownedSurvivor = pages.find(
      (page) =>
        page.id !== pageId &&
        this.routeSessionByPage.get(page.id) === routeSession,
    );
    if (ownedSurvivor) {
      this.activePageByRouteSession.set(routeSession, ownedSurvivor.id);
    } else {
      this.activePageByRouteSession.delete(routeSession);
    }
    return result;
  }

  private async requireOwnedPage(
    routeSession: string,
    pageId: number,
  ): Promise<void> {
    if (this.routeSessionByPage.get(pageId) === routeSession) return;
    throw new Error(`Page ${pageId} is not owned by session "${routeSession}"`);
  }

  private async releaseSession(
    routeSession: string,
    call: BridgeToolCall,
    reason: "explicit" | "idle",
  ): Promise<string> {
    const owned = [...(this.pagesByRouteSession.get(routeSession) ?? [])];
    if (owned.length === 0) {
      this.clearRoute(routeSession);
      return `Released session "${routeSession}" (no page).`;
    }

    let closed = 0;
    let blanked = 0;
    for (const pageId of owned) {
      const pages = await this.listPages(call);
      const target = pages.find((page) => page.id === pageId);
      if (!target) {
        this.forgetPage(pageId);
        continue;
      }

      if (pages.length <= 1) {
        if (!target.selected) {
          await call("select_page", { pageId: target.id, bringToFront: false });
        }
        await call("navigate_page", { type: "url", url: "about:blank" });
        blanked++;
        this.forgetPage(pageId);
        continue;
      }

      if (target.selected) {
        const survivor =
          pages.find(
            (page) =>
              page.id !== pageId &&
              this.routeSessionByPage.get(page.id) !== routeSession,
          ) ?? pages.find((page) => page.id !== pageId);
        if (survivor) {
          await call("select_page", {
            pageId: survivor.id,
            bringToFront: false,
          });
        }
      }
      await call("close_page", { pageId });
      this.forgetPage(pageId);
      closed++;
    }

    this.clearRoute(routeSession);
    return `Released session "${routeSession}" (${reason}); closed ${closed}, blanked ${blanked}.`;
  }

  private touchRoute(
    routeSession: string,
    call: BridgeToolCall,
    idleTimeoutMs?: number,
  ): void {
    if (idleTimeoutMs !== undefined) {
      this.idleTimeoutByRouteSession.set(routeSession, idleTimeoutMs);
    } else {
      this.idleTimeoutByRouteSession.delete(routeSession);
    }
    this.lastActivityByRouteSession.set(routeSession, Date.now());
    this.armRouteIdleTimer(routeSession, call);
  }

  private armRouteIdleTimer(routeSession: string, call: BridgeToolCall): void {
    const existing = this.routeIdleTimers.get(routeSession);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        void this.enqueueIdleRelease(routeSession, call);
      },
      this.idleTimeoutByRouteSession.get(routeSession) ??
        this.routeIdleTimeoutMs,
    );
    timer.unref();
    this.routeIdleTimers.set(routeSession, timer);
  }

  private enqueueIdleRelease(
    routeSession: string,
    call: BridgeToolCall,
  ): Promise<void> {
    const run = this.queue.then(async () => {
      const lastActivity = this.lastActivityByRouteSession.get(routeSession);
      if (lastActivity === undefined) return;
      if (this.activeRouteSessions.has(routeSession)) {
        this.armRouteIdleTimer(routeSession, call);
        return;
      }
      const idleTimeoutMs =
        this.idleTimeoutByRouteSession.get(routeSession) ??
        this.routeIdleTimeoutMs;
      if (Date.now() - lastActivity < idleTimeoutMs) {
        this.armRouteIdleTimer(routeSession, call);
        return;
      }
      try {
        await this.releaseSession(routeSession, call, "idle");
      } catch {
        if (this.lastActivityByRouteSession.has(routeSession)) {
          this.armRouteIdleTimer(routeSession, call);
        }
      }
    });
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private forgetMissingPages(pages: ParsedPage[]): void {
    const live = new Set(pages.map((page) => page.id));
    for (const pageId of this.routeSessionByPage.keys()) {
      if (!live.has(pageId)) this.forgetPage(pageId);
    }
  }

  private forgetPage(pageId: number): void {
    const routeSession = this.routeSessionByPage.get(pageId);
    if (routeSession) {
      this.pagesByRouteSession.get(routeSession)?.delete(pageId);
      if (this.activePageByRouteSession.get(routeSession) === pageId) {
        this.activePageByRouteSession.delete(routeSession);
      }
    }
    this.routeSessionByPage.delete(pageId);
  }

  private clearRoute(routeSession: string): void {
    const timer = this.routeIdleTimers.get(routeSession);
    if (timer) clearTimeout(timer);
    this.routeIdleTimers.delete(routeSession);
    this.lastActivityByRouteSession.delete(routeSession);
    this.idleTimeoutByRouteSession.delete(routeSession);
    this.activePageByRouteSession.delete(routeSession);
    for (const pageId of this.pagesByRouteSession.get(routeSession) ?? []) {
      this.routeSessionByPage.delete(pageId);
    }
    this.pagesByRouteSession.delete(routeSession);
  }
}

function numericArg(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(
    importMetaDir,
    "../bin/chrome-devtools-axi-bridge.js",
  );
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }
  return body;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

async function handleToolsRequest(
  client: BridgeClient,
  res: ServerResponse,
): Promise<void> {
  const result = await client.listTools();
  writeJson(
    res,
    200,
    result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
}

async function handleCallRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  router?: BrowserPageRouter,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return textFromToolResult(result);
  };
  const result = router
    ? await router.run(payload, call)
    : await call(payload.name, payload.args);
  writeJson(res, 200, { result });
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  sessionName?: string,
  logForbidden?: (message: string) => void,
  router?: BrowserPageRouter,
  instanceId?: string,
  shutdown?: (reason?: string) => void | Promise<void>,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // Reject rebound requests before any routing - see isRequestAllowed and
  // GHSA-x439-jhfh-v9x2. This gate covers /health, /tools, and /call alike.
  if (!isRequestAllowed(req)) {
    // Log the refusal so an operator can tell a mis-configured client apart
    // from an actual rebinding attempt. Injected (not a direct
    // logBridgeMessage call) so unit tests stay quiet unless they opt in.
    const rawOrigin = req.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    logForbidden?.(
      `Rejected request with disallowed host: host=${req.headers.host ?? ""} ` +
        `origin=${origin ?? ""} ${req.method ?? ""} ${req.url ?? ""}`,
    );
    writeJson(res, 403, { error: "Forbidden host" });
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    if (instanceId === undefined || shutdown === undefined) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const payload = JSON.parse(await readRequestBody(req)) as {
        instanceId?: unknown;
      };
      if (payload.instanceId !== instanceId) {
        writeJson(res, 403, { error: "Bridge identity mismatch" });
        return;
      }
    } catch {
      writeJson(res, 400, { error: "Invalid shutdown request" });
      return;
    }
    writeJson(res, 202, { status: "shutting-down" });
    setImmediate(() => {
      void shutdown("Authenticated shutdown requested");
    });
    return;
  }

  if (
    req.method === "GET" &&
    (req.url === "/health" || req.url?.startsWith("/health?"))
  ) {
    const identity = {
      ...(sessionName === undefined ? {} : { session: sessionName }),
      ...(instanceId === undefined ? {} : { instanceId, pid: process.pid }),
    };
    if (!(await isBridgeClientConnected(client))) {
      writeJson(res, 503, {
        status: "error",
        error: "Not connected",
        ...identity,
      });
      return;
    }
    const deep = req.url.includes("deep=1");
    if (deep) {
      const probe = await isBridgeTargetReachable(client);
      if (!probe.ok) {
        writeJson(res, 503, {
          status: "error",
          error: "CDP target unreachable",
          reason: probe.reason,
          ...identity,
        });
        return;
      }
    }
    writeJson(res, 200, { status: "ok", ...identity });
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/tools") {
      await handleToolsRequest(client, res);
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      await handleCallRequest(client, req, res, router);
      return;
    }
  } catch (error) {
    writeJson(res, 500, { error: getErrorMessage(error) });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

export function createBridgeServer(
  client: BridgeClient,
  sessionName?: string,
  idleWatchdog?: BridgeIdleWatchdog,
  router?: BrowserPageRouter,
  instanceId?: string,
  shutdown?: (reason?: string) => void | Promise<void>,
): Server {
  return createServer((req, res) => {
    if (!isRequestAllowed(req)) {
      void handleBridgeRequest(
        client,
        req,
        res,
        sessionName,
        logBridgeMessage,
        router,
        instanceId,
        shutdown,
      );
      return;
    }
    if (!router && req.method === "POST" && req.url === "/call") {
      const requestedIdleTimeout = req.headers["x-axi-idle-timeout-ms"];
      const rawIdleTimeout = Array.isArray(requestedIdleTimeout)
        ? requestedIdleTimeout[0]
        : requestedIdleTimeout;
      if (rawIdleTimeout !== undefined) {
        const parsed = Number(rawIdleTimeout);
        if (Number.isInteger(parsed) && parsed >= 1000) {
          idleWatchdog?.setTimeoutMs(parsed);
        }
      }
    }
    touchPidFileActivity();
    const finishRequest = idleWatchdog?.beginRequest();
    void handleBridgeRequest(
      client,
      req,
      res,
      sessionName,
      logBridgeMessage,
      router,
      instanceId,
      shutdown,
    ).finally(() => {
      finishRequest?.();
    });
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[chrome-devtools-axi] ${message}\n`);
}

/**
 * Distinct exit code the bridge uses for an EADDRINUSE bind failure. A generic
 * non-zero exit is ambiguous (npx/MCP launch failures exit non-zero too), so
 * `ensureBridge` keys on this sentinel to attribute an early death to a genuine
 * port collision versus a startup failure and tailor its error accordingly.
 */
export const BRIDGE_PORT_IN_USE_EXIT_CODE = 48;

/**
 * Handle a fatal HTTP server error by logging it and exiting non-zero. An
 * EADDRINUSE means another bridge already owns this port (typically because
 * `CHROME_DEVTOOLS_AXI_PORT` was exported globally, forcing every session onto
 * one port); it exits with {@link BRIDGE_PORT_IN_USE_EXIT_CODE} so `ensureBridge`
 * can distinguish it from any other early death. Failing loudly prevents
 * `ensureBridge` from silently attaching to the other session's bridge. `exit`
 * is injectable for tests.
 */
export function handleBridgeServerError(
  error: NodeJS.ErrnoException,
  port: number,
  exit: (code: number) => void = process.exit,
): void {
  if (error.code === "EADDRINUSE") {
    logBridgeMessage(
      `Port ${port} is already in use (EADDRINUSE) - another bridge is listening there. ` +
        `Exporting CHROME_DEVTOOLS_AXI_PORT globally forces every session onto one port; ` +
        `unset it so each session gets its own, or set it only per-session.`,
    );
    exit(BRIDGE_PORT_IN_USE_EXIT_CODE);
    return;
  }
  logBridgeMessage(`Bridge server error: ${getErrorMessage(error)}`);
  exit(1);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

/**
 * Chrome flags that keep a browser *we* launch away from the machine owner's
 * login keychain.
 *
 * `--use-mock-keychain` makes Chromium's OSCrypt use an in-memory mock instead
 * of the real `Chrome Safe Storage` keychain item; `--password-store=basic`
 * keeps the password store off the platform secret service. Without them a
 * launched Chrome calls `SecItemAdd` against the login keychain, and if that
 * keychain is not resolvable for the browser process (for example because it
 * was spawned with a redirected `HOME`) macOS answers `errSecNoDefaultKeychain`
 * and raises the `system.keychain.create.loginkc` authorization panel -
 * "Keychain Not Found ... Reset To Defaults" - on the machine owner's screen.
 *
 * Puppeteer happens to pass both flags in its own default set today, so this is
 * currently belt-and-braces. It is stated explicitly because the isolation is a
 * property we owe our users, not one we want to silently inherit from an
 * upstream default that could change: an automation browser must never be able
 * to reach - or offer to reset - the owner's password store.
 */
export const KEYCHAIN_ISOLATION_CHROME_ARGS = [
  "--use-mock-keychain",
  "--password-store=basic",
] as const;

export const MCP_PACKAGE_NAME = "chrome-devtools-mcp";
export const MCP_PACKAGE_VERSION = "1.6.0";
export const MCP_PACKAGE_SPEC = `${MCP_PACKAGE_NAME}@${MCP_PACKAGE_VERSION}`;

const requireFromBridge = createRequire(import.meta.url);

export function validateBrowserPoolConnectionMode(
  poolSize = resolveBrowserPoolSize(),
  browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL,
  autoConnect = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1",
): void {
  if (poolSize !== null && (browserUrl || autoConnect)) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_POOL_SIZE cannot be combined with CHROME_DEVTOOLS_AXI_BROWSER_URL or CHROME_DEVTOOLS_AXI_AUTO_CONNECT because pooled page ownership cannot be recovered after an attached-browser bridge restart",
    );
  }
}

export function buildTransportArgs(): string[] {
  validateBrowserPoolConnectionMode();
  const args = ["-y", MCP_PACKAGE_SPEC];

  const autoConnect = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1";
  const browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  const userDataDir = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
  const channel = process.env.CHROME_DEVTOOLS_AXI_CHANNEL?.trim();

  if (autoConnect) {
    // Chrome 144+ built-in remote debugging via chrome://inspect/#remote-debugging.
    // Connects to the user's running Chrome - no separate browser launched.
    args.push("--autoConnect");
  } else if (browserUrl) {
    // Connect to an existing Chrome instance - skip --isolated and --headless
    // since the user manages the browser lifecycle externally.
    // ws://|wss:// route to --wsEndpoint (direct WebSocket), http(s):// to --browserUrl
    // (which fetches /json/version to discover the WebSocket URL).
    const isWs = /^wss?:\/\//i.test(browserUrl);
    if (isWs) {
      args.push(`--wsEndpoint=${browserUrl}`);
      const wsHeaders = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
      if (wsHeaders) {
        let parsedHeaders: unknown;
        try {
          parsedHeaders = JSON.parse(wsHeaders);
        } catch {
          throw new Error("CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON");
        }
        if (
          parsedHeaders === null ||
          typeof parsedHeaders !== "object" ||
          Array.isArray(parsedHeaders)
        ) {
          throw new Error(
            "CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object",
          );
        }
        args.push(`--wsHeaders=${wsHeaders}`);
      }
    } else {
      args.push(`--browserUrl=${browserUrl}`);
    }
  } else {
    if (userDataDir) {
      // Persistent profile — skip --isolated so the profile is preserved.
      args.push(`--userDataDir=${userDataDir}`);
    } else {
      args.push("--isolated");
    }
    if (process.env.CHROME_DEVTOOLS_AXI_HEADED !== "1") {
      args.push("--headless");
    }
    // Launch modes only: `--chrome-arg` is ignored when chrome-devtools-mcp
    // attaches to a browser somebody else started, and that browser's keychain
    // policy is its owner's to decide, not ours.
    for (const arg of KEYCHAIN_ISOLATION_CHROME_ARGS) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  // --channel selects which installed Chrome distribution chrome-devtools-mcp
  // targets: the running instance --autoConnect attaches to, or the one launched
  // by default. It is irrelevant when attaching to an explicit endpoint, so it is
  // omitted in BROWSER_URL/wsEndpoint mode. Validation is left to chrome-devtools-mcp.
  if (channel && !browserUrl) {
    args.push(`--channel=${channel}`);
  }

  const extraChromeArgs = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
  if (extraChromeArgs) {
    for (const arg of extraChromeArgs.trim().split(/\s+/)) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  return args;
}

/**
 * Probe interface for {@link detectGlobalMcpPath}. Defaults to real `node:fs`
 * + `npm prefix -g`; injectable for tests.
 */
export interface McpPathProbe {
  existsSync: (path: string) => boolean;
  getNpmPrefix: () => string | null;
  readFileSync: (path: string) => string;
  resolvePackageJson: (packageName: string) => string | null;
}

const DEFAULT_MCP_PATH_PROBE: McpPathProbe = {
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path, "utf8"),
  resolvePackageJson: (packageName) => {
    try {
      return requireFromBridge.resolve(`${packageName}/package.json`);
    } catch {
      return null;
    }
  },
  getNpmPrefix: () => {
    try {
      return execSync("npm prefix -g", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
};

function getPackageBinPath(manifest: unknown, binName: string): string | null {
  if (manifest === null || typeof manifest !== "object") return null;
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === "string") return bin;
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    return null;
  }
  const binPath = (bin as Record<string, unknown>)[binName];
  return typeof binPath === "string" ? binPath : null;
}

/**
 * Resolve the chrome-devtools-mcp binary from chrome-devtools-axi's own
 * dependency graph. Published chrome-devtools-axi installs ship this pinned
 * dependency, so normal bridge startup can spawn `node <local mcp bin>`
 * directly without a per-session npm/npx resolution step.
 */
export function detectPackagedMcpPath(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): string | null {
  const packageJsonPath = probe.resolvePackageJson(MCP_PACKAGE_NAME);
  if (!packageJsonPath) return null;

  let manifest: unknown;
  try {
    manifest = JSON.parse(probe.readFileSync(packageJsonPath));
  } catch {
    return null;
  }

  const binPath = getPackageBinPath(manifest, MCP_PACKAGE_NAME);
  if (!binPath) return null;

  const candidate = resolve(dirname(packageJsonPath), binPath);
  return probe.existsSync(candidate) ? candidate : null;
}

/**
 * Auto-detect a globally-installed chrome-devtools-mcp by probing
 * `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *
 * Returns the resolved path on success, or null if npm is unavailable or the
 * package isn't installed. This is a compatibility fallback for damaged or
 * partial installs; normal packaged installs use {@link detectPackagedMcpPath}
 * first so the MCP server version stays pinned to chrome-devtools-axi.
 */
export function detectGlobalMcpPath(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): string | null {
  const prefix = probe.getNpmPrefix();
  if (!prefix || prefix.length === 0) return null;
  const candidate = join(
    prefix,
    "lib",
    "node_modules",
    MCP_PACKAGE_NAME,
    "build",
    "src",
    "bin",
    "chrome-devtools-mcp.js",
  );
  return probe.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the command + args used to spawn the chrome-devtools-mcp transport.
 *
 * Resolution order (most → least specific):
 *   1. `CHROME_DEVTOOLS_AXI_MCP_PATH` env var — explicit override, always wins.
 *   2. Package-owned `chrome-devtools-mcp` dependency pinned by chrome-devtools-axi.
 *      This is the normal install path and avoids per-session npm/npx bootstrap.
 *   3. Auto-detect: probe a globally-installed `chrome-devtools-mcp` via
 *      `$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`.
 *      If found, spawn `node <path>` directly.
 *   4. Fall back to `npx -y chrome-devtools-mcp@<pinned version>` for source
 *      checkouts or broken installs where the package dependency is unavailable.
 */
export function resolveTransportSpec(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): { command: string; args: string[] } {
  const mcpArgs = buildTransportArgs();
  const explicit = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  const mcpPath =
    explicit && explicit.length > 0
      ? explicit
      : (detectPackagedMcpPath(probe) ?? detectGlobalMcpPath(probe));
  if (mcpPath) {
    // Strip the npx prefix `["-y", MCP_PACKAGE_SPEC]` — direct
    // node spawn doesn't need it.
    return {
      command: process.execPath,
      args: [mcpPath, ...mcpArgs.slice(2)],
    };
  }
  return { command: "npx", args: mcpArgs };
}

function createTransport(): StdioClientTransport {
  return new StdioClientTransport(resolveTransportSpec());
}

function createBridgeClient(): Client {
  return new Client({ name: "chrome-devtools-axi-bridge", version: "1.0.0" });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function closeBridgeResources(
  server: Server,
  client: BridgeClient,
  transport: { close(): Promise<void> },
): Promise<void> {
  const serverClosed = closeServer(server);
  server.closeAllConnections();
  let closeError: unknown;
  try {
    await client.close();
  } catch (error) {
    closeError = error;
  }
  try {
    await transport.close();
  } catch (error) {
    closeError ??= error;
  }
  try {
    await serverClosed;
  } catch (error) {
    closeError ??= error;
  }
  if (closeError !== undefined) throw closeError;
}

interface ProcessTreeReaperOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  taskkill?: (
    file: string,
    args: string[],
    options: { timeout: number; stdio: "ignore" },
  ) => unknown;
}

export function reapOwnedBridgeProcessTree(
  opts: ProcessTreeReaperOptions = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  const pid = opts.pid ?? process.pid;
  const kill = opts.kill ?? process.kill.bind(process);
  if (platform === "win32") {
    try {
      const taskkill =
        opts.taskkill ??
        ((
          file: string,
          args: string[],
          options: { timeout: number; stdio: "ignore" },
        ) => execFileSync(file, args, options));
      taskkill("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 5_000,
        stdio: "ignore",
      });
      return true;
    } catch {
      try {
        kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    kill(-pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function runBridge(port = resolveSessionPort()): Promise<void> {
  const poolSize = resolveBrowserPoolSize();
  const { bridgeIdleTimeoutMs: idleTimeoutMs, routeIdleTimeoutMs } =
    resolveBridgeLifecycleTimeouts(poolSize !== null);

  // Connect the MCP transport (which spawns chrome-devtools-mcp and launches
  // Chrome) before binding the port. A same-session bind race then self-heals:
  // both racers finish booting before listen(), so the loser's EADDRINUSE exit
  // finds the winner already deep-healthy and reuses it instead of failing. The
  // trade-off is one wasted Chrome launch on a genuine cross-session collision,
  // a rare and self-correcting path.
  const transport = createTransport();
  const client = createBridgeClient();
  await client.connect(transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  const sessionName = resolveSessionName();
  const instanceId = randomUUID();
  const router =
    poolSize === null
      ? undefined
      : new BrowserPageRouter(routeIdleTimeoutMs ?? idleTimeoutMs);
  let idleWatchdog: BridgeIdleWatchdog | undefined;
  const requestActivity: BridgeIdleWatchdog = {
    beginRequest: () => idleWatchdog?.beginRequest() ?? (() => {}),
    setTimeoutMs: (timeoutMs) => idleWatchdog?.setTimeoutMs(timeoutMs),
    stop: () => idleWatchdog?.stop(),
  };
  let shuttingDown = false;
  let server: Server;
  const shutdown = async (reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    idleWatchdog?.stop();
    if (reason) logBridgeMessage(reason);
    if (process.platform === "win32" && reapOwnedBridgeProcessTree()) {
      return;
    }
    try {
      await closeBridgeResources(server, client, transport);
    } catch (error) {
      logBridgeMessage(`Shutdown cleanup failed: ${getErrorMessage(error)}`);
    }
    removePidFile();
    process.exit(0);
  };

  server = createBridgeServer(
    client,
    sessionName,
    requestActivity,
    router,
    instanceId,
    shutdown,
  );
  server.on("error", (error: NodeJS.ErrnoException) => {
    handleBridgeServerError(error, port);
  });

  server.listen(port, "127.0.0.1", () => {
    writePidFile(port, instanceId);
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
    idleWatchdog = createBridgeIdleWatchdog(idleTimeoutMs, () =>
      shutdown(`Idle for ${idleTimeoutMs}ms; shutting down`),
    );
  });

  // Reap the process tree on exit so chrome-devtools-mcp children don't
  // survive as orphans. On POSIX, the detached bridge owns their process group.
  process.on("exit", () => {
    reapOwnedBridgeProcessTree();
    removePidFile();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
