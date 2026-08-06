import { describe, it, expect, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { installSessionStartHooks } = vi.hoisted(() => ({
  installSessionStartHooks: vi.fn(),
}));

vi.mock("axi-sdk-js", async () => {
  const actual =
    await vi.importActual<typeof import("axi-sdk-js")>("axi-sdk-js");
  return {
    ...actual,
    installSessionStartHooks,
  };
});

import {
  addOpenCodeSessionPolicy,
  buildPiExtension,
  computeCodexConfigUpdate,
  computeHookUpdate,
  getHookTargets,
  installHooksOrThrow,
  SESSION_END_HOOK_TIMEOUT_SECONDS,
  shouldInstallHooksForExecPath,
  withAgentBridgeIdleTimeout,
} from "../src/hooks.js";

describe("addOpenCodeSessionPolicy", () => {
  it("adds the portable session-start argument idempotently", () => {
    const source = "const child = spawn(command, [], { shell: false });";
    const updated = addOpenCodeSessionPolicy(source);

    expect(updated).toContain('spawn(command, ["--agent-session-start"], {');
    expect(addOpenCodeSessionPolicy(updated)).toBe(updated);
  });
});

describe("buildPiExtension", () => {
  it("maps Pi startup context and shutdown to the inherited AXI session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-devtools-axi-pi-"));
    const command = join(dir, "fake-axi");
    const log = join(dir, "axi.log");
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "\${1:-start}" "\${CHROME_DEVTOOLS_AXI_SESSION:-}" "\${CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS:-}" >> "${log}"\nprintf 'browser context for pi\\n'\n`,
    );
    chmodSync(command, 0o755);

    const source = buildPiExtension(command);
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    const handlers: Record<string, (...args: any[]) => any> = {};
    module.default({
      on(event: string, handler: (...args: any[]) => any) {
        handlers[event] = handler;
      },
    });

    const previousSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "fleet-pi-owned";
    try {
      handlers.session_start();
      expect(
        handlers.before_agent_start({ systemPrompt: "base prompt" }),
      ).toEqual({
        systemPrompt: "base prompt\n\nbrowser context for pi",
      });
      handlers.session_shutdown();
    } finally {
      if (previousSession === undefined) {
        delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
      } else {
        process.env.CHROME_DEVTOOLS_AXI_SESSION = previousSession;
      }
    }

    expect(readFileSync(log, "utf-8")).toBe(
      `--agent-session-start\tfleet-pi-owned\t\n` +
        `--agent-session-end\tfleet-pi-owned\t\n`,
    );
  });

  it("uses a shared owner marker so Fleet and global Pi hooks cannot duplicate", () => {
    const source = buildPiExtension("/usr/bin/chrome-devtools-axi");
    expect(source).toContain('Symbol.for("chrome-devtools-axi.pi.lifecycle")');
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).not.toContain('pi.on("turn_end"');
  });

  it("reacquires Pi lifecycle ownership after a completed session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chrome-devtools-axi-pi-reuse-"));
    const command = join(dir, "fake-axi");
    writeFileSync(command, "#!/bin/sh\nprintf 'browser context for pi\\n'\n");
    chmodSync(command, 0o755);

    try {
      const source = buildPiExtension(command);
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
      );
      const handlers: Record<string, (...args: any[]) => any> = {};
      module.default({
        on(event: string, handler: (...args: any[]) => any) {
          handlers[event] = handler;
        },
      });

      handlers.session_start();
      handlers.session_shutdown();
      handlers.session_start();

      expect(
        handlers.before_agent_start({ systemPrompt: "second session" }),
      ).toEqual({
        systemPrompt: "second session\n\nbrowser context for pi",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launches JavaScript entrypoints through the Node executable", () => {
    const source = buildPiExtension("C:\\tools\\chrome-devtools-axi.js", {
      platform: "win32",
      nodeExecutable: "C:\\node\\node.exe",
    });

    expect(source).toContain(
      'const AXI_EXECUTABLE = "C:\\\\node\\\\node.exe";',
    );
    expect(source).toContain(
      'const AXI_PREFIX_ARGS = ["C:\\\\tools\\\\chrome-devtools-axi.js"]',
    );
  });

  it("launches Windows npm shims through the command processor", () => {
    const source = buildPiExtension("C:\\tools\\chrome-devtools-axi.cmd", {
      platform: "win32",
      windowsCommandShell: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(source).toContain(
      'const AXI_EXECUTABLE = "C:\\\\Windows\\\\System32\\\\cmd.exe";',
    );
    expect(source).toContain(
      '["/d","/s","/c","C:\\\\tools\\\\chrome-devtools-axi.cmd"]',
    );
    expect(source).toContain("[...AXI_PREFIX_ARGS, ...args]");
  });
});

describe("installHooksOrThrow", () => {
  it("throws when the hook installer reports an internal install error", () => {
    installSessionStartHooks.mockImplementationOnce((options) => {
      options.onError?.("/home/user/.claude/settings.json: permission denied");
    });

    expect(() => installHooksOrThrow()).toThrow(
      "/home/user/.claude/settings.json: permission denied",
    );
  });
});

describe("computeHookUpdate", () => {
  it("installs hook when settings have no hooks", () => {
    const settings = {};
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );
    expect(changed).toBe(true);
    expect(updated.hooks).toBeDefined();
    expect(updated.hooks!.SessionStart).toBeDefined();
    expect(updated.hooks!.SessionStart!.length).toBeGreaterThan(0);
    const hookCmd = JSON.stringify(updated);
    expect(hookCmd).toContain("--agent-session-start");
    expect(hookCmd).toContain("chrome-devtools-axi");
    expect(updated.hooks!.SessionEnd).toBeDefined();
    expect(JSON.stringify(updated.hooks!.SessionEnd)).toContain(
      "chrome-devtools-axi --agent-session-end stop",
    );
    expect(updated.hooks!.SessionEnd![0].hooks[0].timeout).toBe(
      SESSION_END_HOOK_TIMEOUT_SECONDS,
    );
    expect(updated.hooks!.SessionEnd![0].hooks[0].timeout).toBeLessThanOrEqual(
      3,
    );
    expect(JSON.stringify(updated.hooks!.Stop ?? [])).not.toContain(
      "chrome-devtools-axi",
    );
  });

  it("installs hook alongside existing hooks", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "other-tool status",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("other-tool status");
    expect(str).toContain("chrome-devtools-axi");
  });

  it("is a no-op when agent hooks already have the timeout wrapper and session teardown", () => {
    const command = withAgentBridgeIdleTimeout("/usr/bin/chrome-devtools-axi");
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command,
                timeout: 10,
              },
            ],
          },
        ],
        SessionEnd: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command:
                  "/usr/bin/chrome-devtools-axi --agent-session-end stop",
                timeout: SESSION_END_HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        ],
      },
    };
    const [, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );
    expect(changed).toBe(false);
  });

  it("repairs a legacy bare hook by adding the timeout wrapper and SessionEnd hook", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/usr/bin/chrome-devtools-axi",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );

    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("/usr/bin/chrome-devtools-axi --agent-session-start");
    expect(str).toContain(
      "/usr/bin/chrome-devtools-axi --agent-session-end stop",
    );
    expect(str).toContain("SessionEnd");
    expect(str).not.toContain('"Stop"');
  });

  it("migrates the mistaken managed Stop hook to SessionEnd", () => {
    const command = withAgentBridgeIdleTimeout("/usr/bin/chrome-devtools-axi");
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command,
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: `${command} stop`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    };

    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );

    expect(changed).toBe(true);
    expect(JSON.stringify(updated.hooks!.SessionEnd)).toContain(
      "/usr/bin/chrome-devtools-axi --agent-session-end stop",
    );
    expect(updated.hooks!.SessionEnd![0].hooks[0].timeout).toBe(
      SESSION_END_HOOK_TIMEOUT_SECONDS,
    );
    expect(updated.hooks!.Stop).toBeUndefined();
  });

  it("removes only managed Stop hooks and preserves unrelated Stop hooks", () => {
    const command = withAgentBridgeIdleTimeout("/usr/bin/chrome-devtools-axi");
    const settings = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: `${command} stop`,
                timeout: 10,
              },
              {
                type: "command" as const,
                command: "other-stop-guard",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };

    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );

    expect(changed).toBe(true);
    expect(JSON.stringify(updated.hooks!.SessionEnd)).toContain(
      "/usr/bin/chrome-devtools-axi --agent-session-end stop",
    );
    expect(updated.hooks!.SessionEnd![0].hooks[0].timeout).toBeLessThanOrEqual(
      3,
    );
    expect(JSON.stringify(updated.hooks!.Stop)).toContain("other-stop-guard");
    expect(JSON.stringify(updated.hooks!.Stop)).not.toContain(
      "chrome-devtools-axi",
    );
  });

  it("repairs hook when executable path changed", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/old/path/chrome-devtools-axi",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/new/path/chrome-devtools-axi",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain(
      "/new/path/chrome-devtools-axi --agent-session-start",
    );
    expect(str).not.toContain("/old/path/");
  });

  it("preserves other event hooks", () => {
    const settings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "cleanup-tool run",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("cleanup-tool run");
    expect(str).toContain("chrome-devtools-axi");
  });

  it("repairs hooks regardless of whether the exec path is production-eligible", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/usr/local/bin/chrome-devtools-axi",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(
      settings,
      "/Users/kunchen/.airlock/worktrees/bf2b16b1f6b6/pool-3/bin/chrome-devtools-axi.ts",
    );
    expect(changed).toBe(true);
    expect(JSON.stringify(updated)).toContain(
      "/Users/kunchen/.airlock/worktrees/bf2b16b1f6b6/pool-3/bin/chrome-devtools-axi.ts --agent-session-start",
    );
  });
});

describe("shouldInstallHooksForExecPath", () => {
  it("rejects non-production TypeScript entrypoints", () => {
    expect(
      shouldInstallHooksForExecPath(
        "/Users/kunchen/.airlock/worktrees/bf2b16b1f6b6/pool-3/bin/chrome-devtools-axi.ts",
      ),
    ).toBe(false);
  });

  it("accepts packaged dist entrypoints", () => {
    expect(
      shouldInstallHooksForExecPath(
        "/Users/kunchen/github/kunchenguid/chrome-devtools-axi/dist/bin/chrome-devtools-axi.js",
      ),
    ).toBe(true);
  });
});

describe("getHookTargets", () => {
  it("returns Claude, both Codex targets, and the Pi extension", () => {
    const targets = getHookTargets();
    expect(targets.length).toBe(4);
    expect(targets.some((t) => t.path.includes(".claude"))).toBe(true);
    expect(targets.some((t) => t.path.includes(".codex/hooks.json"))).toBe(
      true,
    );
    expect(targets.some((t) => t.path.includes(".codex/config.toml"))).toBe(
      true,
    );
    expect(
      targets.some((t) =>
        t.path.includes(".pi/agent/extensions/chrome-devtools-axi.ts"),
      ),
    ).toBe(true);
  });

  it("Claude target reads from settings.json", () => {
    const claude = getHookTargets().find((t) => t.path.includes(".claude"));
    expect(claude!.path).toMatch(/settings\.json$/);
  });

  it("Codex target reads from hooks.json", () => {
    const codex = getHookTargets().find((t) => t.path.includes(".codex"));
    expect(codex!.path).toMatch(/hooks\.json$/);
  });

  it("Codex config target reads from config.toml", () => {
    const codex = getHookTargets().find((t) =>
      t.path.includes(".codex/config.toml"),
    );
    expect(codex!.path).toMatch(/config\.toml$/);
  });

  it("Pi target follows PI_CODING_AGENT_DIR", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-fleet-profile";
    try {
      const pi = getHookTargets().find((target) =>
        target.path.endsWith("chrome-devtools-axi.ts"),
      );
      expect(pi?.path).toBe(
        "/tmp/pi-fleet-profile/extensions/chrome-devtools-axi.ts",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
    }
  });
});

describe("computeCodexConfigUpdate", () => {
  it("creates a features section when config is empty", () => {
    const [updated, changed] = computeCodexConfigUpdate("");
    expect(changed).toBe(true);
    expect(updated).toBe("[features]\nhooks = true\n");
  });

  it("adds hooks when features section exists", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nother = true\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("[features]");
    expect(updated).toContain("other = true");
    expect(updated).toContain("hooks = true");
  });

  it("repairs hooks when disabled", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nhooks = false\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("hooks = true");
    expect(updated).not.toContain("hooks = false");
  });

  it("is a no-op when hooks is already enabled", () => {
    const original = "[features]\nhooks = true\n";
    const [updated, changed] = computeCodexConfigUpdate(original);
    expect(changed).toBe(false);
    expect(updated).toBe(original);
  });

  it("preserves unrelated sections while adding the flag", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      '[model]\nname = "gpt-5"\n',
    );
    expect(changed).toBe(true);
    expect(updated).toContain("[model]");
    expect(updated).toContain('name = "gpt-5"');
    expect(updated).toContain("[features]");
    expect(updated).toContain("hooks = true");
  });

  it("inserts before a following array-of-tables header", () => {
    const input = '[features]\nother = true\n[[profiles]]\nname = "default"\n';
    const [updated, changed] = computeCodexConfigUpdate(input);
    expect(changed).toBe(true);
    expect(updated).toBe(
      '[features]\nother = true\nhooks = true\n[[profiles]]\nname = "default"\n',
    );
  });
});
