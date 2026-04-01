import { describe, it, expect } from "vitest";
import {
  computeCodexConfigUpdate,
  computeHookUpdate,
  getHookTargets,
  shouldInstallHooksForExecPath,
} from "../src/hooks.js";

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
    expect(hookCmd).toContain("chrome-devtools-axi");
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

  it("is a no-op when hook exists with correct path", () => {
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
    const [, changed] = computeHookUpdate(
      settings,
      "/usr/bin/chrome-devtools-axi",
    );
    expect(changed).toBe(false);
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
    expect(str).toContain("/new/path/chrome-devtools-axi");
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
      "/Users/kunchen/.airlock/worktrees/bf2b16b1f6b6/pool-3/bin/chrome-devtools-axi.ts",
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
  it("returns Claude and both Codex targets", () => {
    const targets = getHookTargets();
    expect(targets.length).toBe(3);
    expect(targets.some((t) => t.path.includes(".claude"))).toBe(true);
    expect(targets.some((t) => t.path.includes(".codex/hooks.json"))).toBe(
      true,
    );
    expect(targets.some((t) => t.path.includes(".codex/config.toml"))).toBe(
      true,
    );
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
});

describe("computeCodexConfigUpdate", () => {
  it("creates a features section when config is empty", () => {
    const [updated, changed] = computeCodexConfigUpdate("");
    expect(changed).toBe(true);
    expect(updated).toBe("[features]\ncodex_hooks = true\n");
  });

  it("adds codex_hooks when features section exists", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nother = true\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("[features]");
    expect(updated).toContain("other = true");
    expect(updated).toContain("codex_hooks = true");
  });

  it("repairs codex_hooks when disabled", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\ncodex_hooks = false\n",
    );
    expect(changed).toBe(true);
    expect(updated).toContain("codex_hooks = true");
    expect(updated).not.toContain("codex_hooks = false");
  });

  it("is a no-op when codex_hooks is already enabled", () => {
    const original = "[features]\ncodex_hooks = true\n";
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
    expect(updated).toContain("codex_hooks = true");
  });

  it("inserts before a following array-of-tables header", () => {
    const input = '[features]\nother = true\n[[profiles]]\nname = "default"\n';
    const [updated, changed] = computeCodexConfigUpdate(input);
    expect(changed).toBe(true);
    expect(updated).toBe(
      '[features]\nother = true\ncodex_hooks = true\n[[profiles]]\nname = "default"\n',
    );
  });
});
