import { afterEach, describe, expect, it, vi } from "vitest";

// --- Mock the client layer ---

const { callTool } = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  CdpError: class CdpError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly suggestions: string[] = [],
    ) {
      super(message);
    }
  },
  callTool,
  ensureBridge: vi.fn(),
  getSessionSnapshotIfRunning: vi.fn(),
  stopBridge: vi.fn(),
}));

import { main, getCommandHelp } from "../src/cli.js";
import { CdpError } from "../src/client.js";
import {
  createPageHelper,
  isUidRef,
  parseEvalOutput,
  runScript,
} from "../src/run.js";

/** Mock response for the evaluate_script call that page.open() makes to read url+status. */
const OPEN_INFO_RESPONSE =
  'Script ran on page and returned:\n```json\n{"url":"https://example.com","status":200}\n```';

afterEach(() => {
  callTool.mockReset();
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// --- 1. No-args output teaches `run` ---

describe("no-args output", () => {
  it("only suggests open in the no-session output", async () => {
    const { getSessionSnapshotIfRunning } = await import("../src/client.js");
    (
      getSessionSnapshotIfRunning as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await main([]);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("Run `chrome-devtools-axi open <url>` to start browsing");
    expect(output).toContain("help[1]:");
    expect(output).not.toContain("chrome-devtools-axi run");
  });
});

// --- 2. `run --help` documents the script API ---

describe("run --help", () => {
  it("documents the compact script API", () => {
    const help = getCommandHelp("run");
    expect(help).not.toBeNull();
    expect(help).toContain("page.open");
    expect(help).toContain("page.eval");
    expect(help).toContain("page.snapshot");
    expect(help).toContain("page.click");
    expect(help).toContain("page.fill");
    expect(help).toContain("page.wait");
    expect(help).toContain("page.type");
    expect(help).toContain("page.press");
    expect(help).toContain("page.back");
    expect(help).toContain("example");
  });
});

// --- 3. Eval result parser unwraps remote tool output ---

describe("parseEvalOutput", () => {
  it("extracts JSON value from MCP wrapper", () => {
    const output = 'Script ran on page and returned:\n```json\n"hello"\n```';
    expect(parseEvalOutput(output)).toBe("hello");
  });

  it("extracts numeric value", () => {
    const output = "Script ran on page and returned:\n```json\n42\n```";
    expect(parseEvalOutput(output)).toBe(42);
  });

  it("extracts object value", () => {
    const output = 'Script ran on page and returned:\n```json\n{"a":1}\n```';
    expect(parseEvalOutput(output)).toEqual({ a: 1 });
  });

  it("extracts null", () => {
    const output = "Script ran on page and returned:\n```json\nnull\n```";
    expect(parseEvalOutput(output)).toBeNull();
  });

  it("falls back to raw trimmed string when no JSON block", () => {
    expect(parseEvalOutput("just text")).toBe("just text");
  });
});

// --- 4. Script helper object maps commands to bridge calls ---

describe("createPageHelper", () => {
  it("page.open calls navigate_page, falls back to new_page, returns { url, status }", async () => {
    callTool
      .mockRejectedValueOnce(new CdpError("not connected", "BROWSER_ERROR"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(OPEN_INFO_RESPONSE);

    const page = createPageHelper(callTool);
    const result = await page.open("https://example.com");

    expect(callTool).toHaveBeenCalledWith("navigate_page", {
      type: "url",
      url: "https://example.com",
    });
    expect(callTool).toHaveBeenCalledWith("new_page", {
      url: "https://example.com",
    });
    expect(result).toEqual({ url: "https://example.com", status: 200 });
  });

  it("page.open succeeds on first try when page exists", async () => {
    callTool
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(OPEN_INFO_RESPONSE);

    const page = createPageHelper(callTool);
    const result = await page.open("https://example.com");

    expect(callTool).toHaveBeenCalledWith("navigate_page", {
      type: "url",
      url: "https://example.com",
    });
    expect(result.url).toBe("https://example.com");
    expect(result.status).toBe(200);
  });

  it("page.eval with string expression", async () => {
    callTool.mockResolvedValueOnce(
      'Script ran on page and returned:\n```json\n"Example Domain"\n```',
    );

    const page = createPageHelper(callTool);
    const result = await page.eval("document.title");

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: "() => (document.title)",
    });
    expect(result).toBe("Example Domain");
  });

  it("page.eval with function", async () => {
    callTool.mockResolvedValueOnce(
      "Script ran on page and returned:\n```json\n3\n```",
    );

    const page = createPageHelper(callTool);
    const result = await page.eval(() => 1 + 2);

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: expect.stringContaining("() => 1 + 2"),
    });
    expect(result).toBe(3);
  });

  it("page.snapshot strips header", async () => {
    callTool.mockResolvedValueOnce(
      '## Latest page snapshot\nRootWebArea "Title"\n  uid=1 link "Home"',
    );

    const page = createPageHelper(callTool);
    const snap = await page.snapshot();

    expect(callTool).toHaveBeenCalledWith("take_snapshot");
    expect(snap).toContain("RootWebArea");
    expect(snap).not.toContain("## Latest");
  });

  it("page.wait with number waits by duration", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.wait(500);

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: "new Promise(r => setTimeout(r, 500))",
    });
  });

  it("page.wait with string waits for CSS selector via evaluate_script", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.wait(".results");

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: expect.stringContaining(".results"),
    });
    // Default 30s timeout
    expect(callTool.mock.calls[0][1].function).toContain("30000");
  });

  it("page.wait with selector and custom timeout", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.wait("#loaded", 5000);

    const fn = callTool.mock.calls[0][1].function;
    expect(fn).toContain("#loaded");
    expect(fn).toContain("5000");
  });

  it("page.click calls click with parsed uid", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.click("@12");

    expect(callTool).toHaveBeenCalledWith("click", { uid: "12" });
  });

  it("page.click accepts uid without @", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.click("5");

    expect(callTool).toHaveBeenCalledWith("click", { uid: "5" });
  });

  it("page.click with CSS selector uses evaluate_script", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.click("a[href='/wiki/Charles_Babbage']");

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: expect.stringContaining("a[href='/wiki/Charles_Babbage']"),
    });
    expect(callTool).not.toHaveBeenCalledWith("click", expect.anything());
  });

  it("page.click with CSS class selector uses evaluate_script", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.click(".submit-btn");

    const fn = callTool.mock.calls[0][1].function;
    expect(fn).toContain(".submit-btn");
    expect(fn).toContain("scrollIntoView");
    expect(fn).toContain(".click()");
  });

  it("page.fill calls fill with uid and value", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.fill("@3", "hello");

    expect(callTool).toHaveBeenCalledWith("fill", { uid: "3", value: "hello" });
  });

  it("page.fill with CSS selector uses evaluate_script", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.fill("input[name='search']", "query");

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: expect.stringContaining("input[name='search']"),
    });
    const fn = callTool.mock.calls[0][1].function;
    expect(fn).toContain("query");
    expect(fn).toContain("dispatchEvent");
  });

  it("page.type calls type_text", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.type("hello");

    expect(callTool).toHaveBeenCalledWith("type_text", { text: "hello" });
  });

  it("page.press calls press_key", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.press("Enter");

    expect(callTool).toHaveBeenCalledWith("press_key", { key: "Enter" });
  });

  it("page.back calls navigate_page with back", async () => {
    callTool.mockResolvedValueOnce("");

    const page = createPageHelper(callTool);
    await page.back();

    expect(callTool).toHaveBeenCalledWith("navigate_page", { type: "back" });
  });
});

// --- 5. Script runner executes script content and only exposes script stdout ---

describe("runScript", () => {
  it("captures script console.log output", async () => {
    const result = await runScript(
      `console.log("hello from script");`,
      callTool,
    );

    expect(result.stdout).toBe("hello from script\n");
  });

  it("captures multiple console.log lines", async () => {
    const result = await runScript(
      `console.log("line1"); console.log("line2");`,
      callTool,
    );

    expect(result.stdout).toBe("line1\nline2\n");
  });

  it("supports top-level await", async () => {
    callTool
      .mockResolvedValueOnce("") // navigate_page
      .mockResolvedValueOnce(OPEN_INFO_RESPONSE) // evaluate_script for url+status
      .mockResolvedValueOnce(
        'Script ran on page and returned:\n```json\n"Example Domain"\n```',
      );

    const result = await runScript(
      `
await page.open("https://example.com");
const result = await page.eval("document.title");
console.log(result);
`,
      callTool,
    );

    expect(result.stdout).toBe("Example Domain\n");
  });

  it("supports default export function", async () => {
    const result = await runScript(
      `export default async function() { console.log("from export"); }`,
      callTool,
    );

    expect(result.stdout).toBe("from export\n");
  });

  it("returns empty stdout when script prints nothing", async () => {
    const result = await runScript(`const x = 1 + 2;`, callTool);

    expect(result.stdout).toBe("");
  });
});

// --- 6. Validation errors ---

describe("run command validation", () => {
  it("errors when stdin is a TTY (no script piped)", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    await main(["run"]);

    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
    const output = String(write.mock.calls[0]?.[0]);
    expect(output).toContain("No script provided");
    expect(output).toContain("VALIDATION_ERROR");
    expect(process.exitCode).toBe(1);
  });
});

// --- 7. page.open falls back when no page/session ---

describe("page.open fallback", () => {
  it("falls back to new_page on session-closed error", async () => {
    callTool
      .mockRejectedValueOnce(new CdpError("session closed", "BROWSER_ERROR"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(
        'Script ran on page and returned:\n```json\n{"url":"https://test.com","status":200}\n```',
      );

    const page = createPageHelper(callTool);
    await page.open("https://test.com");

    expect(callTool).toHaveBeenCalledWith("new_page", {
      url: "https://test.com",
    });
  });

  it("does not fall back on non-recoverable errors", async () => {
    callTool.mockRejectedValueOnce(new CdpError("some other error", "TIMEOUT"));

    const page = createPageHelper(callTool);
    await expect(page.open("https://test.com")).rejects.toThrow(
      "some other error",
    );
  });
});

// --- 8. page.snapshot strips wrapper headers ---

describe("page.snapshot header stripping", () => {
  it("strips MCP preamble from snapshot", async () => {
    callTool.mockResolvedValueOnce(
      'Page snapshot captured.\n\n## Latest page snapshot\n\nRootWebArea "Hi"\n  uid=1 button "OK"',
    );

    const page = createPageHelper(callTool);
    const snap = await page.snapshot();

    expect(snap).toMatch(/^RootWebArea/);
    expect(snap).not.toContain("Latest page snapshot");
    expect(snap).not.toContain("Page snapshot captured");
  });
});

// --- 9. page.eval string and function both work ---

describe("page.eval variants", () => {
  it("wraps string expression in arrow function", async () => {
    callTool.mockResolvedValueOnce(
      "Script ran on page and returned:\n```json\ntrue\n```",
    );

    const page = createPageHelper(callTool);
    await page.eval("true");

    expect(callTool).toHaveBeenCalledWith("evaluate_script", {
      function: "() => (true)",
    });
  });

  it("serializes function argument", async () => {
    callTool.mockResolvedValueOnce(
      "Script ran on page and returned:\n```json\n[]\n```",
    );

    const page = createPageHelper(callTool);
    await page.eval(() => []);

    const fn = callTool.mock.calls[0][1].function;
    expect(fn).toContain("() => []");
  });
});

// --- 10. isUidRef detection ---

describe("isUidRef", () => {
  it("recognizes @-prefixed numeric refs", () => {
    expect(isUidRef("@12")).toBe(true);
    expect(isUidRef("@1_3")).toBe(true);
    expect(isUidRef("@26_181")).toBe(true);
  });

  it("recognizes bare numeric refs", () => {
    expect(isUidRef("5")).toBe(true);
    expect(isUidRef("26_181")).toBe(true);
  });

  it("rejects CSS selectors", () => {
    expect(isUidRef(".button")).toBe(false);
    expect(isUidRef("#main")).toBe(false);
    expect(isUidRef("a[href='/wiki']")).toBe(false);
    expect(isUidRef("input[name='q']")).toBe(false);
    expect(isUidRef("div > span")).toBe(false);
    expect(isUidRef("button.primary")).toBe(false);
  });
});

// --- 11. page.open returns { url, status } ---

describe("page.open return value", () => {
  it("returns url and status from navigation", async () => {
    callTool
      .mockResolvedValueOnce("") // navigate_page
      .mockResolvedValueOnce(
        'Script ran on page and returned:\n```json\n{"url":"https://example.com/","status":200}\n```',
      );

    const page = createPageHelper(callTool);
    const result = await page.open("https://example.com");

    expect(result.url).toBe("https://example.com/");
    expect(result.status).toBe(200);
  });

  it("returns 404 status", async () => {
    callTool
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(
        'Script ran on page and returned:\n```json\n{"url":"https://httpbin.org/status/404","status":404}\n```',
      );

    const page = createPageHelper(callTool);
    const result = await page.open("https://httpbin.org/status/404");

    expect(result.status).toBe(404);
  });

  it("returns null status when performance API unavailable", async () => {
    callTool
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(
        'Script ran on page and returned:\n```json\n{"url":"https://example.com","status":null}\n```',
      );

    const page = createPageHelper(callTool);
    const result = await page.open("https://example.com");

    expect(result.status).toBeNull();
  });
});
