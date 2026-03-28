import { describe, it, expect } from "vitest";
import { formatStopOutput, getCommandHelp } from "../src/cli.js";

describe("formatStopOutput", () => {
  it("returns stopped status when bridge was running", () => {
    const output = formatStopOutput(true);
    expect(output).toContain("stopped");
    expect(output).not.toContain("no-op");
  });

  it("returns no-op status when bridge was not running", () => {
    const output = formatStopOutput(false);
    expect(output).toContain("no-op");
  });
});

describe("getCommandHelp", () => {
  it("returns help text for known commands", () => {
    const help = getCommandHelp("open");
    expect(help).toContain("open");
    expect(help).toContain("--full");
    expect(help).toContain("example");
  });

  it("returns null for unknown commands", () => {
    expect(getCommandHelp("nonexistent")).toBeNull();
  });

  it("includes --full flag for snapshot-producing commands", () => {
    for (const cmd of ["open", "snapshot", "click", "fill", "type", "press", "scroll", "back"]) {
      expect(getCommandHelp(cmd)).toContain("--full");
    }
  });

  it("does not include --full for non-snapshot commands", () => {
    expect(getCommandHelp("eval")).not.toContain("--full");
    expect(getCommandHelp("start")).not.toContain("--full");
    expect(getCommandHelp("stop")).not.toContain("--full");
  });

  it("has help for all 12 commands", () => {
    const commands = ["open", "snapshot", "click", "fill", "type", "press", "scroll", "back", "wait", "eval", "start", "stop"];
    for (const cmd of commands) {
      expect(getCommandHelp(cmd)).not.toBeNull();
    }
  });
});
