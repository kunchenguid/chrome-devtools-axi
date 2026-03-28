import { describe, it, expect } from "vitest";
import {
  getCommandHelp,
  parseLighthouseArgs,
  parsePerfStartArgs,
} from "../src/cli.js";

describe("getCommandHelp", () => {
  it("returns non-null for lighthouse", () => {
    expect(getCommandHelp("lighthouse")).not.toBeNull();
  });

  it("returns non-null for perf-start", () => {
    expect(getCommandHelp("perf-start")).not.toBeNull();
  });

  it("returns non-null for perf-stop", () => {
    expect(getCommandHelp("perf-stop")).not.toBeNull();
  });

  it("returns non-null for perf-insight", () => {
    expect(getCommandHelp("perf-insight")).not.toBeNull();
  });

  it("returns non-null for heap", () => {
    expect(getCommandHelp("heap")).not.toBeNull();
  });

  it("none include --full in help", () => {
    const commands = ["lighthouse", "perf-start", "perf-stop", "perf-insight", "heap"];
    for (const cmd of commands) {
      const help = getCommandHelp(cmd);
      expect(help).not.toContain("--full");
    }
  });
});

describe("parseLighthouseArgs", () => {
  it("parses --device and --output-dir", () => {
    const result = parseLighthouseArgs(["--device", "mobile", "--output-dir", "./reports"]);
    expect(result).toEqual({ device: "mobile", outputDirPath: "./reports" });
  });

  it("returns empty object for no args", () => {
    const result = parseLighthouseArgs([]);
    expect(result).toEqual({});
  });
});

describe("parsePerfStartArgs", () => {
  it("parses --no-reload and --file", () => {
    const result = parsePerfStartArgs(["--no-reload", "--file", "trace.json.gz"]);
    expect(result).toEqual({ reload: false, filePath: "trace.json.gz" });
  });

  it("returns empty object for no args", () => {
    const result = parsePerfStartArgs([]);
    expect(result).toEqual({});
  });

  it("parses --no-auto-stop", () => {
    const result = parsePerfStartArgs(["--no-auto-stop"]);
    expect(result).toEqual({ autoStop: false });
  });
});
