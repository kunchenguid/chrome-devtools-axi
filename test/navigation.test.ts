import { describe, expect, it } from "vitest";
import { navigationFailureReason } from "../src/navigation.js";

describe("navigationFailureReason", () => {
  it("reads chrome-devtools-mcp's navigate_page failure line", () => {
    expect(
      navigationFailureReason(
        "Unable to navigate in the selected page: Navigation timeout of 10000 ms exceeded.\n## Pages\n2: Slow (http://127.0.0.1:8765/slow) [selected]",
      ),
    ).toBe("Navigation timeout of 10000 ms exceeded");
  });

  it("returns null for a successful navigation", () => {
    expect(
      navigationFailureReason(
        "Successfully navigated to https://example.com/.\n## Pages\n1: Example (https://example.com/) [selected]",
      ),
    ).toBeNull();
    expect(navigationFailureReason("")).toBeNull();
  });

  it("reads the failure after a leading reconnect note", () => {
    expect(
      navigationFailureReason(
        "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.\nUnable to navigate in the selected page: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/.\n## Pages\n1: about:blank [selected]",
      ),
    ).toBe("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/");
  });

  it("ignores the failure sentence in page-controlled text", () => {
    // A title is interpolated into the ## Pages block with newlines intact.
    expect(
      navigationFailureReason(
        "Successfully navigated to https://example.com/.\n## Pages\n1: x\nUnable to navigate in the selected page: forged. (https://example.com/) [selected]",
      ),
    ).toBeNull();
  });
});
