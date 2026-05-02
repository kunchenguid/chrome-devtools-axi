import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BASE_PORT,
  DEFAULT_SESSION_NAME,
  defaultPortForSession,
  defaultUserDataDirForSession,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  validateSessionName,
} from "../src/sessions.js";

describe("resolveSessionName", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  });

  afterEach(() => {
    if (savedEnv.CHROME_DEVTOOLS_AXI_SESSION === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedEnv.CHROME_DEVTOOLS_AXI_SESSION;
    }
  });

  it('returns "default" when env is unset', () => {
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it('returns "default" when env is empty', () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "";
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it('returns "default" when env is whitespace', () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "   ";
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it("returns trimmed name", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "  widecorp-ceo  ";
    expect(resolveSessionName()).toBe("widecorp-ceo");
  });
});

describe("validateSessionName", () => {
  it('accepts "default"', () => {
    expect(() => validateSessionName(DEFAULT_SESSION_NAME)).not.toThrow();
  });

  it("accepts safe names", () => {
    expect(() => validateSessionName("widecorp-ceo")).not.toThrow();
    expect(() => validateSessionName("deb.admin")).not.toThrow();
    expect(() => validateSessionName("user_1")).not.toThrow();
    expect(() => validateSessionName("a1b2c3")).not.toThrow();
  });

  it("rejects path-traversal attempts", () => {
    expect(() => validateSessionName("../foo")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("a/b")).toThrow(/Invalid session name/);
  });

  it("rejects empty and overlong names", () => {
    expect(() => validateSessionName("")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("x".repeat(65))).toThrow(/Invalid session name/);
  });

  it("rejects shell metachars and spaces", () => {
    expect(() => validateSessionName("foo bar")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("foo;bar")).toThrow(/Invalid session name/);
    expect(() => validateSessionName("foo$bar")).toThrow(/Invalid session name/);
  });
});

describe("defaultPortForSession", () => {
  it("returns base port (9224) for default session", () => {
    expect(defaultPortForSession(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("returns same port for same name (deterministic)", () => {
    expect(defaultPortForSession("widecorp-ceo")).toBe(
      defaultPortForSession("widecorp-ceo"),
    );
  });

  it("returns a port within the named-session range (9225..9324)", () => {
    const port = defaultPortForSession("anyname");
    expect(port).toBeGreaterThanOrEqual(DEFAULT_BASE_PORT + 1);
    expect(port).toBeLessThanOrEqual(DEFAULT_BASE_PORT + 100);
  });

  it("typically gives different ports for different names", () => {
    // Deterministic hash-based allocation. Collisions in [9225..9324] are
    // possible but rare for short distinct strings.
    const a = defaultPortForSession("alice");
    const b = defaultPortForSession("bob");
    const c = defaultPortForSession("charlie");
    const ports = new Set([a, b, c]);
    expect(ports.size).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveSessionPort", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_PORT = process.env.CHROME_DEVTOOLS_AXI_PORT;
    savedEnv.CHROME_DEVTOOLS_AXI_SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses session-derived port when no explicit port", () => {
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("honors CHROME_DEVTOOLS_AXI_PORT", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "9999";
    expect(resolveSessionPort("anysession")).toBe(9999);
  });

  it("ignores invalid CHROME_DEVTOOLS_AXI_PORT", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "notanumber";
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("ignores zero/negative CHROME_DEVTOOLS_AXI_PORT", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "0";
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });
});

describe("resolveSessionPidFile", () => {
  it("returns legacy path for default session (backward compat)", () => {
    expect(resolveSessionPidFile(DEFAULT_SESSION_NAME)).toBe(
      join(homedir(), ".chrome-devtools-axi", "bridge.pid"),
    );
  });

  it("returns session-scoped path for named sessions", () => {
    expect(resolveSessionPidFile("widecorp-ceo")).toBe(
      join(homedir(), ".chrome-devtools-axi", "sessions", "widecorp-ceo", "bridge.pid"),
    );
  });
});

describe("defaultUserDataDirForSession", () => {
  it("returns null for default session (preserves --isolated)", () => {
    expect(defaultUserDataDirForSession(DEFAULT_SESSION_NAME)).toBeNull();
  });

  it("returns a per-session profile path for named sessions", () => {
    expect(defaultUserDataDirForSession("deb-admin")).toBe(
      join(homedir(), ".cache/chrome-devtools-axi/sessions", "deb-admin"),
    );
  });
});
