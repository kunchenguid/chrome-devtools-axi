import { describe, it, expect } from "vitest";
import {
  countRefs,
  extractRefs,
  extractTitle,
  isInputType,
  truncateSnapshot,
  truncateText,
} from "../src/snapshot.js";

describe("countRefs", () => {
  it("counts uid= occurrences", () => {
    const snapshot = `RootWebArea "Example"
  uid=1 button "Submit"
  uid=2 textbox "Name"
  uid=3 link "Home"`;
    expect(countRefs(snapshot)).toBe(3);
  });

  it("returns 0 for no refs", () => {
    expect(countRefs('RootWebArea "Empty"')).toBe(0);
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
    const lines = Array.from(
      { length: 200 },
      (_, i) => `  uid=${i} button "Btn ${i}"`,
    );
    const snapshot = `RootWebArea "Big"\n${lines.join("\n")}`;
    const result = truncateSnapshot(snapshot, false, 200);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).not.toMatch(/\n$/);
    expect(result.totalLength).toBe(snapshot.length);
  });

  it("returns full snapshot when full=true regardless of limit", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `  uid=${i} button "Btn ${i}"`,
    );
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

describe("truncateText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "short text here";
    const result = truncateText(text, 8000);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
  });

  it("keeps head and tail when over limit", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `line ${i}: ${"x".repeat(50)}`,
    );
    const text = lines.join("\n");
    const result = truncateText(text, 500);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 0:");
    expect(result.text).toContain("line 99:");
    expect(result.text).toContain("chars omitted");
    expect(result.totalLength).toBe(text.length);
  });

  it("preserves tail content for grading visibility", () => {
    const head = "Year 1901\tAlice\nYear 1902\tBob\n";
    const middle = Array.from(
      { length: 100 },
      (_, i) => `Year ${1903 + i}\tPerson${i}`,
    ).join("\n");
    const tail = "\nYear 2023\tRecent Winner\nYear 2024\tLatest Winner";
    const text = head + middle + tail;
    const result = truncateText(text, 500);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("Year 2024");
    expect(result.text).toContain("Latest Winner");
  });

  it("reports accurate totalLength", () => {
    const text = "x".repeat(20000);
    const result = truncateText(text, 1000);
    expect(result.totalLength).toBe(20000);
  });

  it("skips truncation when result would be longer than original", () => {
    // Text barely over the limit — marker overhead would make it longer
    const text = "x".repeat(120);
    const result = truncateText(text, 100);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.totalLength).toBe(120);
  });
});
