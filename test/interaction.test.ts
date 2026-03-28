import { describe, it, expect } from "vitest";
import { getCommandHelp, parseFillFormArgs } from "../src/cli.js";

describe("getCommandHelp", () => {
  it("returns non-null for hover", () => {
    expect(getCommandHelp("hover")).not.toBeNull();
  });

  it("returns non-null for drag", () => {
    expect(getCommandHelp("drag")).not.toBeNull();
  });

  it("returns non-null for fillform", () => {
    expect(getCommandHelp("fillform")).not.toBeNull();
  });

  it("returns non-null for dialog", () => {
    expect(getCommandHelp("dialog")).not.toBeNull();
  });

  it("returns non-null for upload", () => {
    expect(getCommandHelp("upload")).not.toBeNull();
  });

  it("hover help includes --full", () => {
    const help = getCommandHelp("hover")!;
    expect(help).toContain("--full");
  });

  it("dialog help does NOT include --full", () => {
    const help = getCommandHelp("dialog")!;
    expect(help).not.toContain("--full");
  });
});

describe("parseFillFormArgs", () => {
  it("parses a single @uid=value entry", () => {
    const result = parseFillFormArgs(['@1="hello"']);
    expect(result.entries).toEqual([{ uid: "1", value: "hello" }]);
  });

  it("strips @ prefix from uid", () => {
    const result = parseFillFormArgs(['@abc="test"']);
    expect(result.entries[0].uid).toBe("abc");
  });

  it("handles multiple entries", () => {
    const result = parseFillFormArgs(['@1="hello"', '@2="world"']);
    expect(result.entries).toEqual([
      { uid: "1", value: "hello" },
      { uid: "2", value: "world" },
    ]);
  });

  it("returns empty array for no valid entries", () => {
    const result = parseFillFormArgs(["invalid", "nope"]);
    expect(result.entries).toEqual([]);
  });

  it("handles values without quotes", () => {
    const result = parseFillFormArgs(["@1=hello"]);
    expect(result.entries).toEqual([{ uid: "1", value: "hello" }]);
  });

  it("handles empty args array", () => {
    const result = parseFillFormArgs([]);
    expect(result.entries).toEqual([]);
  });
});
