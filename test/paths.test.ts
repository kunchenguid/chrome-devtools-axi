import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOutputPath } from "../src/paths.js";

describe("resolveOutputPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves relative paths against process.cwd()", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/project");
    expect(resolveOutputPath("./shot.png")).toBe(
      resolve("/caller/project", "./shot.png"),
    );
    expect(resolveOutputPath("trace.json.gz")).toBe(
      resolve("/caller/project", "trace.json.gz"),
    );
  });

  it("passes absolute paths through unchanged", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/project");
    expect(resolveOutputPath("/tmp/shot.png")).toBe("/tmp/shot.png");
    expect(resolveOutputPath("/var/reports")).toBe("/var/reports");
  });
});
