import { describe, it, expect } from "vitest";
import { getSuggestions } from "../src/suggestions.js";

describe("getSuggestions", () => {
  it("suggests snapshot for wait command", () => {
    const suggestions = getSuggestions({ command: "wait" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("snapshot");
  });

  it("suggests snapshot for eval command", () => {
    const suggestions = getSuggestions({ command: "eval" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toContain("snapshot");
  });

  it("suggests filling inputs after open", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Sign In"`;
    const suggestions = getSuggestions({ command: "open", snapshot });
    expect(suggestions.some((s) => s.includes("fill"))).toBe(true);
  });

  it("suggests submit after fill", () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Submit"`;
    const suggestions = getSuggestions({ command: "fill", snapshot });
    expect(suggestions.some((s) => s.includes("Submit"))).toBe(true);
  });

  it("always includes eval tip", () => {
    const snapshot = `RootWebArea "Page"
  uid=1 textbox "Search"
  uid=2 button "Go"
  uid=3 link "Home"`;
    const suggestions = getSuggestions({ command: "snapshot", snapshot });
    expect(suggestions.some((s) => s.includes("eval"))).toBe(true);
  });
});
