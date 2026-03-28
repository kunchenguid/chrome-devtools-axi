import { describe, it, expect } from "vitest";
import { countRefs, extractRefs, extractTitle, isInputType, truncateSnapshot } from "../src/snapshot.js";

describe("countRefs", () => {
  it("counts uid= occurrences", () => {
    const snapshot = `RootWebArea "Example"
  uid=1 button "Submit"
  uid=2 textbox "Name"
  uid=3 link "Home"`;
    expect(countRefs(snapshot)).toBe(3);
  });

  it("returns 0 for no refs", () => {
    expect(countRefs("RootWebArea \"Empty\"")).toBe(0);
  });
});

describe("extractRefs", () => {
  it("extracts ref info from snapshot lines", () => {
    const snapshot = `  uid=1 button "Submit"
  uid=2 textbox "Name"`;
    const refs = extractRefs(snapshot);
    expect(refs).toEqual([
      { ref: "1", type: "button", label: "Submit" },
      { ref: "2", type: "textbox", label: "Name" },
    ]);
  });
});

describe("extractTitle", () => {
  it("extracts title from RootWebArea", () => {
    expect(extractTitle('RootWebArea "My Page"')).toBe("My Page");
  });

  it("falls back to heading", () => {
    expect(extractTitle('  heading "Welcome"')).toBe("Welcome");
  });

  it("returns empty for no title", () => {
    expect(extractTitle("div")).toBe("");
  });
});

describe("isInputType", () => {
  it("recognizes input types", () => {
    expect(isInputType("textbox")).toBe(true);
    expect(isInputType("searchbox")).toBe(true);
    expect(isInputType("textarea")).toBe(true);
  });

  it("rejects non-input types", () => {
    expect(isInputType("button")).toBe(false);
    expect(isInputType("link")).toBe(false);
  });
});

describe("truncateSnapshot", () => {
  it("returns snapshot unchanged when under limit", () => {
    const snapshot = 'RootWebArea "Short"\n  uid=1 button "OK"';
    const result = truncateSnapshot(snapshot, false, 4000);
    expect(result.text).toBe(snapshot);
    expect(result.truncated).toBe(false);
  });

  it("truncates at last newline before limit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  uid=${i} button "Btn ${i}"`);
    const snapshot = `RootWebArea "Big"\n${lines.join("\n")}`;
    const result = truncateSnapshot(snapshot, false, 200);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).not.toMatch(/\n$/);
    expect(result.totalLength).toBe(snapshot.length);
  });

  it("returns full snapshot when full=true regardless of limit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  uid=${i} button "Btn ${i}"`);
    const snapshot = `RootWebArea "Big"\n${lines.join("\n")}`;
    const result = truncateSnapshot(snapshot, true, 200);
    expect(result.text).toBe(snapshot);
    expect(result.truncated).toBe(false);
  });

  it("reports accurate totalLength", () => {
    const snapshot = "x".repeat(5000);
    const result = truncateSnapshot(snapshot, false, 100);
    expect(result.totalLength).toBe(5000);
  });
});
