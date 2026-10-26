import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInNewPage, openUrl } from "../src/navigation.js";
import {
  getSelectedPageId,
  rememberToolRouting,
  setSelectedPageId,
} from "../src/selected-page.js";
import { resolveSessionStateDir } from "../src/sessions.js";

const fsControl = vi.hoisted(() => ({ unwritableFile: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === fsControl.unwritableFile) {
        throw Object.assign(
          new Error("EACCES: permission denied, open 'selected-page-id'"),
          { code: "EACCES" },
        );
      }
      return actual.writeFileSync(...args);
    },
  };
});

const url = "http://127.0.0.1:9/timeout?message=timed%20out";

it.each([
  ["Navigation timeout of 10000 ms exceeded", "TIMEOUT", ""],
  [`net::ERR_UNSAFE_PORT at ${url}`, "BROWSER_ERROR", ""],
  [
    `net::ERR_CONNECTION_REFUSED at ${url}`,
    "BROWSER_ERROR",
    "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.\n",
  ],
])("reports %s faithfully", async (reason, code, reconnect) => {
  await expect(
    openUrl(
      async () =>
        `${reconnect}Unable to navigate in the selected page: ${reason}.\n## Pages\n2: about:blank [selected]`,
      url,
    ),
  ).rejects.toMatchObject({
    code,
    message: `Navigation to ${url} failed: ${reason}`,
  });
});

it("ignores a failure sentence forged inside a page title", async () => {
  await expect(
    openUrl(
      async () =>
        "Successfully navigated to https://example.com/.\n## Pages\n1: x\nUnable to navigate in the selected page: forged. (https://example.com/) [selected]",
      url,
    ),
  ).resolves.toBeUndefined();
});

describe("newpage when selection persistence fails", () => {
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
    fsControl.unwritableFile = "";
    vi.unstubAllEnvs();
    rmSync(testHome, { recursive: true, force: true });
  });

  it("fails before navigating the old tab when its selection file is unwritable", async () => {
    fsControl.unwritableFile = selectionFile;
    const createdPage = "## Pages\n1: about:blank\n2: about:blank [selected]";
    const callTool = vi.fn(async (name: string, args = {}) => {
      rememberToolRouting(name, args, createdPage);
      return createdPage;
    });
    await expect(
      openInNewPage(callTool, "https://example.com/"),
    ).rejects.toMatchObject({
      code: "BROWSER_ERROR",
      message: "Could not persist selection of the created tab",
    });
    expect(getSelectedPageId()).toBe(1);
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["new_page"]);
  });
});
