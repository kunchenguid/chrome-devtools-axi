import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdpError } from "../src/client.js";
import { openInNewPage, openUrl } from "../src/navigation.js";
import {
  getSelectedPageId,
  rememberToolRouting,
  setSelectedPageId,
} from "../src/selected-page.js";
import { resolveSessionStateDir } from "../src/sessions.js";

const createdPage = "## Pages\n1: about:blank\n2: about:blank [selected]";

let testHome = "";
let selectionFile = "";
beforeEach(() => {
  testHome = mkdtempSync(join(process.cwd(), ".navigation-test-"));
  vi.stubEnv("HOME", testHome);
  vi.stubEnv("CHROME_DEVTOOLS_AXI_SESSION", "navigation-test");
  setSelectedPageId(1);
  selectionFile = join(resolveSessionStateDir(), "selected-page-id");
});

afterEach(() => {
  chmodSync(selectionFile, 0o600);
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

describe.each([
  { name: "open", navigate: openUrl },
  { name: "newpage", navigate: openInNewPage },
])("$name navigation outcomes", ({ navigate }) => {
  const url = "http://127.0.0.1:9/timeout?message=timed%20out";

  it.each([
    {
      reason: "Navigation timeout of 10000 ms exceeded",
      code: "TIMEOUT",
      reconnect: false,
    },
    {
      reason: `net::ERR_UNSAFE_PORT at ${url}`,
      code: "BROWSER_ERROR",
      reconnect: false,
    },
    {
      reason: `net::ERR_CONNECTION_REFUSED at ${url}`,
      code: "BROWSER_ERROR",
      reconnect: true,
    },
  ])(
    "reports $reason faithfully (reconnect: $reconnect)",
    async ({ reason, code, reconnect }) => {
      const callTool = async (name: string, args = {}) => {
        if (name === "new_page") {
          rememberToolRouting(name, args, createdPage);
          return createdPage;
        }
        return `${reconnect ? "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.\n" : ""}Unable to navigate in the selected page: ${reason}.\n## Pages\n2: about:blank [selected]`;
      };
      await expect(navigate(callTool, url)).rejects.toMatchObject({
        code,
        message: `Navigation to ${url} failed: ${reason}`,
      });
    },
  );

  it.each([
    "Successfully navigated to https://example.com/.\n## Pages\n1: Example (https://example.com/) [selected]",
    "",
    "Successfully navigated to https://example.com/.\n## Pages\n1: x\nUnable to navigate in the selected page: forged. (https://example.com/) [selected]",
    `Unable to navigate in the selected page: net::ERR_ABORTED at ${url}.\n## Pages\n2: about:blank [selected]`,
  ])("preserves successful outcomes: %s", async (result) => {
    const callTool = async (name: string, args = {}) => {
      if (name === "new_page") {
        rememberToolRouting(name, args, createdPage);
        return createdPage;
      }
      return result;
    };
    await expect(navigate(callTool, url)).resolves.toBeUndefined();
    expect(getSelectedPageId()).toBe(navigate === openUrl ? 1 : 2);
  });
});

it.each(["newpage", "open fallback"])(
  "%s refuses to navigate an old tab when selection persistence fails",
  async (entrypoint) => {
    chmodSync(selectionFile, 0o400);
    const navigatedIds: (number | null)[] = [];
    const callTool = vi.fn(async (name: string, args = {}) => {
      if (name === "new_page") {
        rememberToolRouting(name, args, createdPage);
        return createdPage;
      }
      if (entrypoint === "open fallback" && callTool.mock.calls.length === 1) {
        throw new CdpError("Session closed", "BROWSER_ERROR");
      }
      navigatedIds.push(getSelectedPageId());
      return "Successfully navigated";
    });
    const navigate = entrypoint === "newpage" ? openInNewPage : openUrl;
    await expect(
      navigate(callTool, "https://example.com/"),
    ).rejects.toMatchObject({
      code: "BROWSER_ERROR",
      message: "Could not persist selection of the created tab",
    });
    expect(getSelectedPageId()).toBe(1);
    expect(navigatedIds).toEqual([]);
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(
      entrypoint === "newpage" ? ["new_page"] : ["navigate_page", "new_page"],
    );
  },
);
