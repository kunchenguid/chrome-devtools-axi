import { describe, it, expect } from "vitest";
import { wrapJsExpression } from "../src/cli.js";

describe("wrapJsExpression", () => {
  it("wraps an expression in a concise arrow", () => {
    expect(wrapJsExpression("document.title")).toBe("() => (document.title)");
  });

  it("trims whitespace", () => {
    expect(wrapJsExpression("  document.title  ")).toBe(
      "() => (document.title)",
    );
  });

  it("passes through () => arrow functions", () => {
    expect(wrapJsExpression("() => document.title")).toBe(
      "() => document.title",
    );
  });

  it("passes through function keyword", () => {
    expect(wrapJsExpression("function() { return 1; }")).toBe(
      "function() { return 1; }",
    );
  });

  it("wraps complex expressions as-is", () => {
    expect(wrapJsExpression("document.querySelectorAll('a').length")).toBe(
      "() => (document.querySelectorAll('a').length)",
    );
  });
});
