import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMBIENT_SNAPSHOT_TOOL,
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  BrowserPageRouter,
  DEFAULT_BRIDGE_IDLE_TIMEOUT_MS,
  DEFAULT_ROUTE_IDLE_TIMEOUT_MS,
  buildTransportArgs,
  closeBridgeResources,
  createBridgeIdleWatchdog,
  createBridgeServer,
  detectGlobalMcpPath,
  detectPackagedMcpPath,
  extractHostHeaderHostname,
  extractToolText,
  getErrorMessage,
  handleBridgeRequest,
  isAllowedBridgeHost,
  isRequestAllowed,
  isRequestOriginAllowed,
  handleBridgeServerError,
  isBridgeClientConnected,
  isBridgeTargetReachable,
  parseBridgeCallPayload,
  reapOwnedBridgeProcessTree,
  replacePidFileAtomically,
  removePidFile,
  resolveBridgeIdleTimeoutMs,
  resolveBridgeLifecycleTimeouts,
  resolvePhysicalBridgeIdleTimeoutMs,
  resolveBridgeScript,
  resolveRouteIdleTimeoutMs,
  resolveTransportSpec,
  shutdownOwnedWindowsBridgeProcessTree,
  MCP_PACKAGE_SPEC,
  type BridgeClient,
  type McpPathProbe,
} from "../src/bridge.js";

describe("bridge shutdown lifecycle", () => {
  it("stops accepting connections before closing MCP resources", async () => {
    const actions: string[] = [];
    let closed: (() => void) | undefined;
    const server = {
      close(callback: () => void) {
        actions.push("server-close");
        closed = callback;
        return server;
      },
      closeAllConnections() {
        actions.push("connections-close");
        closed?.();
      },
    } as unknown as Server;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {
        actions.push("client-close");
      },
    };
    const transport = {
      close: async () => {
        actions.push("transport-close");
      },
    };

    await closeBridgeResources(server, client, transport);

    expect(actions).toEqual([
      "server-close",
      "connections-close",
      "client-close",
      "transport-close",
    ]);
  });

  it("uses taskkill for a self-owned Windows process tree", () => {
    const taskkill = vi.fn();
    const kill = vi.fn();

    reapOwnedBridgeProcessTree({
      platform: "win32",
      pid: 4321,
      taskkill,
      kill,
    });

    expect(taskkill).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { timeout: 5000, stdio: "ignore" },
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("removes the owned PID identity before Windows tree termination", () => {
    const actions: string[] = [];

    const reaped = shutdownOwnedWindowsBridgeProcessTree({
      removePidIdentity: () => actions.push("pid-identity-removed"),
      reapProcessTree: () => {
        actions.push("process-tree-reaped");
        return true;
      },
    });

    expect(reaped).toBe(true);
    expect(actions).toEqual(["pid-identity-removed", "process-tree-reaped"]);
  });
});

function makeMcpPathProbe(overrides: Partial<McpPathProbe> = {}): McpPathProbe {
  return {
    existsSync: () => false,
    getNpmPrefix: () => null,
    readFileSync: () => "",
    resolvePackageJson: () => null,
    ...overrides,
  };
}

describe("bridge idle lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to a 30-minute idle window and validates overrides", () => {
    expect(resolveBridgeIdleTimeoutMs("")).toBe(DEFAULT_BRIDGE_IDLE_TIMEOUT_MS);
    expect(resolveBridgeIdleTimeoutMs("60000")).toBe(60_000);
    expect(() => resolveBridgeIdleTimeoutMs("999")).toThrow(/integer >= 1000/);
    expect(() => resolveBridgeIdleTimeoutMs("nope")).toThrow(/integer >= 1000/);
  });

  it("defaults route idle release to the bridge idle window and validates overrides", () => {
    expect(resolveRouteIdleTimeoutMs("", DEFAULT_ROUTE_IDLE_TIMEOUT_MS)).toBe(
      DEFAULT_ROUTE_IDLE_TIMEOUT_MS,
    );
    expect(resolveRouteIdleTimeoutMs("60000")).toBe(60_000);
    expect(() => resolveRouteIdleTimeoutMs("999")).toThrow(/integer >= 1000/);
    expect(() => resolveRouteIdleTimeoutMs("nope")).toThrow(/integer >= 1000/);
  });

  it("keeps a pooled bridge deadline independent from a caller policy", () => {
    expect(resolvePhysicalBridgeIdleTimeoutMs(true, "120000")).toBe(
      DEFAULT_BRIDGE_IDLE_TIMEOUT_MS,
    );
    expect(resolvePhysicalBridgeIdleTimeoutMs(false, "120000")).toBe(120_000);
  });

  it("keeps pooled physical and fallback route deadlines independent from caller env", () => {
    expect(resolveBridgeLifecycleTimeouts(true, "120000")).toEqual({
      bridgeIdleTimeoutMs: DEFAULT_BRIDGE_IDLE_TIMEOUT_MS,
      routeIdleTimeoutMs: DEFAULT_BRIDGE_IDLE_TIMEOUT_MS,
    });
  });

  it("does not inherit a caller bridge env when route idle is unset", () => {
    const savedBridgeIdle = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    const savedRouteIdle =
      process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS;
    try {
      process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = "120000";
      delete process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS;

      expect(resolveRouteIdleTimeoutMs()).toBe(DEFAULT_ROUTE_IDLE_TIMEOUT_MS);
    } finally {
      if (savedBridgeIdle === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = savedBridgeIdle;
      }
      if (savedRouteIdle === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_ROUTE_IDLE_TIMEOUT_MS = savedRouteIdle;
      }
    }
  });

  it("shuts down after inactivity but never during an active request", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watchdog = createBridgeIdleWatchdog(1000, onIdle);

    const finishRequest = watchdog.beginRequest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onIdle).not.toHaveBeenCalled();

    finishRequest();
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("resets the idle window after every completed request", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watchdog = createBridgeIdleWatchdog(1000, onIdle);

    await vi.advanceTimersByTimeAsync(900);
    watchdog.beginRequest()();
    await vi.advanceTimersByTimeAsync(900);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("updates the idle window for a later agent request", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watchdog = createBridgeIdleWatchdog(10_000, onIdle);

    watchdog.setTimeoutMs(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("tracks each HTTP request through the server lifecycle", async () => {
    let starts = 0;
    let finishes = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const server = createBridgeServer(client, "idle-test", {
      beginRequest: () => {
        starts++;
        return () => {
          finishes++;
        };
      },
      setTimeoutMs: () => {},
      stop: () => {},
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(starts).toBe(1);
      expect(finishes).toBe(1);

      const forbidden = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { Origin: "https://attacker.example" },
      });
      expect(forbidden.status).toBe(403);
      expect(starts).toBe(1);
      expect(finishes).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps health and pooled route policies out of the bridge watchdog", async () => {
    const setTimeoutMs = vi.fn();
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const server = createBridgeServer(
      client,
      "pool-0",
      {
        beginRequest: () => () => {},
        setTimeoutMs,
        stop: () => {},
      },
      new BrowserPageRouter(),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP address");
      }
      const url = `http://127.0.0.1:${address.port}`;
      await fetch(`${url}/health`, {
        headers: { "X-Axi-Idle-Timeout-Ms": "1000" },
      });
      await fetch(`${url}/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Axi-Idle-Timeout-Ms": "1000",
        },
        body: JSON.stringify({
          name: "list_pages",
          args: {},
          routeSession: "worker-a",
          routeIdleTimeoutMs: 1000,
        }),
      });

      expect(setTimeoutMs).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("extractToolText", () => {
  it("joins text blocks and ignores non-text content", () => {
    const result = extractToolText([
      { type: "text", text: "first" },
      { type: "image" },
      { type: "text", text: "second" },
    ]);

    expect(result).toBe("first\nsecond");
  });
});

describe("parseBridgeCallPayload", () => {
  it("defaults missing args to an empty object", () => {
    const result = parseBridgeCallPayload('{"name":"take_snapshot"}');

    expect(result).toEqual({ name: "take_snapshot", args: {} });
  });

  it("accepts an optional logical route session", () => {
    const result = parseBridgeCallPayload(
      '{"name":"take_snapshot","args":{},"routeSession":"worker-1"}',
    );

    expect(result).toEqual({
      name: "take_snapshot",
      args: {},
      routeSession: "worker-1",
    });
  });

  it("rejects payloads without a tool name", () => {
    expect(() => parseBridgeCallPayload('{"args":{}}')).toThrow(
      "Invalid bridge request payload",
    );
  });

  it("normalizes malformed JSON into a validation error", () => {
    expect(() => parseBridgeCallPayload("{")).toThrow(
      "Invalid bridge request payload",
    );
  });
});

describe("BrowserPageRouter", () => {
  class FakeMcpPages {
    pages = [{ id: 0, url: "about:blank", selected: true }];
    calls: { name: string; args: Record<string, unknown> }[] = [];

    async call(name: string, args: Record<string, unknown>): Promise<string> {
      this.calls.push({ name, args });
      if (name === "list_pages") {
        return this.pages
          .map(
            (page) =>
              `${page.id}: ${page.url}${page.selected ? " [selected]" : ""}`,
          )
          .join("\n");
      }
      if (name === "select_page") {
        const pageId = args.pageId as number;
        this.pages = this.pages.map((page) => ({
          ...page,
          selected: page.id === pageId,
        }));
        return "";
      }
      if (name === "new_page") {
        const nextId = Math.max(...this.pages.map((page) => page.id)) + 1;
        const background = args.background === true;
        this.pages = this.pages.map((page) => ({
          ...page,
          selected: background ? page.selected : false,
        }));
        this.pages.push({
          id: nextId,
          url: String(args.url),
          selected: !background,
        });
        return "";
      }
      if (name === "navigate_page") {
        const selected = this.pages.find((page) => page.selected);
        if (selected) selected.url = String(args.url);
        return "";
      }
      if (name === "evaluate_script") {
        throw new Error("router must not use page-visible ownership markers");
      }
      if (name === "close_page") {
        const pageId = args.pageId as number;
        this.pages = this.pages.filter((page) => page.id !== pageId);
        if (!this.pages.some((page) => page.selected) && this.pages[0]) {
          this.pages[0].selected = true;
        }
        return "";
      }
      if (name === "take_snapshot") {
        return `snapshot:${this.pages.find((page) => page.selected)?.id}`;
      }
      return "";
    }
  }

  it("routes different logical sessions to different pages in one bridge", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://b.example/" },
        routeSession: "worker-b",
      },
      (name, args) => fake.call(name, args),
    );
    const snapshotA = await router.run(
      { name: "take_snapshot", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(snapshotA).toBe("snapshot:1");
    expect(fake.pages).toEqual([
      { id: 0, url: "about:blank", selected: false },
      { id: 1, url: "https://a.example/", selected: true },
      { id: 2, url: "https://b.example/", selected: false },
    ]);
  });

  it("returns no ambient snapshot without creating an owned page", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    const snapshot = await router.run(
      {
        name: AMBIENT_SNAPSHOT_TOOL,
        args: {},
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );

    expect(snapshot).toBe("");
    expect(fake.pages).toEqual([{ id: 0, url: "about:blank", selected: true }]);
    expect(fake.calls.map((call) => call.name)).toEqual(["list_pages"]);
  });

  it("lists only pages owned by the requesting route", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://b.example/" },
        routeSession: "worker-b",
      },
      (name, args) => fake.call(name, args),
    );

    const pagesA = await router.run(
      { name: "list_pages", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(pagesA).toContain("1: https://a.example/ [selected]");
    expect(pagesA).not.toContain("https://b.example/");
  });

  it("selects a survivor before closing the selected page", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "new_page",
        args: { url: "https://a2.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      { name: "select_page", args: { pageId: 1 }, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );
    fake.calls = [];
    await router.run(
      { name: "close_page", args: { pageId: 1 }, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    const closeIndex = fake.calls.findIndex(
      (call) => call.name === "close_page",
    );
    const selectBeforeClose = fake.calls
      .slice(0, closeIndex)
      .some((call) => call.name === "select_page" && call.args.pageId === 2);
    expect(selectBeforeClose).toBe(true);
    expect(fake.pages).toEqual([
      { id: 0, url: "about:blank", selected: false },
      { id: 2, url: "https://a2.example/", selected: true },
    ]);
  });

  it("fails closed when a route selects or closes another route's page", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://b.example/" },
        routeSession: "worker-b",
      },
      (name, args) => fake.call(name, args),
    );

    await expect(
      router.run(
        { name: "select_page", args: { pageId: 0 }, routeSession: "worker-b" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
    await expect(
      router.run(
        { name: "close_page", args: { pageId: 0 }, routeSession: "worker-b" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
    expect(fake.pages.some((page) => page.id === 0)).toBe(true);
  });

  it("keeps background new pages owned without making them active", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "new_page",
        args: { url: "https://background.example/", background: true },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );

    const pages = await router.run(
      { name: "list_pages", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );
    const snapshot = await router.run(
      { name: "take_snapshot", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(pages).toContain("1: https://a.example/ [selected]");
    expect(pages).toContain("2: https://background.example/");
    expect(snapshot).toBe("snapshot:1");
  });

  it("does not claim another route's selected page for a first background page", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "new_page",
        args: { url: "https://background.example/", background: true },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );

    const owned = await router.run(
      { name: "list_pages", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );
    expect(owned).toBe("1: https://background.example/");

    await router.run(
      { name: "__axi_release_session", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );
    expect(fake.pages).toEqual([{ id: 0, url: "about:blank", selected: true }]);
  });

  it("owns and releases a popup opened as a side effect of a routed call", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();
    const callWithPopup = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      if (name === "click") {
        fake.calls.push({ name, args });
        fake.pages = fake.pages.map((page) => ({
          ...page,
          selected: false,
        }));
        fake.pages.push({
          id: 2,
          url: "https://popup.example/",
          selected: true,
        });
        return "";
      }
      return fake.call(name, args);
    };

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      callWithPopup,
    );
    await router.run(
      { name: "click", args: { uid: "button-1" }, routeSession: "worker-a" },
      callWithPopup,
    );

    const owned = await router.run(
      { name: "list_pages", args: {}, routeSession: "worker-a" },
      callWithPopup,
    );
    expect(owned).toContain("1: https://a.example/");
    expect(owned).toContain("2: https://popup.example/ [selected]");

    const released = await router.run(
      { name: "__axi_release_session", args: {}, routeSession: "worker-a" },
      callWithPopup,
    );
    expect(released).toContain("closed 2");
    expect(fake.pages).toEqual([{ id: 0, url: "about:blank", selected: true }]);
  });

  it("releases a routed session by closing its page when a survivor exists", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://b.example/" },
        routeSession: "worker-b",
      },
      (name, args) => fake.call(name, args),
    );

    const result = await router.run(
      { name: "__axi_release_session", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(result).toContain("closed 1");
    expect(fake.pages).toEqual([
      { id: 0, url: "about:blank", selected: false },
      { id: 2, url: "https://b.example/", selected: true },
    ]);
  });

  it("releases the last routed session by closing its page when an unowned baseline exists", async () => {
    const router = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await router.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://only.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );

    const result = await router.run(
      { name: "__axi_release_session", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(result).toContain("closed 1");
    expect(fake.pages).toEqual([{ id: 0, url: "about:blank", selected: true }]);
  });

  it("leaves existing pages unclaimed after bridge router restart", async () => {
    const firstRouter = new BrowserPageRouter();
    const fake = new FakeMcpPages();

    await firstRouter.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://a.example/" },
        routeSession: "worker-a",
      },
      (name, args) => fake.call(name, args),
    );
    await firstRouter.run(
      {
        name: "navigate_page",
        args: { type: "url", url: "https://b.example/" },
        routeSession: "worker-b",
      },
      (name, args) => fake.call(name, args),
    );

    const restartedRouter = new BrowserPageRouter();
    const pagesA = await restartedRouter.run(
      { name: "list_pages", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(pagesA).toBe("");
    await expect(
      restartedRouter.run(
        { name: "select_page", args: { pageId: 0 }, routeSession: "worker-a" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
    await expect(
      restartedRouter.run(
        { name: "close_page", args: { pageId: 0 }, routeSession: "worker-a" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
    await expect(
      restartedRouter.run(
        { name: "select_page", args: { pageId: 1 }, routeSession: "worker-b" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
    await expect(
      restartedRouter.run(
        { name: "close_page", args: { pageId: 1 }, routeSession: "worker-b" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);

    const snapshotA = await restartedRouter.run(
      { name: "take_snapshot", args: {}, routeSession: "worker-a" },
      (name, args) => fake.call(name, args),
    );

    expect(snapshotA).toBe("snapshot:3");
    expect(fake.pages).toEqual([
      { id: 0, url: "about:blank", selected: false },
      { id: 1, url: "https://a.example/", selected: false },
      { id: 2, url: "https://b.example/", selected: false },
      { id: 3, url: "about:blank", selected: true },
    ]);
    await expect(
      restartedRouter.run(
        { name: "close_page", args: { pageId: 0 }, routeSession: "worker-a" },
        (name, args) => fake.call(name, args),
      ),
    ).rejects.toThrow(/not owned/);
  });

  it("releases an idle route even while another route keeps the bridge alive", async () => {
    vi.useFakeTimers();
    try {
      const router = new BrowserPageRouter(1000);
      const fake = new FakeMcpPages();

      await router.run(
        {
          name: "navigate_page",
          args: { type: "url", url: "https://a.example/" },
          routeSession: "worker-a",
        },
        (name, args) => fake.call(name, args),
      );
      await router.run(
        {
          name: "navigate_page",
          args: { type: "url", url: "https://b.example/" },
          routeSession: "worker-b",
        },
        (name, args) => fake.call(name, args),
      );
      await vi.advanceTimersByTimeAsync(500);
      await router.run(
        { name: "take_snapshot", args: {}, routeSession: "worker-b" },
        (name, args) => fake.call(name, args),
      );
      await vi.advanceTimersByTimeAsync(600);

      expect(fake.pages).toEqual([
        { id: 0, url: "about:blank", selected: false },
        { id: 2, url: "https://b.example/", selected: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a request-specific idle timeout to an existing pooled route", async () => {
    vi.useFakeTimers();
    try {
      const router = new BrowserPageRouter(10_000);
      const fake = new FakeMcpPages();

      await router.run(
        {
          name: "navigate_page",
          args: { type: "url", url: "https://a.example/" },
          routeSession: "worker-a",
          routeIdleTimeoutMs: 1000,
        },
        (name, args) => fake.call(name, args),
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(fake.pages).toEqual([
        { id: 0, url: "about:blank", selected: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a route to its fallback timeout on a policy-free request", async () => {
    vi.useFakeTimers();
    try {
      const router = new BrowserPageRouter(1000);
      const fake = new FakeMcpPages();

      await router.run(
        {
          name: "navigate_page",
          args: { type: "url", url: "https://a.example/" },
          routeSession: "worker-a",
          routeIdleTimeoutMs: 10_000,
        },
        (name, args) => fake.call(name, args),
      );
      await vi.advanceTimersByTimeAsync(500);
      await router.run(
        { name: "take_snapshot", args: {}, routeSession: "worker-a" },
        (name, args) => fake.call(name, args),
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(fake.pages).toEqual([
        { id: 0, url: "about:blank", selected: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries idle release after a transient MCP failure", async () => {
    vi.useFakeTimers();
    try {
      const router = new BrowserPageRouter(1000);
      const fake = new FakeMcpPages();
      let closeFailures = 1;
      const flakyCall = async (
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        if (name === "close_page" && closeFailures-- > 0) {
          throw new Error("transient close failure");
        }
        return fake.call(name, args);
      };

      await router.run(
        {
          name: "navigate_page",
          args: { type: "url", url: "https://a.example/" },
          routeSession: "worker-a",
        },
        flakyCall,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(fake.pages.some((page) => page.id === 1)).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fake.pages).toEqual([
        { id: 0, url: "about:blank", selected: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getErrorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(getErrorMessage({ reason: "boom" })).toBe("[object Object]");
  });
});

describe("resolveBridgeScript", () => {
  it("prefers the TypeScript bridge entrypoint in the repo checkout", () => {
    expect(resolveBridgeScript(import.meta.dirname)).toMatch(
      /bin\/chrome-devtools-axi-bridge\.ts$/,
    );
  });
});

describe("buildTransportArgs", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED =
      process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    savedEnv.CHROME_DEVTOOLS_AXI_CHANNEL =
      process.env.CHROME_DEVTOOLS_AXI_CHANNEL;
    savedEnv.CHROME_DEVTOOLS_AXI_POOL_SIZE =
      process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    delete process.env.CHROME_DEVTOOLS_AXI_CHANNEL;
    delete process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE;
  });

  afterEach(() => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED =
      savedEnv.CHROME_DEVTOOLS_AXI_HEADED;
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL =
      savedEnv.CHROME_DEVTOOLS_AXI_CHANNEL;
    if (savedEnv.CHROME_DEVTOOLS_AXI_POOL_SIZE === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE =
        savedEnv.CHROME_DEVTOOLS_AXI_POOL_SIZE;
    }
  });

  it("defaults to headless and isolated", () => {
    const args = buildTransportArgs();
    expect(args).toEqual([
      "-y",
      MCP_PACKAGE_SPEC,
      "--isolated",
      "--headless",
      "--chrome-arg=--use-mock-keychain",
      "--chrome-arg=--password-store=basic",
    ]);
  });

  it("omits --headless when CHROME_DEVTOOLS_AXI_HEADED=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toEqual([
      "-y",
      MCP_PACKAGE_SPEC,
      "--isolated",
      "--chrome-arg=--use-mock-keychain",
      "--chrome-arg=--password-store=basic",
    ]);
  });

  it("forwards chrome args via --chrome-arg=", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      "--enable-gpu --ignore-gpu-blocklist";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--enable-gpu");
    expect(args).toContain("--chrome-arg=--ignore-gpu-blocklist");
  });

  it("handles tabs, newlines, and extra whitespace in chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS =
      "  --flag-a\t--flag-b\n--flag-c  ";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--flag-a");
    expect(args).toContain("--chrome-arg=--flag-b");
    expect(args).toContain("--chrome-arg=--flag-c");
    expect(
      args.filter(
        (a) =>
          a.startsWith("--chrome-arg=") && a.startsWith("--chrome-arg=--flag"),
      ),
    ).toHaveLength(3);
  });

  it("combines headed mode with chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--enable-unsafe-webgpu";
    const args = buildTransportArgs();
    expect(args).not.toContain("--headless");
    expect(args).toContain("--chrome-arg=--enable-unsafe-webgpu");
  });

  it("uses --browserUrl when CHROME_DEVTOOLS_AXI_BROWSER_URL is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("rejects pooled attachment to an externally managed browser", () => {
    process.env.CHROME_DEVTOOLS_AXI_POOL_SIZE = "2";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    expect(() => buildTransportArgs()).toThrow(/cannot be combined/);

    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    expect(() => buildTransportArgs()).toThrow(/cannot be combined/);
  });

  it("passes chrome args alongside --browserUrl", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--some-flag";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).toContain("--chrome-arg=--some-flag");
  });

  it("uses --userDataDir when CHROME_DEVTOOLS_AXI_USER_DATA_DIR is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--isolated");
    expect(args).toContain("--headless");
  });

  it("respects headed mode with --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--headless");
  });

  it("--browserUrl takes precedence over --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("uses --autoConnect when CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("--autoConnect takes precedence over --browserUrl and --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("ignores AUTO_CONNECT when not set to '1'", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "true";
    const args = buildTransportArgs();
    expect(args).not.toContain("--autoConnect");
    expect(args).toContain("--isolated");
  });

  it("omits --channel by default", () => {
    const args = buildTransportArgs();
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("appends --channel to --autoConnect", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).toContain("--channel=beta");
  });

  it("appends --channel in the default launch mode", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--channel=beta");
    expect(args).toContain("--isolated");
    expect(args).toContain("--headless");
  });

  it("appends --channel alongside --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "canary";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).toContain("--channel=canary");
  });

  it("ignores --channel when connecting via --browserUrl", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "beta";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("trims surrounding whitespace from the channel", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "  beta  ";
    const args = buildTransportArgs();
    expect(args).toContain("--channel=beta");
  });

  it("ignores a blank channel", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHANNEL = "   ";
    const args = buildTransportArgs();
    expect(args.some((a) => a.startsWith("--channel"))).toBe(false);
  });

  it("routes ws:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      "ws://127.0.0.1:9222/devtools/browser/abc123";
    const args = buildTransportArgs();
    expect(args).toContain(
      "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc123",
    );
    expect(args).not.toContain(
      "--browserUrl=ws://127.0.0.1:9222/devtools/browser/abc123",
    );
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("routes wss:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).not.toContain("--browserUrl=wss://our.cluster.io/launch");
  });

  it("passes --wsHeaders when CHROME_DEVTOOLS_AXI_WS_HEADERS is set with ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).toContain('--wsHeaders={"Authorization":"Bearer token"}');
  });

  it("rejects malformed ws headers before launching the transport", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = "{";

    expect(() => buildTransportArgs()).toThrow(
      "CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON",
    );
  });

  it("rejects ws headers JSON that is not an object", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '["Authorization: Bearer token"]';

    expect(() => buildTransportArgs()).toThrow(
      "CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object",
    );
  });

  it("ignores --wsHeaders without a ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS =
      '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--wsHeaders="))).toBe(false);
  });
});

describe("resolveTransportSpec", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_MCP_PATH =
      process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED =
      process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL =
      process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR =
      process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT =
      process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to the packaged chrome-devtools-mcp dependency", () => {
    const probe = makeMcpPathProbe({
      existsSync: (path) =>
        path === "/app/node_modules/chrome-devtools-mcp/bin.js",
      readFileSync: () =>
        JSON.stringify({ bin: { "chrome-devtools-mcp": "./bin.js" } }),
      resolvePackageJson: () =>
        "/app/node_modules/chrome-devtools-mcp/package.json",
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/app/node_modules/chrome-devtools-mcp/bin.js");
    expect(spec.args).not.toContain("-y");
    expect(spec.args).not.toContain(MCP_PACKAGE_SPEC);
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
  });

  it("falls back to spawning via pinned npx when package and auto-detection find nothing", () => {
    const probe = makeMcpPathProbe({
      getNpmPrefix: () => "/usr",
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
    expect(spec.args[0]).toBe("-y");
    expect(spec.args[1]).toBe(MCP_PACKAGE_SPEC);
    // Default mcp args follow
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
  });

  it("spawns node directly when CHROME_DEVTOOLS_AXI_MCP_PATH is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH =
      "/opt/mcp/build/src/bin/chrome-devtools-mcp.js";
    const spec = resolveTransportSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/opt/mcp/build/src/bin/chrome-devtools-mcp.js");
    // Strips the npx-only `-y, MCP_PACKAGE_SPEC` prefix
    expect(spec.args).not.toContain("-y");
    expect(spec.args).not.toContain(MCP_PACKAGE_SPEC);
    // Preserves the mcp-specific args
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
  });

  it("preserves --browserUrl when MCP_PATH and BROWSER_URL are both set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp.js";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    const spec = resolveTransportSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/opt/mcp.js");
    expect(spec.args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(spec.args).not.toContain("--isolated");
  });

  it("treats an empty MCP_PATH as unset", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "";
    const probe = makeMcpPathProbe({
      getNpmPrefix: () => null,
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
  });

  it("auto-detects a globally-installed chrome-devtools-mcp when the package dependency is unavailable", () => {
    const probe = makeMcpPathProbe({
      existsSync: (path: string) =>
        path ===
        "/usr/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      getNpmPrefix: () => "/usr",
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(
      "/usr/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    );
    expect(spec.args).not.toContain("-y");
    expect(spec.args).not.toContain(MCP_PACKAGE_SPEC);
    expect(spec.args).toContain("--isolated");
  });

  it("falls back to npx when auto-detection finds nothing", () => {
    const probe = makeMcpPathProbe({
      getNpmPrefix: () => "/usr",
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
    expect(spec.args[0]).toBe("-y");
  });

  it("falls back to npx when npm prefix is unavailable", () => {
    const probe = makeMcpPathProbe({
      existsSync: () => true, // would match anything if asked
      getNpmPrefix: () => null,
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe("npx");
  });

  it("explicit MCP_PATH always wins over auto-detection", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/explicit/override.js";
    const probe = makeMcpPathProbe({
      existsSync: () => true,
      getNpmPrefix: () => "/usr",
      readFileSync: () =>
        JSON.stringify({ bin: { "chrome-devtools-mcp": "./packaged.js" } }),
      resolvePackageJson: () =>
        "/app/node_modules/chrome-devtools-mcp/package.json",
    });
    const spec = resolveTransportSpec(probe);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe("/explicit/override.js");
  });
});

describe("detectPackagedMcpPath", () => {
  it("returns the package-owned MCP bin from package.json metadata", () => {
    const probe = makeMcpPathProbe({
      existsSync: (path: string) =>
        path === "/opt/app/node_modules/chrome-devtools-mcp/dist/mcp.js",
      readFileSync: () =>
        JSON.stringify({ bin: { "chrome-devtools-mcp": "./dist/mcp.js" } }),
      resolvePackageJson: () =>
        "/opt/app/node_modules/chrome-devtools-mcp/package.json",
    });

    expect(detectPackagedMcpPath(probe)).toBe(
      "/opt/app/node_modules/chrome-devtools-mcp/dist/mcp.js",
    );
  });

  it("returns null when the package dependency is missing", () => {
    expect(detectPackagedMcpPath(makeMcpPathProbe())).toBeNull();
  });

  it("returns null when package.json is invalid", () => {
    const probe = makeMcpPathProbe({
      readFileSync: () => "{",
      resolvePackageJson: () =>
        "/opt/app/node_modules/chrome-devtools-mcp/package.json",
    });

    expect(detectPackagedMcpPath(probe)).toBeNull();
  });

  it("returns null when the declared bin file is missing", () => {
    const probe = makeMcpPathProbe({
      existsSync: () => false,
      readFileSync: () =>
        JSON.stringify({ bin: { "chrome-devtools-mcp": "./dist/mcp.js" } }),
      resolvePackageJson: () =>
        "/opt/app/node_modules/chrome-devtools-mcp/package.json",
    });

    expect(detectPackagedMcpPath(probe)).toBeNull();
  });
});

describe("detectGlobalMcpPath", () => {
  it("returns the canonical MCP path when npm prefix + the file both exist", () => {
    const probe = makeMcpPathProbe({
      existsSync: (path: string) =>
        path ===
        "/opt/npm/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      getNpmPrefix: () => "/opt/npm",
    });

    expect(detectGlobalMcpPath(probe)).toBe(
      "/opt/npm/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    );
  });

  it("returns null when the file is missing", () => {
    const probe = makeMcpPathProbe({
      existsSync: () => false,
      getNpmPrefix: () => "/opt/npm",
    });

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });

  it("returns null when npm prefix is null (npm not installed)", () => {
    const probe = makeMcpPathProbe({
      existsSync: () => true,
      getNpmPrefix: () => null,
    });

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });

  it("returns null when npm prefix is the empty string", () => {
    const probe = makeMcpPathProbe({
      existsSync: () => true,
      getNpmPrefix: () => "",
    });

    expect(detectGlobalMcpPath(probe)).toBeNull();
  });
});

describe("bridge health", () => {
  it("reports disconnected clients as unhealthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(false);
  });

  it("reports connected clients as healthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(true);
  });
});

describe("isBridgeTargetReachable", () => {
  it("returns ok when list_pages succeeds", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }) => {
        expect(name).toBe("list_pages");
        return { content: [] };
      },
      close: async () => {},
    };

    const result = await isBridgeTargetReachable(client);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with reason when the CDP target is gone", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        throw new Error("Target closed");
      },
      close: async () => {},
    };

    const result = await isBridgeTargetReachable(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Target closed");
    }
  });
});

function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  // Real requests always carry a Host header; the CLI client sends
  // "127.0.0.1:<port>". Default to loopback so the anti-rebinding gate lets
  // these through, and let callers override to exercise rejection.
  req.headers = { host: "127.0.0.1:9224", ...headers };
  // Feed a request body so handlers that read the stream (e.g. /call) don't
  // hang waiting on EOF. Rejected requests short-circuit before reading it.
  if (body !== undefined) {
    req.push(body);
    req.push(null);
  }
  return req;
}

interface CapturedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

function makeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: "",
    headers: {},
  };
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | string[]) => {
    captured.headers[String(name).toLowerCase()] = String(value);
    return origSetHeader(name, value as string);
  }) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") captured.body += chunk;
    captured.statusCode = res.statusCode;
    return res;
  }) as typeof res.end;
  return { res, captured };
}

describe("handleBridgeRequest /health", () => {
  it("accepts shutdown only for the matching bridge instance", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const shutdown = vi.fn();
    const accepted = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/shutdown",
        {},
        JSON.stringify({ instanceId: "instance-1" }),
      ),
      accepted.res,
      "worker-1",
      undefined,
      undefined,
      "instance-1",
      shutdown,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(accepted.captured.statusCode).toBe(202);
    expect(shutdown).toHaveBeenCalledWith("Authenticated shutdown requested");

    shutdown.mockClear();
    const rejected = makeResponse();
    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/shutdown",
        {},
        JSON.stringify({ instanceId: "replacement-instance" }),
      ),
      rejected.res,
      "worker-1",
      undefined,
      undefined,
      "instance-1",
      shutdown,
    );

    expect(rejected.captured.statusCode).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("returns 200 ok for shallow /health when MCP is connected", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ status: "ok" });
  });

  it("stamps the session name into the /health response when provided", async () => {
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health"),
      res,
      "worker-1",
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({
      status: "ok",
      session: "worker-1",
    });
  });

  it("stamps bridge identity into healthy and unhealthy responses", async () => {
    const connected: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const healthy = makeResponse();

    await handleBridgeRequest(
      connected,
      makeRequest("GET", "/health"),
      healthy.res,
      "worker-1",
      undefined,
      undefined,
      "instance-1",
    );

    expect(JSON.parse(healthy.captured.body)).toMatchObject({
      status: "ok",
      session: "worker-1",
      instanceId: "instance-1",
      pid: process.pid,
    });

    const disconnected: BridgeClient = {
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    };
    const unhealthy = makeResponse();

    await handleBridgeRequest(
      disconnected,
      makeRequest("GET", "/health"),
      unhealthy.res,
      "worker-1",
      undefined,
      undefined,
      "instance-1",
    );

    expect(JSON.parse(unhealthy.captured.body)).toMatchObject({
      status: "error",
      session: "worker-1",
      instanceId: "instance-1",
      pid: process.pid,
    });
  });

  it("returns 503 when MCP server is disconnected", async () => {
    const client: BridgeClient = {
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(503);
    expect(JSON.parse(captured.body)).toMatchObject({ status: "error" });
  });

  it("returns 503 from /health?deep=1 when CDP target is unreachable", async () => {
    const client: BridgeClient = {
      // Shallow probe (listTools) passes — local MCP server is fine.
      listTools: async () => ({ tools: [] }),
      // Deep probe (list_pages) fails — attached browser is gone.
      callTool: async () => {
        throw new Error("Target closed");
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health?deep=1"),
      res,
    );

    expect(captured.statusCode).toBe(503);
    const body = JSON.parse(captured.body);
    expect(body.status).toBe("error");
    expect(body.error).toContain("CDP target unreachable");
    expect(body.reason).toContain("Target closed");
  });

  it("returns 200 from /health?deep=1 when both MCP and CDP target are healthy", async () => {
    let listPagesCalls = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async ({ name }) => {
        if (name === "list_pages") listPagesCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/health?deep=1"),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ status: "ok" });
    expect(listPagesCalls).toBe(1);
  });

  it("does not invoke the deep CDP probe on the shallow /health path", async () => {
    let callToolCalls = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callToolCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, makeRequest("GET", "/health"), res);

    expect(captured.statusCode).toBe(200);
    expect(callToolCalls).toBe(0);
  });
});

describe("extractHostHeaderHostname", () => {
  it("drops the :port suffix from a host:port value", () => {
    expect(extractHostHeaderHostname("127.0.0.1:9224")).toBe("127.0.0.1");
    expect(extractHostHeaderHostname("localhost:9224")).toBe("localhost");
  });

  it("returns the bare hostname when no port is present", () => {
    expect(extractHostHeaderHostname("localhost")).toBe("localhost");
  });

  it("unwraps a bracketed IPv6 host, with or without a port", () => {
    expect(extractHostHeaderHostname("[::1]:9224")).toBe("::1");
    expect(extractHostHeaderHostname("[::1]")).toBe("::1");
  });

  it("keeps a bare unbracketed IPv6 literal intact", () => {
    expect(extractHostHeaderHostname("::1")).toBe("::1");
  });

  it("rejects trailing garbage after a bracketed IPv6 host", () => {
    // "[::1]evil.com" must not be read as the loopback literal "::1".
    expect(extractHostHeaderHostname("[::1]evil.com")).toBeNull();
    expect(extractHostHeaderHostname("[::1]:9224evil")).toBe("::1");
    expect(isAllowedBridgeHost("[::1]evil.com")).toBe(false);
  });

  it("returns null for an empty or whitespace-only value", () => {
    expect(extractHostHeaderHostname("")).toBeNull();
    expect(extractHostHeaderHostname("   ")).toBeNull();
  });
});

describe("isAllowedBridgeHost", () => {
  it("accepts loopback hosts (with and without port, any case)", () => {
    expect(isAllowedBridgeHost("127.0.0.1:9224")).toBe(true);
    expect(isAllowedBridgeHost("localhost:9224")).toBe(true);
    expect(isAllowedBridgeHost("LOCALHOST")).toBe(true);
    expect(isAllowedBridgeHost("[::1]:9224")).toBe(true);
    expect(isAllowedBridgeHost("::1")).toBe(true);
  });

  it("rejects a missing Host header", () => {
    expect(isAllowedBridgeHost(undefined)).toBe(false);
  });

  it("rejects a rebound attacker domain", () => {
    expect(isAllowedBridgeHost("evil.attacker.com")).toBe(false);
    expect(isAllowedBridgeHost("evil.attacker.com:9224")).toBe(false);
    // A hostname that merely embeds a loopback label must not pass.
    expect(isAllowedBridgeHost("127.0.0.1.evil.com")).toBe(false);
    expect(isAllowedBridgeHost("localhost.evil.com")).toBe(false);
  });
});

describe("isRequestOriginAllowed", () => {
  it("allows a missing Origin (the CLI client sends none)", () => {
    expect(isRequestOriginAllowed(makeRequest("POST", "/call"))).toBe(true);
  });

  it("allows an Origin whose hostname is loopback", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://127.0.0.1:9224" }),
      ),
    ).toBe(true);
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://localhost" }),
      ),
    ).toBe(true);
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "http://[::1]:9224" }),
      ),
    ).toBe(true);
  });

  it("rejects a present non-loopback Origin", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", {
          origin: "https://evil.attacker.com",
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unparseable Origin", () => {
    expect(
      isRequestOriginAllowed(
        makeRequest("POST", "/call", { origin: "not a url" }),
      ),
    ).toBe(false);
  });
});

describe("handleBridgeRequest anti-rebinding gate", () => {
  const client: BridgeClient = {
    listTools: async () => ({ tools: [{ name: "take_snapshot" }] }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  };

  it("rejects a forged non-loopback Host with 403 on every route", async () => {
    for (const [method, url] of [
      ["GET", "/health"],
      ["GET", "/tools"],
      ["POST", "/call"],
    ] as const) {
      const { res, captured } = makeResponse();
      await handleBridgeRequest(
        client,
        makeRequest(method, url, { host: "evil.attacker.com" }),
        res,
      );
      expect(captured.statusCode).toBe(403);
      expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
    }
  });

  it("rejects a request with no Host header", async () => {
    const req = makeRequest("GET", "/health");
    delete req.headers.host;
    const { res, captured } = makeResponse();

    await handleBridgeRequest(client, req, res);

    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });

  it("rejects a forged non-loopback Origin even when Host is loopback", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("POST", "/call", {
        host: "127.0.0.1:9224",
        origin: "https://evil.attacker.com",
      }),
      res,
    );

    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Forbidden host" });
  });

  it("does not invoke any CDP tool when a request is rejected", async () => {
    let callToolCalls = 0;
    const spyClient: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callToolCalls++;
        return { content: [] };
      },
      close: async () => {},
    };
    const { res } = makeResponse();

    await handleBridgeRequest(
      spyClient,
      makeRequest("POST", "/call", { host: "evil.attacker.com" }),
      res,
    );

    expect(callToolCalls).toBe(0);
  });

  it("allows a loopback Host with no Origin through to /call", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest(
        "POST",
        "/call",
        { host: "127.0.0.1:9224" },
        JSON.stringify({ name: "take_snapshot" }),
      ),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ result: "ok" });
  });

  it("logs the refusal (host/origin/route) when a request is rejected", async () => {
    const logs: string[] = [];
    const { res } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("POST", "/call", {
        host: "evil.attacker.com",
        origin: "https://evil.attacker.com",
      }),
      res,
      undefined,
      (message) => logs.push(message),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("evil.attacker.com");
    expect(logs[0]).toContain("/call");
  });

  it("does not log when a request is allowed", async () => {
    const logs: string[] = [];
    const { res } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/tools", { host: "127.0.0.1:9224" }),
      res,
      undefined,
      (message) => logs.push(message),
    );

    expect(logs).toHaveLength(0);
  });

  it("allows a loopback Host + loopback Origin through to /tools", async () => {
    const { res, captured } = makeResponse();

    await handleBridgeRequest(
      client,
      makeRequest("GET", "/tools", {
        host: "localhost:9224",
        origin: "http://localhost:9224",
      }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(isRequestAllowed(makeRequest("GET", "/tools"))).toBe(true);
  });
});

describe("handleBridgeServerError", () => {
  function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { result: fn(), stderr };
    } finally {
      process.stderr.write = original;
    }
  }

  it("exits with the distinct EADDRINUSE code so ensureBridge can attribute a collision", () => {
    const exitCodes: number[] = [];
    const { stderr } = captureStderr(() =>
      handleBridgeServerError(
        Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
        9225,
        (code) => exitCodes.push(code),
      ),
    );

    expect(exitCodes).toEqual([BRIDGE_PORT_IN_USE_EXIT_CODE]);
    expect(BRIDGE_PORT_IN_USE_EXIT_CODE).not.toBe(1);
    expect(stderr).toContain("9225");
    expect(stderr).toContain("EADDRINUSE");
    expect(stderr).toContain("CHROME_DEVTOOLS_AXI_PORT");
  });

  it("exits non-zero for other fatal server errors", () => {
    const exitCodes: number[] = [];
    const { stderr } = captureStderr(() =>
      handleBridgeServerError(
        Object.assign(new Error("boom"), { code: "EACCES" }),
        9225,
        (code) => exitCodes.push(code),
      ),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr).toContain("boom");
  });
});

describe("removePidFile ownership", () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cda-pid-"));
    pidFile = join(dir, "bridge.pid");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces complete PID metadata without leaving a temporary file", () => {
    writeFileSync(pidFile, JSON.stringify({ pid: 1, port: 9224 }));

    replacePidFileAtomically(pidFile, {
      pid: 2,
      port: 9225,
      lastActivityAt: "2026-08-05T12:00:00.000Z",
    });

    expect(JSON.parse(readFileSync(pidFile, "utf-8"))).toEqual({
      pid: 2,
      port: 9225,
      lastActivityAt: "2026-08-05T12:00:00.000Z",
    });
    expect(readdirSync(dir)).toEqual(["bridge.pid"]);
  });

  it("leaves the winner's PID file intact when a same-session loser exits", () => {
    const winnerPid = process.pid + 1;
    const loserPid = process.pid + 2;
    writeFileSync(pidFile, JSON.stringify({ pid: winnerPid, port: 9224 }));

    // The EADDRINUSE loser's exit handler must not delete the winner's handle.
    removePidFile(pidFile, loserPid);

    expect(existsSync(pidFile)).toBe(true);
  });

  it("removes the PID file when this process owns it", () => {
    const ownerPid = process.pid + 3;
    writeFileSync(pidFile, JSON.stringify({ pid: ownerPid, port: 9224 }));

    removePidFile(pidFile, ownerPid);

    expect(existsSync(pidFile)).toBe(false);
  });

  it("treats a missing or malformed PID file as nothing to remove", () => {
    expect(() => removePidFile(pidFile, process.pid)).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, "not json");
    expect(() => removePidFile(pidFile, process.pid)).not.toThrow();
    expect(existsSync(pidFile)).toBe(true);
  });
});
