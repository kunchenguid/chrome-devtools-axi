import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

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
    }
  },
  callTool,
  ensureBridge: vi.fn(),
  getSessionSnapshotIfRunning: vi.fn(),
  stopBridge: vi.fn(),
}));

import { main } from "../src/cli.js";
import { CdpError } from "../src/client.js";

describe("extension commands", () => {
  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  describe("ext-install", () => {
    it("requires an extension path argument", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-install"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("Missing extension path");
    });

    it("requires an absolute path", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-install", "./relative/path"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("must be absolute");
    });

    it("validates path exists before calling MCP", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-install", "/nonexistent/extension/path"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("does not exist");
      // Should never reach the MCP tool call for a nonexistent path
      expect(callTool).not.toHaveBeenCalled();
    });

    it("calls install_unpacked_extension with valid absolute path", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "ext-"));
      try {
        // Create a dummy extension manifest to make it look like a real extension
        writeFileSync(join(tempDir, "manifest.json"), '{}');

        callTool.mockResolvedValueOnce(
          "extension installed\nID: jopfghbocfiapmmcjpbkcbgbefhphpkd",
        );

        const write = vi
          .spyOn(process.stdout, "write")
          .mockImplementation(() => true);

        await main(["ext-install", tempDir]);

        expect(callTool).toHaveBeenCalledWith("install_unpacked_extension", {
          path: tempDir,
        });

        const output = String(write.mock.calls[0]?.[0]);
        expect(output).toContain("extension installed");
      } finally {
        rmSync(tempDir, { recursive: true });
      }
    });
  });

  describe("ext-list", () => {
    it("calls list_extensions with no arguments", async () => {
      callTool.mockResolvedValueOnce("extensions:\nID: ext1, Name: Extension 1");

      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-list"]);

      expect(callTool).toHaveBeenCalledWith("list_extensions", {});

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("extensions");
    });
  });

  describe("ext-reload", () => {
    it("requires an extension ID argument", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-reload"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("Missing extension ID");
    });

    it("calls reload_extension with the provided ID", async () => {
      callTool.mockResolvedValueOnce("extension reloaded");

      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-reload", "jopfghbocfiapmmcjpbkcbgbefhphpkd"]);

      expect(callTool).toHaveBeenCalledWith("reload_extension", {
        extensionId: "jopfghbocfiapmmcjpbkcbgbefhphpkd",
      });

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("extension reloaded");
    });
  });

  describe("ext-trigger", () => {
    it("requires an extension ID argument", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-trigger"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("Missing extension ID");
    });

    it("calls trigger_extension_action with the provided ID", async () => {
      callTool.mockResolvedValueOnce("extension action triggered");

      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-trigger", "jopfghbocfiapmmcjpbkcbgbefhphpkd"]);

      expect(callTool).toHaveBeenCalledWith("trigger_extension_action", {
        extensionId: "jopfghbocfiapmmcjpbkcbgbefhphpkd",
      });

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("extension action triggered");
    });
  });

  describe("ext-uninstall", () => {
    it("requires an extension ID argument", async () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-uninstall"]);

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("error");
      expect(output).toContain("Missing extension ID");
    });

    it("calls uninstall_extension with the provided ID", async () => {
      callTool.mockResolvedValueOnce("extension uninstalled");

      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await main(["ext-uninstall", "jopfghbocfiapmmcjpbkcbgbefhphpkd"]);

      expect(callTool).toHaveBeenCalledWith("uninstall_extension", {
        extensionId: "jopfghbocfiapmmcjpbkcbgbefhphpkd",
      });

      const output = String(write.mock.calls[0]?.[0]);
      expect(output).toContain("extension uninstalled");
    });
  });
});
