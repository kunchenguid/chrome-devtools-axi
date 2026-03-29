import { describe, it, expect } from "vitest";
import { getCommandHelp, parseEmulateArgs } from "../src/cli.js";

describe("getCommandHelp", () => {
  it("returns help for emulate", () => {
    expect(getCommandHelp("emulate")).not.toBeNull();
  });

  it("does NOT include --full (not a snapshot command)", () => {
    const help = getCommandHelp("emulate")!;
    expect(help).not.toContain("--full");
  });

  it("includes all 6 flags", () => {
    const help = getCommandHelp("emulate")!;
    expect(help).toContain("--viewport");
    expect(help).toContain("--color-scheme");
    expect(help).toContain("--network");
    expect(help).toContain("--cpu");
    expect(help).toContain("--geolocation");
    expect(help).toContain("--user-agent");
  });
});

describe("parseEmulateArgs", () => {
  it("parses viewport and color-scheme", () => {
    const result = parseEmulateArgs(["--viewport", "390x844x3,mobile", "--color-scheme", "dark"]);
    expect(result).toEqual({ viewport: "390x844x3,mobile", colorScheme: "dark" });
  });

  it("parses cpu and network", () => {
    const result = parseEmulateArgs(["--cpu", "4", "--network", "Slow 3G"]);
    expect(result).toEqual({ cpuThrottlingRate: 4, networkConditions: "Slow 3G" });
  });

  it("returns empty object for no args", () => {
    const result = parseEmulateArgs([]);
    expect(result).toEqual({});
  });

  it("parses geolocation", () => {
    const result = parseEmulateArgs(["--geolocation", "37.7749x-122.4194"]);
    expect(result).toEqual({ geolocation: "37.7749x-122.4194" });
  });

  it("omits an invalid cpu throttling rate", () => {
    const result = parseEmulateArgs(["--cpu", "fast"]);
    expect(result).toEqual({});
  });
});
