import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  getCommandHelp,
  parseFillFormArgs,
  parseUid,
  parseUidFresh,
} from "../src/cli.js";
import * as generation from "../src/generation.js";

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

describe("parseUid (generation validation)", () => {
  beforeEach(() => {
    vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the bare uid for a fresh generation-tagged ref", () => {
    expect(parseUid("@g7:237_15")).toBe("237_15");
  });

  it("returns the bare uid for an untagged legacy ref", () => {
    expect(parseUid("@237_15")).toBe("237_15");
  });

  it("throws STALE_REF on an older-generation ref", () => {
    let caught: unknown;
    try {
      parseUid("@g3:237_15");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { code?: string };
    expect(e.code).toBe("STALE_REF");
    expect(e.message).toContain("generation 3");
    expect(e.message).toContain("current is 7");
    expect(e.message).toContain("@g3:237_15");
  });

  it("throws STALE_REF on a newer-generation ref (defensive)", () => {
    expect(() => parseUid("@g9:237_15")).toThrow(/Stale ref/);
  });

  it("works without an @ prefix on the input", () => {
    expect(parseUid("g7:abc")).toBe("abc");
    expect(() => parseUid("g4:abc")).toThrow(/Stale ref/);
  });
});

describe("parseUidFresh", () => {
  beforeEach(() => {
    vi.spyOn(generation, "getCurrentGeneration").mockReturnValue(7);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws STALE_REF when page mutations advance the current ref generation", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue("Script ran on page and returned:\n```json\n8\n```");

    await expect(parseUidFresh("@g7:237_15", callTool)).rejects.toMatchObject({
      code: "STALE_REF",
    });
  });
});
