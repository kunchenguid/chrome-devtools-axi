import { describe, it, expect } from "vitest";
import { getCommandHelp, parsePagesList, formatMcpResult } from "../src/cli.js";

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
    const result = parsePagesList("## Pages\n1: https://example.com/ [selected]");
    expect(result).toEqual([{ id: 1, url: "https://example.com/", selected: true }]);
  });

  it("parses multiple pages", () => {
    const result = parsePagesList("## Pages\n0: https://a.com/\n1: https://b.com/ [selected]");
    expect(result).toEqual([
      { id: 0, url: "https://a.com/", selected: false },
      { id: 1, url: "https://b.com/", selected: true },
    ]);
  });

  it("returns empty array for no pages", () => {
    const result = parsePagesList("## Pages");
    expect(result).toEqual([]);
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
    const output = formatMcpResult("result", "data", ["Run `foo` to do something"]);
    expect(output).toContain("help[1]:");
    expect(output).toContain("Run `foo` to do something");
  });
});
