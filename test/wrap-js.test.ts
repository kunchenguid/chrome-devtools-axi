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

  it("unwraps a simple arrow IIFE to the inner function", () => {
    expect(wrapJsExpression("(() => 42)()")).toBe("() => 42");
  });

  it("unwraps a simple arrow IIFE with a trailing semicolon", () => {
    expect(wrapJsExpression("(() => 42)();")).toBe("() => 42");
  });

  it("unwraps a multi-statement arrow IIFE", () => {
    expect(wrapJsExpression("(() => { const x = 5; return x + 1 })()")).toBe(
      "() => { const x = 5; return x + 1 }",
    );
  });

  it("unwraps an async arrow IIFE", () => {
    expect(wrapJsExpression("(async () => 7)()")).toBe("async () => 7");
  });

  it("unwraps a function-keyword IIFE", () => {
    expect(wrapJsExpression("(function() { return 1 })()")).toBe(
      "function() { return 1 }",
    );
  });

  it("wraps an IIFE with non-empty args (conservative: only () unwraps)", () => {
    // Not a no-arg IIFE — wrap so MCP can call it as a function and get the value.
    expect(wrapJsExpression("(x => x + 1)(5)")).toBe("() => ((x => x + 1)(5))");
  });

  it("wraps a parenthesized property call", () => {
    expect(wrapJsExpression("(window.getValue)()")).toBe(
      "() => ((window.getValue)())",
    );
  });

  it("wraps a parenthesized method call", () => {
    expect(wrapJsExpression("(obj.method)()")).toBe("() => ((obj.method)())");
  });
});
