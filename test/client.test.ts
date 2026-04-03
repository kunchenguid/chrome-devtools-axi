import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { CdpError, mapErrorMessage } from "../src/client.js";

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
