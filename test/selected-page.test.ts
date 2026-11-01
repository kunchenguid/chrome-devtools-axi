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
  it("records the single complete row MCP marked selected", () => {
    expect(
      createdPageIdFromNewPageDump(
        "## Pages\n1: Example Domain (https://new.example/) [selected]",
      ),
    ).toBe(1);
  });

  it("records the marked row when the dump also lists about:blank", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: https://example.com/ [selected]",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("records the marked row when another tab has the same URL", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: Test (https://example.com/)",
          "3: Test (https://example.com/) [selected]",
        ].join("\n"),
      ),
    ).toBe(3);
  });

  it("records a marked row in an isolated context", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: Example Domain (https://example.com/)",
          "2: Example Domain (https://example.com/) [selected] isolatedContext=signed-out",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("records a duplicate about:blank tab", () => {
    expect(
      createdPageIdFromNewPageDump(
        ["## Pages", "1: about:blank", "2: about:blank [selected]"].join("\n"),
      ),
    ).toBe(2);
  });

  it("records the marked row when the page's URL changed while loading", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: Redirected (https://example.com/?x=1) [selected]",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("ignores a title that imitates the selected marker", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: x (https://fake.example/) [selected] (https://evil.example/)",
          "2: https://new.example/ [selected]",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("does not treat a title continuation N: rest line as the created page id", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: Error",
          "404: Not Found (https://example.com/) [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not let a multi-line title forge a marked row", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "3: x (https://a)",
          "5: about:blank [selected]",
          "bar (https://evil.example/) [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not let a title forge a second Pages block that hides the real row", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: x",
          "## Pages",
          "1: about:blank [selected]",
          "## Extension Pages",
          "x (https://new.example/) [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not let a title hide the real row's marker behind another section header", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: x (https://a.example/)",
          "1: about:blank [selected]",
          "## WebMCP tools",
          "x (https://new.example/) [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not let a title's last line pose as another tab's marked row", () => {
    // Title "x (https://a.example/)\n1: about:blank" on created tab 2: the
    // real marker lands on a line that reads as a row for existing tab 1.
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: about:blank",
          "2: x (https://a.example/)",
          "1: about:blank (https://new.example/) [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not record an opaque URL that ends in the selected marker", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "6: data:text/plain,hi [selected]",
          "7: https://new.example/ [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("leaves the id unset when no row is marked selected", () => {
    expect(
      createdPageIdFromNewPageDump(
        ["## Pages", "1: about:blank", "2: https://example.com/"].join("\n"),
      ),
    ).toBeNull();
  });

  it("leaves the id unset when two rows are marked selected", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "## Pages",
          "1: https://example.com/ [selected]",
          "2: https://example.com/ [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("leaves the id unset when MCP fell back to another page", () => {
    expect(
      createdPageIdFromNewPageDump(
        [
          "Note: the previously selected page was closed. Page 1 is now selected.",
          "## Pages",
          "1: about:blank [selected]",
        ].join("\n"),
      ),
    ).toBeNull();
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
      ),
    ).toBeNull();
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
      "## Pages\n1: https://new.example/ [selected]",
    );
    expect(getSelectedPageId()).toBe(1);
  });

  it("rememberToolRouting records the marked row from a two-row about:blank dump", () => {
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
    setSelectedPageId(1);
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
    expect(getSelectedPageId()).toBeNull();
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
