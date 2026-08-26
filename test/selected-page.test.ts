import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSelectedPageId,
  getSelectedPageId,
  rememberToolRouting,
  setSelectedPageId,
} from "../src/selected-page.js";

describe("selected page session-name validation", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = saved;
    }
  });

  it("rejects a dot-only session instead of reading the default session's id", () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    expect(() => getSelectedPageId()).toThrow(/Invalid/);
    expect(() => setSelectedPageId(1)).toThrow(/Invalid/);
    expect(() => clearSelectedPageId()).toThrow(/Invalid/);
  });
});

describe("selected page persistence", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  let tmpHome = "";

  afterEach(() => {
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  function withTmpSession(): void {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-selected-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "sel-worker";
  }

  it("round-trips a selected page id", () => {
    withTmpSession();
    expect(getSelectedPageId()).toBeNull();
    setSelectedPageId(4);
    expect(getSelectedPageId()).toBe(4);
    clearSelectedPageId();
    expect(getSelectedPageId()).toBeNull();
  });

  it("rememberToolRouting records select_page and ignores [selected] dumps", () => {
    withTmpSession();
    rememberToolRouting(
      "select_page",
      { pageId: 3 },
      "## Pages\n9: x [selected]",
    );
    expect(getSelectedPageId()).toBe(3);
  });

  it("rememberToolRouting records the created new_page id, not [selected]", () => {
    withTmpSession();
    rememberToolRouting(
      "new_page",
      { url: "https://new.example/" },
      [
        "## Pages",
        "1: https://example.com/ [selected]",
        "2: https://new.example/",
      ].join("\n"),
    );
    expect(getSelectedPageId()).toBe(2);
  });

  it("rememberToolRouting does not target chrome-extension: rows from a new_page dump", () => {
    withTmpSession();
    rememberToolRouting(
      "new_page",
      { url: "https://example.com/" },
      [
        "## Pages",
        "1: https://example.com/",
        "## Extension Pages",
        "9: chrome-extension://abc/popup.html [selected]",
      ].join("\n"),
    );
    expect(getSelectedPageId()).toBe(1);
  });

  it("rememberToolRouting clears on close_page of the selected id", () => {
    withTmpSession();
    setSelectedPageId(5);
    rememberToolRouting("close_page", { pageId: 2 }, "");
    expect(getSelectedPageId()).toBe(5);
    rememberToolRouting("close_page", { pageId: 5 }, "");
    expect(getSelectedPageId()).toBeNull();
  });
});
