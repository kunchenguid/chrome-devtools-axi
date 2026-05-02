import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  CdpError,
  mapErrorMessage,
  resolveBridgeTimeoutMs,
} from "../src/client.js";

describe("CdpError", () => {
  it("uses the shared axi-sdk-js error contract", () => {
    const error = new CdpError("boom", "UNKNOWN", ["try again"]);

    expect(error).toBeInstanceOf(AxiError);
    expect(error.code).toBe("UNKNOWN");
    expect(error.suggestions).toEqual(["try again"]);
  });
});

describe("mapErrorMessage", () => {
  it("maps bridge connectivity failures", () => {
    const error = mapErrorMessage("connect ECONNREFUSED 127.0.0.1:9224");

    expect(error.code).toBe("BRIDGE_NOT_READY");
    expect(error.message).toContain("Bridge is not running");
  });

  it("maps element lookup failures", () => {
    const error = mapErrorMessage("element uid not found");

    expect(error.code).toBe("REF_NOT_FOUND");
  });

  it("maps JSON-encoded browser errors", () => {
    const error = mapErrorMessage(JSON.stringify({ error: "Page crashed" }));

    expect(error.code).toBe("BROWSER_ERROR");
    expect(error.message).toBe("Page crashed");
  });
});

describe("resolveBridgeTimeoutMs", () => {
  let savedTimeout: string | undefined;

  beforeEach(() => {
    savedTimeout = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (savedTimeout === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = savedTimeout;
    }
  });

  it("defaults to 30s when env var is unset", () => {
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("honors a numeric env value", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "60000";
    expect(resolveBridgeTimeoutMs()).toBe(60_000);
  });

  it("clamps tiny values to a 1s floor (avoids pathological retries)", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "10";
    expect(resolveBridgeTimeoutMs()).toBe(1_000);
  });

  it("falls back to default when value is non-numeric", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "soon";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("falls back to default when value is zero or negative", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "0";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "-100";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });
});
