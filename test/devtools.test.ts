import { describe, it, expect } from "vitest";
import {
  getCommandHelp,
  parseConsoleArgs,
  parseNetworkArgs,
  parseNetworkGetArgs,
} from "../src/cli.js";

describe("getCommandHelp", () => {
  it("returns non-null for console command", () => {
    expect(getCommandHelp("console")).not.toBeNull();
  });

  it("returns non-null for console-get command", () => {
    expect(getCommandHelp("console-get")).not.toBeNull();
  });

  it("returns non-null for network command", () => {
    expect(getCommandHelp("network")).not.toBeNull();
  });

  it("returns non-null for network-get command", () => {
    expect(getCommandHelp("network-get")).not.toBeNull();
  });

  it("does not include --full in console help", () => {
    expect(getCommandHelp("console")).not.toContain("--full");
  });

  it("does not include --full in console-get help", () => {
    expect(getCommandHelp("console-get")).not.toContain("--full");
  });

  it("does not include --full in network help", () => {
    expect(getCommandHelp("network")).not.toContain("--full");
  });

  it("does not include --full in network-get help", () => {
    expect(getCommandHelp("network-get")).not.toContain("--full");
  });
});

describe("parseConsoleArgs", () => {
  it("parses --type and --limit flags", () => {
    const result = parseConsoleArgs(["--type", "error", "--limit", "50"]);
    expect(result).toEqual({ types: ["error"], pageSize: 50 });
  });

  it("returns empty object for no args", () => {
    const result = parseConsoleArgs([]);
    expect(result).toEqual({});
  });

  it("parses --page flag", () => {
    const result = parseConsoleArgs(["--page", "3"]);
    expect(result).toEqual({ pageIdx: 3 });
  });

  it("parses all flags together", () => {
    const result = parseConsoleArgs(["--type", "warning", "--limit", "25", "--page", "1"]);
    expect(result).toEqual({ types: ["warning"], pageSize: 25, pageIdx: 1 });
  });

  it("omits invalid numeric flags", () => {
    const result = parseConsoleArgs(["--limit", "many", "--page", "later"]);
    expect(result).toEqual({});
  });
});

describe("parseNetworkArgs", () => {
  it("parses --type and --page flags", () => {
    const result = parseNetworkArgs(["--type", "fetch", "--page", "2"]);
    expect(result).toEqual({ resourceTypes: ["fetch"], pageIdx: 2 });
  });

  it("returns empty object for no args", () => {
    const result = parseNetworkArgs([]);
    expect(result).toEqual({});
  });

  it("parses --limit flag", () => {
    const result = parseNetworkArgs(["--limit", "100"]);
    expect(result).toEqual({ pageSize: 100 });
  });

  it("omits invalid numeric flags", () => {
    const result = parseNetworkArgs(["--limit", "many", "--page", "later"]);
    expect(result).toEqual({});
  });
});

describe("parseNetworkGetArgs", () => {
  it("parses id and --response-file flag", () => {
    const result = parseNetworkGetArgs(["42", "--response-file", "./resp.json"]);
    expect(result).toEqual({ reqid: 42, responseFilePath: "./resp.json" });
  });

  it("returns empty object for no args (gets selected request)", () => {
    const result = parseNetworkGetArgs([]);
    expect(result).toEqual({});
  });

  it("parses id alone", () => {
    const result = parseNetworkGetArgs(["7"]);
    expect(result).toEqual({ reqid: 7 });
  });

  it("parses --request-file flag", () => {
    const result = parseNetworkGetArgs(["10", "--request-file", "./req.json"]);
    expect(result).toEqual({ reqid: 10, requestFilePath: "./req.json" });
  });

  it("parses both file flags without id", () => {
    const result = parseNetworkGetArgs(["--response-file", "/tmp/resp", "--request-file", "/tmp/req"]);
    expect(result).toEqual({ responseFilePath: "/tmp/resp", requestFilePath: "/tmp/req" });
  });

  it("omits an invalid request id while keeping file flags", () => {
    const result = parseNetworkGetArgs(["oops", "--response-file", "./resp.json"]);
    expect(result).toEqual({ responseFilePath: "./resp.json" });
  });
});
