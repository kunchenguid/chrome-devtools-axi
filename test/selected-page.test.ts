import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSelectedPageId,
  createdPageIdFromNewPageDump,
  getSelectedPageId,
  overlaySessionSelected,
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

describe("createdPageIdFromNewPageDump", () => {
  it("records a single complete untitled page row matching args.url", () => {
    expect(
      createdPageIdFromNewPageDump(
        "## Pages\n1: https://new.example/",
        "https://new.example/",
      ),
    ).toBe(1);
  });

  it("records a single complete titled page row whose wrapper URL matches", () => {
    expect(
      createdPageIdFromNewPageDump(
        "## Pages\n1: Example Domain (https://new.example/) [selected]",
        "https://new.example/",
      ),
    ).toBe(1);
  });

  it("records the matching URL when the dump also lists about:blank", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: https://example.com/ [selected]",
        ].join("\n"),
        "https://example.com/",
      ),
    ).toBe(2);
  });

  it("does not treat a title continuation N: rest line as the created page id", () => {
    expect(
      createdPageIdFromNewPageDump(
        ["## Pages", "1: Error", "404: Not Found (https://example.com/)"].join(
          "\n",
        ),
        "https://example.com/",
      ),
    ).toBeNull();
  });

  it("leaves the id unset when no complete row URL matches args.url", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: https://example.com/",
          "9: https://attacker.example/ [selected]",
        ].join("\n"),
        "https://new.example/",
      ),
    ).toBeNull();
  });

  it("leaves the id unset when two complete rows both match args.url", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: https://example.com/",
          "2: https://example.com/ [selected]",
        ].join("\n"),
        "https://example.com/",
      ),
    ).toBeNull();
  });

  it("records the unique matching URL even when an older tab is listed", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: https://example.com/",
          "2: New (https://new.example/) [selected]",
        ].join("\n"),
        "https://new.example/",
      ),
    ).toBe(2);
  });

  it("ignores chrome-extension: rows so they cannot become the created id", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: https://example.com/",
          "## Extension Pages",
          "9: chrome-extension://abc/popup.html [selected]",
        ].join("\n"),
        "https://example.com/",
      ),
    ).toBe(1);
  });
});

describe("overlaySessionSelected", () => {
  const listed = [
    { id: 1, url: "https://example.com/", selected: true },
    { id: 2, url: "https://other.example/", selected: false },
  ];

  it("does not mark MCP [selected] as selected when AXI has no session id", () => {
    expect(overlaySessionSelected(listed, null)).toEqual([
      { id: 1, url: "https://example.com/", selected: false },
      { id: 2, url: "https://other.example/", selected: false },
    ]);
  });

  it("marks the session id even when MCP [selected] is on another row", () => {
    expect(overlaySessionSelected(listed, 2)).toEqual([
      { id: 1, url: "https://example.com/", selected: false },
      { id: 2, url: "https://other.example/", selected: true },
    ]);
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

  it("rememberToolRouting records a single-row new_page dump", () => {
    withTmpSession();
    rememberToolRouting(
      "new_page",
      { url: "https://new.example/" },
      "## Pages\n1: https://new.example/",
    );
    expect(getSelectedPageId()).toBe(1);
  });

  it("rememberToolRouting records the matching URL from a two-row about:blank dump", () => {
    withTmpSession();
    rememberToolRouting(
      "new_page",
      { url: "https://example.com/" },
      ["## Pages", "1: about:blank", "2: https://example.com/ [selected]"].join(
        "\n",
      ),
    );
    expect(getSelectedPageId()).toBe(2);
  });

  it("rememberToolRouting clears a prior id when the new_page dump is ambiguous", () => {
    withTmpSession();
    setSelectedPageId(1);
    rememberToolRouting(
      "new_page",
      { url: "https://new.example/" },
      ["## Pages", "1: Error", "404: Not Found (https://example.com/)"].join(
        "\n",
      ),
    );
    expect(getSelectedPageId()).toBeNull();
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
