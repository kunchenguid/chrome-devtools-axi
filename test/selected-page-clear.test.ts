/**
 * `clearSelectedPageId` must answer with the state of the session's routing
 * *after* it tried to drop it, because the bridge turns that answer into the
 * `/health` `pageIdentityChanged` flag the CLI uses to explain a reconnect.
 *
 * The unlink is faked at the `node:fs` seam rather than through directory
 * permissions so the case is deterministic on every platform and never depends
 * on the uid the suite runs as. Everything else, including the state-dir
 * layout, is the real filesystem.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSelectedPageId,
  getSelectedPageId,
  setSelectedPageId,
} from "../src/selected-page.js";

const fsControl = vi.hoisted(() => ({ failUnlink: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (fsControl.failUnlink) {
        throw Object.assign(
          new Error("EACCES: permission denied, unlink 'selected-page-id'"),
          { code: "EACCES" },
        );
      }
      return actual.unlinkSync(...args);
    },
  };
});

describe("clearSelectedPageId when the id cannot be removed", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  let tmpHome = "";

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-clear-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "clear-worker";
  });

  afterEach(() => {
    fsControl.failUnlink = false;
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports no drop while the id is still readable, so a reconnect is not credited with clearing routing", () => {
    setSelectedPageId(42);
    fsControl.failUnlink = true;

    // The id survives the failed unlink, so the next page-scoped call still
    // injects it. Answering `true` here would tell the bridge - and through
    // `/health?deep=1` the CLI - that the reconnect took the routing with it,
    // while `getSelectedPageId` keeps handing that same id out.
    expect(clearSelectedPageId()).toBe(false);
    expect(getSelectedPageId()).toBe(42);
  });

  it("still reports the drop once the id is actually gone", () => {
    setSelectedPageId(42);

    expect(clearSelectedPageId()).toBe(true);
    expect(getSelectedPageId()).toBeNull();
    // Nothing left to drop.
    expect(clearSelectedPageId()).toBe(false);
  });
});
