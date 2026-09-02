import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callTool } = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  CdpError: class CdpError extends AxiError {
    constructor(
      message: string,
      public readonly code: string,
      public readonly suggestions: string[] = [],
    ) {
      super(message, code, suggestions);
      this.name = "CdpError";
    }
  },
  callTool,
}));

import {
  assertExtensionMode,
  handleExtensionAction,
  handleExtensionInstall,
  handleExtensionList,
  handleExtensionReload,
  handleExtensionUninstall,
  parseExtensionList,
  validateExtensionId,
  validateExtensionPath,
} from "../src/extensions.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

const savedEnv: Record<string, string | undefined> = {};
let extensionDir = "";

function restoreEnv(key: string): void {
  const value = savedEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("extension lifecycle commands", () => {
  beforeEach(() => {
    for (const key of [
      "CHROME_DEVTOOLS_AXI_EXTENSION_MODE",
      "CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
      "CHROME_DEVTOOLS_AXI_BROWSER_URL",
      "CHROME_DEVTOOLS_AXI_USER_DATA_DIR",
      "CHROME_DEVTOOLS_AXI_SESSION",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CHROME_DEVTOOLS_AXI_EXTENSION_MODE = "1";
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "extension-contract";
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    extensionDir = mkdtempSync(join(tmpdir(), "axi-extension-test-"));
    callTool.mockReset();
  });

  afterEach(() => {
    callTool.mockReset();
    if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
    for (const key of Object.keys(savedEnv)) restoreEnv(key);
  });

  it("forwards install to the official tool with an absolute path", async () => {
    callTool.mockResolvedValueOnce(`Extension installed. Id: ${EXTENSION_ID}`);

    const output = await handleExtensionInstall([extensionDir]);

    expect(callTool).toHaveBeenCalledWith("install_extension", {
      path: extensionDir,
    });
    expect(output).toContain("operation: install");
    expect(output).toContain("session: extension-contract");
    expect(output).toContain("temporary isolated profile");
    expect(output).toContain(EXTENSION_ID);
  });

  it("forwards list and renders id, name, version, and enabled state", async () => {
    callTool.mockResolvedValueOnce(
      [
        "## Extensions",
        `id=${EXTENSION_ID} "Agent fixture" v1.2.3 Enabled`,
        `id=ponmlkjihgfedcbaponmlkjihgfedcba "Disabled fixture" v2.0.0 Disabled`,
      ].join("\n"),
    );

    const output = await handleExtensionList([]);

    expect(callTool).toHaveBeenCalledWith("list_extensions");
    expect(output).toContain(EXTENSION_ID);
    expect(output).toContain("Agent fixture");
    expect(output).toContain("1.2.3");
    expect(output).toContain("true");
    expect(output).toContain("false");
    expect(output).toContain("count: 2");
  });

  it.each([
    ["reload", handleExtensionReload, "reload_extension", "reload"],
    ["action", handleExtensionAction, "trigger_extension_action", "action"],
    ["uninstall", handleExtensionUninstall, "uninstall_extension", "uninstall"],
  ] as const)(
    "forwards %s by exact extension id",
    async (_operation, handler, tool, operation) => {
      callTool.mockResolvedValueOnce(`Extension ${operation}d.`);

      const output = await handler([EXTENSION_ID]);

      expect(callTool).toHaveBeenCalledWith(tool, { id: EXTENSION_ID });
      expect(output).toContain(`operation: ${operation}`);
      expect(output).toContain(EXTENSION_ID);
    },
  );

  it("rejects lifecycle operations without explicit extension mode", async () => {
    delete process.env.CHROME_DEVTOOLS_AXI_EXTENSION_MODE;

    await expect(handleExtensionList([])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("CHROME_DEVTOOLS_AXI_EXTENSION_MODE=1"),
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects remote-browser and persistent-profile combinations", async () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";

    await expect(handleExtensionList([])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("pipe-launched Chrome"),
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("validates absolute existing install paths before forwarding", async () => {
    await expect(
      handleExtensionInstall(["relative-extension"]),
    ).rejects.toThrow("must be absolute");
    await expect(
      handleExtensionInstall([join(extensionDir, "missing")]),
    ).rejects.toThrow("does not exist");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("validates extension IDs and does not accept names", async () => {
    expect(() => validateExtensionId("My extension")).toThrow(
      "32 lowercase letters from a-p",
    );
    await expect(handleExtensionReload(["My extension"])).rejects.toThrow(
      "extension ID",
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("parses the official list format without matching by name", () => {
    expect(
      parseExtensionList(
        `## Extensions\nid=${EXTENSION_ID} "A \"quoted\" name" v1 Enabled`,
      ),
    ).toEqual([
      {
        id: EXTENSION_ID,
        name: 'A "quoted" name',
        version: "1",
        enabled: true,
      },
    ]);
    expect(parseExtensionList("No extensions installed.")).toEqual([]);
    expect(parseExtensionList("future format")).toBeNull();
  });

  it("asserts the mode gate independently of tool execution", () => {
    expect(() => assertExtensionMode()).not.toThrow();
  });
});
