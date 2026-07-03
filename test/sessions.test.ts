import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BASE_PORT,
  DEFAULT_SESSION_NAME,
  defaultPortForSession,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  resolveSessionStateDir,
  resolveStateBaseDir,
  validateSessionName,
} from "../src/sessions.js";

const STATE_DIR = join(homedir(), ".chrome-devtools-axi");

describe("resolveSessionName", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CHROME_DEVTOOLS_AXI_SESSION = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  });

  afterEach(() => {
    if (saved.CHROME_DEVTOOLS_AXI_SESSION === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION =
        saved.CHROME_DEVTOOLS_AXI_SESSION;
    }
  });

  it('defaults to "default" when unset', () => {
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it('defaults to "default" when empty or whitespace', () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "   ";
    expect(resolveSessionName()).toBe(DEFAULT_SESSION_NAME);
  });

  it("trims the configured name", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "  worker-1  ";
    expect(resolveSessionName()).toBe("worker-1");
  });

  it("throws on a configured-but-unsafe name", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "../escape";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });

  it("throws on a dot-only name that would collapse onto the default dir", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => resolveSessionName()).toThrow(/Invalid/);
  });
});

describe("validateSessionName", () => {
  it('accepts "default" and safe names', () => {
    expect(() => validateSessionName(DEFAULT_SESSION_NAME)).not.toThrow();
    expect(() => validateSessionName("worker-1")).not.toThrow();
    expect(() => validateSessionName("ceo.admin_2")).not.toThrow();
  });

  it("rejects path traversal and separators", () => {
    expect(() => validateSessionName("../escape")).toThrow(/Invalid/);
    expect(() => validateSessionName("a/b")).toThrow(/Invalid/);
  });

  it("rejects dot-only names that would collapse onto the default dir", () => {
    expect(() => validateSessionName(".")).toThrow(/Invalid/);
    expect(() => validateSessionName("..")).toThrow(/Invalid/);
    expect(() => validateSessionName("...")).toThrow(/Invalid/);
  });

  it("rejects shell metacharacters and spaces", () => {
    expect(() => validateSessionName("a b")).toThrow(/Invalid/);
    expect(() => validateSessionName("a;b")).toThrow(/Invalid/);
    expect(() => validateSessionName("a$b")).toThrow(/Invalid/);
  });

  it("rejects empty and overlong names", () => {
    expect(() => validateSessionName("")).toThrow(/Invalid/);
    expect(() => validateSessionName("x".repeat(65))).toThrow(/Invalid/);
  });
});

describe("defaultPortForSession", () => {
  it("returns the base port for the default session", () => {
    expect(defaultPortForSession(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("is deterministic per name", () => {
    expect(defaultPortForSession("worker-1")).toBe(
      defaultPortForSession("worker-1"),
    );
  });

  it("stays within the named-session range (9225..10224)", () => {
    for (const name of ["a", "worker-1", "ceo", "x".repeat(64)]) {
      const port = defaultPortForSession(name);
      expect(port).toBeGreaterThanOrEqual(DEFAULT_BASE_PORT + 1);
      expect(port).toBeLessThanOrEqual(DEFAULT_BASE_PORT + 1000);
    }
  });

  it("spreads distinct names across ports", () => {
    const ports = new Set(["alice", "bob", "carol"].map(defaultPortForSession));
    expect(ports.size).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveSessionPort", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.CHROME_DEVTOOLS_AXI_PORT = process.env.CHROME_DEVTOOLS_AXI_PORT;
    delete process.env.CHROME_DEVTOOLS_AXI_PORT;
  });

  afterEach(() => {
    if (saved.CHROME_DEVTOOLS_AXI_PORT === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_PORT = saved.CHROME_DEVTOOLS_AXI_PORT;
    }
  });

  it("uses the session-derived port when no explicit override", () => {
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });

  it("honors an explicit CHROME_DEVTOOLS_AXI_PORT", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "9999";
    expect(resolveSessionPort("worker-1")).toBe(9999);
  });

  it("ignores a non-numeric or non-positive override", () => {
    process.env.CHROME_DEVTOOLS_AXI_PORT = "nope";
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
    process.env.CHROME_DEVTOOLS_AXI_PORT = "0";
    expect(resolveSessionPort(DEFAULT_SESSION_NAME)).toBe(DEFAULT_BASE_PORT);
  });
});

describe("session state paths", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;

  beforeEach(() => {
    delete process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = saved;
    }
  });

  it("keeps legacy paths for the default session", () => {
    expect(resolveSessionStateDir(DEFAULT_SESSION_NAME)).toBe(STATE_DIR);
    expect(resolveSessionPidFile(DEFAULT_SESSION_NAME)).toBe(
      join(STATE_DIR, "bridge.pid"),
    );
  });

  it("nests named sessions under sessions/<name>/", () => {
    expect(resolveSessionStateDir("worker-1")).toBe(
      join(STATE_DIR, "sessions", "worker-1"),
    );
    expect(resolveSessionPidFile("worker-1")).toBe(
      join(STATE_DIR, "sessions", "worker-1", "bridge.pid"),
    );
  });
});

describe("CHROME_DEVTOOLS_AXI_STATE_DIR override", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = saved;
    }
  });

  it("falls back to ~/.chrome-devtools-axi when unset", () => {
    delete process.env.CHROME_DEVTOOLS_AXI_STATE_DIR;
    expect(resolveStateBaseDir()).toBe(STATE_DIR);
    expect(resolveSessionStateDir(DEFAULT_SESSION_NAME)).toBe(STATE_DIR);
    expect(resolveSessionPidFile(DEFAULT_SESSION_NAME)).toBe(
      join(STATE_DIR, "bridge.pid"),
    );
  });

  it("overrides the base dir and pidfile for the default session", () => {
    process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = "/tmp/crew-7/cdaxi";
    expect(resolveStateBaseDir()).toBe("/tmp/crew-7/cdaxi");
    expect(resolveSessionStateDir(DEFAULT_SESSION_NAME)).toBe(
      "/tmp/crew-7/cdaxi",
    );
    expect(resolveSessionPidFile(DEFAULT_SESSION_NAME)).toBe(
      join("/tmp/crew-7/cdaxi", "bridge.pid"),
    );
  });

  it("nests named sessions under the overridden base", () => {
    process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = "/tmp/crew-7/cdaxi";
    expect(resolveSessionStateDir("worker-1")).toBe(
      join("/tmp/crew-7/cdaxi", "sessions", "worker-1"),
    );
    expect(resolveSessionPidFile("worker-1")).toBe(
      join("/tmp/crew-7/cdaxi", "sessions", "worker-1", "bridge.pid"),
    );
  });

  it("resolves a relative override against the current directory", () => {
    process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = "./cdaxi-state";
    expect(resolveStateBaseDir()).toBe(resolve("./cdaxi-state"));
  });

  it("falls back to the default for an empty or whitespace-only override", () => {
    process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = "   ";
    expect(resolveStateBaseDir()).toBe(STATE_DIR);
    process.env.CHROME_DEVTOOLS_AXI_STATE_DIR = "";
    expect(resolveStateBaseDir()).toBe(STATE_DIR);
  });
});

describe("session paths reject an unsafe CHROME_DEVTOOLS_AXI_SESSION", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = saved;
    }
  });

  it("throws from the env-default path resolvers instead of collapsing to the default dir", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => resolveSessionStateDir()).toThrow(/Invalid/);
    expect(() => resolveSessionPidFile()).toThrow(/Invalid/);
    expect(() => resolveSessionPort()).toThrow(/Invalid/);
  });
});
