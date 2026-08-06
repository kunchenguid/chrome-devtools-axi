import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionIdleTimeoutPolicy,
  writeSessionIdleTimeoutPolicy,
} from "../src/session-policy.js";

describe("session idle timeout policy", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let home: string;
  let policyFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-session-policy-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "worker-1";
    policyFile = join(
      home,
      ".chrome-devtools-axi",
      "sessions",
      "worker-1",
      "agent-idle-timeout",
    );
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("expires and clears an idle policy after its timeout window", () => {
    writeSessionIdleTimeoutPolicy(120_000, 1_000);

    expect(readSessionIdleTimeoutPolicy(120_999)).toBe(120_000);
    expect(readSessionIdleTimeoutPolicy(121_000)).toBeUndefined();
    expect(existsSync(policyFile)).toBe(false);
  });

  it("stores an explicit deadline and discards legacy permanent policies", () => {
    writeSessionIdleTimeoutPolicy(120_000, 1_000);
    expect(JSON.parse(readFileSync(policyFile, "utf-8"))).toEqual({
      timeoutMs: 120_000,
      expiresAt: 121_000,
    });

    writeFileSync(policyFile, "120000");
    expect(readSessionIdleTimeoutPolicy(2_000)).toBeUndefined();
    expect(existsSync(policyFile)).toBe(false);
  });
});
