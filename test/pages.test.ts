import { describe, it, expect } from "vitest";
import { getCommandHelp, parsePagesList, formatMcpResult } from "../src/cli.js";
import {
  needsPageId,
  parseSelectedPageId,
  PAGE_SCOPED_TOOLS,
} from "../src/pages.js";

describe("getCommandHelp", () => {
  it("returns help for pages command", () => {
    const help = getCommandHelp("pages");
    expect(help).not.toBeNull();
    expect(help).toContain("pages");
  });

  it("returns help for newpage command", () => {
    const help = getCommandHelp("newpage");
    expect(help).not.toBeNull();
    expect(help).toContain("newpage");
  });

  it("returns help for selectpage command", () => {
    const help = getCommandHelp("selectpage");
    expect(help).not.toBeNull();
    expect(help).toContain("selectpage");
  });

  it("returns help for closepage command", () => {
    const help = getCommandHelp("closepage");
    expect(help).not.toBeNull();
    expect(help).toContain("closepage");
  });

  it("returns help for resize command", () => {
    const help = getCommandHelp("resize");
    expect(help).not.toBeNull();
    expect(help).toContain("resize");
  });

  it("resize help does not include --full", () => {
    const help = getCommandHelp("resize");
    expect(help).not.toContain("--full");
  });

  it("closepage help does not include --full", () => {
    const help = getCommandHelp("closepage");
    expect(help).not.toContain("--full");
  });

  it("pages help does not include --full", () => {
    const help = getCommandHelp("pages");
    expect(help).not.toContain("--full");
  });

  it("newpage help includes --full and --background", () => {
    const help = getCommandHelp("newpage");
    expect(help).toContain("--full");
    expect(help).toContain("--background");
  });

  it("selectpage help includes --full", () => {
    const help = getCommandHelp("selectpage");
    expect(help).toContain("--full");
  });

  it("returns null for unknown command", () => {
    const help = getCommandHelp("nonexistent");
    expect(help).toBeNull();
  });
});

describe("parsePagesList", () => {
  it("parses single page with selected marker", () => {
    const result = parsePagesList(
      "## Pages\n1: https://example.com/ [selected]",
    );
    expect(result).toEqual([
      { id: 1, url: "https://example.com/", selected: true },
    ]);
  });

  it("parses multiple pages", () => {
    const result = parsePagesList(
      "## Pages\n0: https://a.com/\n1: https://b.com/ [selected]",
    );
    expect(result).toEqual([
      { id: 0, url: "https://a.com/", selected: false },
      { id: 1, url: "https://b.com/", selected: true },
    ]);
  });

  it("returns empty array for no pages", () => {
    const result = parsePagesList("## Pages");
    expect(result).toEqual([]);
  });

  it("extracts the parenthesized URL when MCP includes a page title", () => {
    const result = parsePagesList(
      "## Pages\n1: Example Domain (https://example.com/) [selected]",
    );
    expect(result).toEqual([
      { id: 1, url: "https://example.com/", selected: true },
    ]);
  });

  it("recognizes selected pages when isolatedContext contains spaces", () => {
    const result = parsePagesList(
      "1: Title (https://example.com/) [selected] isolatedContext=my context name",
    );
    expect(result).toEqual([
      { id: 1, url: "https://example.com/", selected: true },
    ]);
  });

  it("parses untitled pages that carry an isolatedContext label", () => {
    const result = parsePagesList(
      "2: https://example.com/path isolatedContext=worker ctx",
    );
    expect(result).toEqual([
      { id: 2, url: "https://example.com/path", selected: false },
    ]);
  });

  it("keeps untitled URLs that contain parentheses", () => {
    const result = parsePagesList(
      "1: https://en.wikipedia.org/wiki/Foo_(bar) [selected]",
    );
    expect(result).toEqual([
      {
        id: 1,
        url: "https://en.wikipedia.org/wiki/Foo_(bar)",
        selected: true,
      },
    ]);
  });

  it("peels a trailing scheme URL that itself contains parentheses", () => {
    const result = parsePagesList(
      "1: Foo (bar) (https://en.wikipedia.org/wiki/Foo_(bar)) [selected]",
    );
    expect(result).toEqual([
      {
        id: 1,
        url: "https://en.wikipedia.org/wiki/Foo_(bar)",
        selected: true,
      },
    ]);
  });

  it("keeps untitled data: URLs that contain parentheses", () => {
    const result = parsePagesList(
      "0: data:text/html,<h1>Hi (there)</h1> [selected]",
    );
    expect(result).toEqual([
      { id: 0, url: "data:text/html,<h1>Hi (there)</h1>", selected: true },
    ]);
  });

  it("joins a title newline so [selected] still attaches to the page id", () => {
    const result = parsePagesList(
      "1: Hello\nWorld (https://example.com/) [selected]",
    );
    expect(result).toEqual([
      { id: 1, url: "https://example.com/", selected: true },
    ]);
  });

  it("joins CRLF title continuations onto the previous page row", () => {
    const result = parsePagesList(
      "1: Hello\r\nWorld\r\nTab (https://example.com/) [selected]",
    );
    expect(result).toEqual([
      { id: 1, url: "https://example.com/", selected: true },
    ]);
  });
});

describe("parseSelectedPageId", () => {
  it("returns the selected page id", () => {
    expect(
      parseSelectedPageId(
        "## Pages\n0: https://a.com/\n1: https://b.com/ [selected]",
      ),
    ).toBe(1);
  });

  it("returns null when no page is marked selected", () => {
    expect(parseSelectedPageId("## Pages\n0: https://a.com/")).toBeNull();
  });

  it("returns id 0 when the selected page is the first tab", () => {
    expect(
      parseSelectedPageId("0: about:blank [selected]\n1: https://b.com/"),
    ).toBe(0);
  });

  it("still finds [selected] when the page title contains a newline", () => {
    expect(
      parseSelectedPageId(
        "## Pages\n1: Hello\nWorld (https://example.com/) [selected]",
      ),
    ).toBe(1);
  });
});

describe("needsPageId", () => {
  it("is true for page-scoped AXI tools that omit pageId", () => {
    expect(needsPageId("evaluate_script", { function: "() => 1" })).toBe(true);
    expect(needsPageId("take_snapshot")).toBe(true);
    expect(needsPageId("click", { uid: "1" })).toBe(true);
    expect(needsPageId("fill", { uid: "1", value: "x" })).toBe(true);
  });

  it("is false for browser-scoped tools that manage page identity themselves", () => {
    expect(needsPageId("list_pages")).toBe(false);
    expect(needsPageId("new_page", { url: "https://example.com" })).toBe(false);
    expect(needsPageId("select_page", { pageId: 2 })).toBe(false);
    expect(needsPageId("close_page", { pageId: 2 })).toBe(false);
  });

  it("is false when a numeric pageId is already present", () => {
    expect(needsPageId("take_snapshot", { pageId: 0 })).toBe(false);
    expect(needsPageId("click", { uid: "1", pageId: 3 })).toBe(false);
  });

  it("skips evaluate_script when targeting a service worker", () => {
    expect(
      needsPageId("evaluate_script", {
        function: "() => 1",
        serviceWorkerId: "ext:1",
      }),
    ).toBe(false);
  });

  it("covers every AXI-wrapped page-scoped tool name", () => {
    expect(PAGE_SCOPED_TOOLS.has("navigate_page")).toBe(true);
    expect(PAGE_SCOPED_TOOLS.has("take_screenshot")).toBe(true);
    expect(PAGE_SCOPED_TOOLS.has("list_pages")).toBe(false);
  });
});

describe("formatMcpResult", () => {
  it("outputs labeled block with short content", () => {
    const output = formatMcpResult("result", "hello world", []);
    expect(output).toContain("result:");
    expect(output).toContain("hello world");
    expect(output).not.toContain("truncated");
  });

  it("truncates long content", () => {
    const long = "x".repeat(5000);
    const output = formatMcpResult("result", long, []);
    expect(output).toContain("truncated");
    expect(output).toContain("5000 chars total");
  });

  it("includes suggestions as help block", () => {
    const output = formatMcpResult("result", "data", [
      "Run `foo` to do something",
    ]);
    expect(output).toContain("help[1]:");
    expect(output).toContain("Run `foo` to do something");
  });
});
