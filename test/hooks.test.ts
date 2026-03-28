import { describe, it, expect } from "vitest";
import { computeHookUpdate, getHookTargets } from "../src/hooks.js";

describe("computeHookUpdate", () => {
  it("installs hook when settings have no hooks", () => {
    const settings = {};
    const [updated, changed] = computeHookUpdate(settings, "/usr/bin/chrome-devtools-axi");
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
          { matcher: "", hooks: [{ type: "command" as const, command: "other-tool status", timeout: 10 }] },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(settings, "/usr/bin/chrome-devtools-axi");
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
            hooks: [{ type: "command" as const, command: "/usr/bin/chrome-devtools-axi", timeout: 10 }],
          },
        ],
      },
    };
    const [, changed] = computeHookUpdate(settings, "/usr/bin/chrome-devtools-axi");
    expect(changed).toBe(false);
  });

  it("repairs hook when executable path changed", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command" as const, command: "/old/path/chrome-devtools-axi", timeout: 10 }],
          },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(settings, "/new/path/chrome-devtools-axi");
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("/new/path/chrome-devtools-axi");
    expect(str).not.toContain("/old/path/");
  });

  it("preserves other event hooks", () => {
    const settings = {
      hooks: {
        SessionEnd: [
          { matcher: "", hooks: [{ type: "command" as const, command: "cleanup-tool run", timeout: 5 }] },
        ],
      },
    };
    const [updated, changed] = computeHookUpdate(settings, "/usr/bin/chrome-devtools-axi");
    expect(changed).toBe(true);
    const str = JSON.stringify(updated);
    expect(str).toContain("cleanup-tool run");
    expect(str).toContain("chrome-devtools-axi");
  });
});

describe("getHookTargets", () => {
  it("returns both Claude Code and Codex targets", () => {
    const targets = getHookTargets();
    expect(targets.length).toBe(2);
    expect(targets.some((t) => t.path.includes(".claude"))).toBe(true);
    expect(targets.some((t) => t.path.includes(".codex"))).toBe(true);
  });

  it("Claude target reads from settings.json", () => {
    const claude = getHookTargets().find((t) => t.path.includes(".claude"));
    expect(claude!.path).toMatch(/settings\.json$/);
  });

  it("Codex target reads from hooks.json", () => {
    const codex = getHookTargets().find((t) => t.path.includes(".codex"));
    expect(codex!.path).toMatch(/hooks\.json$/);
  });
});
