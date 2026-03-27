import { describe, it, expect } from "vitest";
import { countRefs, extractRefs, extractTitle, isInputType } from "../src/snapshot.js";

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
