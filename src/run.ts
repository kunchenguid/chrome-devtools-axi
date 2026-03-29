/**
 * Script runner for `chrome-devtools-axi run`.
 *
 * Reads a script from stdin, provides a minimal `page` global, and executes it.
 * Only the script's own console.log output is visible to the caller.
 */

import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CdpError } from "./client.js";

type CallTool = (name: string, args?: Record<string, unknown>) => Promise<string>;

// --- Value parsing ---

/** Extract the actual JS value from MCP evaluate_script response wrapper. */
export function parseEvalOutput(output: string): unknown {
  const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch {
      return jsonBlock[1].trim();
    }
  }
  const preamble = "Script ran on page and returned:";
  if (output.includes(preamble)) {
    const raw = output.slice(output.indexOf(preamble) + preamble.length).trim();
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return output.trim();
}

/** Strip MCP preamble/headers from snapshot text, returning just the accessibility tree. */
function stripSnapshotHeader(text: string): string {
  const lines = text.split("\n");
  const treeStart = lines.findIndex((l) => /\bRootWebArea\b|\buid=/.test(l));
  if (treeStart > 0) return lines.slice(treeStart).join("\n");
  return text.replace(/^[\s\S]*?##\s+Latest page snapshot\s*\n/, "");
}

/** Strip leading @ from uid ref string. */
function parseUid(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/** Check if an open error is recoverable by falling back to new_page. */
function isRecoverableOpenError(error: unknown): boolean {
  if (!(error instanceof CdpError)) return false;
  if (error.code !== "BROWSER_ERROR") return false;
  return /not connected|session (?:closed|not found)|no page/i.test(error.message);
}

// --- Selector detection ---

const UID_RE = /^@?\d[\d_]*$/;

/** Returns true when the string looks like a @uid ref (e.g. "@12", "26_181"). */
export function isUidRef(s: string): boolean {
  return UID_RE.test(s);
}

const DEFAULT_WAIT_TIMEOUT = 30_000;

// --- Page helper ---

export interface OpenResult {
  url: string;
  status: number | null;
}

export interface PageHelper {
  open(url: string): Promise<OpenResult>;
  eval(jsOrFn: string | ((...args: unknown[]) => unknown)): Promise<unknown>;
  wait(ms: number): Promise<void>;
  wait(selector: string, timeout?: number): Promise<void>;
  snapshot(): Promise<string>;
  click(refOrSelector: string): Promise<void>;
  fill(refOrSelector: string, text: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  back(): Promise<void>;
}

export function createPageHelper(callTool: CallTool): PageHelper {
  /** Run JS in the page and return the parsed value. */
  async function evalJs(code: string): Promise<unknown> {
    const output = await callTool("evaluate_script", { function: code });
    return parseEvalOutput(output);
  }

  return {
    async open(url: string): Promise<OpenResult> {
      if (!url) {
        throw new CdpError("Missing URL", "VALIDATION_ERROR", [
          'Start with `await page.open("https://example.com")`',
        ]);
      }
      try {
        await callTool("navigate_page", { type: "url", url });
      } catch (error) {
        if (!isRecoverableOpenError(error)) throw error;
        await callTool("new_page", { url });
      }
      const info = await evalJs(
        `() => ({ url: location.href, status: performance.getEntriesByType('navigation').pop()?.responseStatus ?? null })`,
      );
      const result = info as Record<string, unknown>;
      return {
        url: String(result?.url ?? url),
        status: typeof result?.status === "number" ? result.status : null,
      };
    },

    async eval(jsOrFn: string | ((...args: unknown[]) => unknown)): Promise<unknown> {
      const fn =
        typeof jsOrFn === "function"
          ? String(jsOrFn)
          : `() => (${jsOrFn.trim()})`;
      return evalJs(fn);
    },

    async wait(msOrSelector: number | string, timeout?: number): Promise<void> {
      if (typeof msOrSelector === "number") {
        await callTool("evaluate_script", {
          function: `new Promise(r => setTimeout(r, ${msOrSelector}))`,
        });
      } else {
        const ms = timeout ?? DEFAULT_WAIT_TIMEOUT;
        const sel = JSON.stringify(msOrSelector);
        await callTool("evaluate_script", {
          function: `new Promise((resolve, reject) => {
  const sel = ${sel};
  if (document.querySelector(sel)) { resolve(); return; }
  const observer = new MutationObserver(() => {
    if (document.querySelector(sel)) {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
  });
  const timer = setTimeout(() => {
    observer.disconnect();
    reject(new Error('Timeout waiting for: ' + sel));
  }, ${ms});
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
})`,
        });
      }
    },

    async snapshot(): Promise<string> {
      const result = await callTool("take_snapshot");
      return stripSnapshotHeader(result);
    },

    async click(refOrSelector: string): Promise<void> {
      if (isUidRef(refOrSelector)) {
        await callTool("click", { uid: parseUid(refOrSelector) });
      } else {
        const sel = JSON.stringify(refOrSelector);
        await callTool("evaluate_script", {
          function: `(() => {
  const el = document.querySelector(${sel});
  if (!el) throw new Error('Element not found: ' + ${sel});
  el.scrollIntoView({ block: 'center' });
  el.click();
})()`,
        });
      }
    },

    async fill(refOrSelector: string, text: string): Promise<void> {
      if (isUidRef(refOrSelector)) {
        await callTool("fill", { uid: parseUid(refOrSelector), value: text });
      } else {
        const sel = JSON.stringify(refOrSelector);
        const val = JSON.stringify(text);
        await callTool("evaluate_script", {
          function: `(() => {
  const el = document.querySelector(${sel});
  if (!el) throw new Error('Element not found: ' + ${sel});
  el.focus();
  el.value = ${val};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`,
        });
      }
    },

    async type(text: string): Promise<void> {
      await callTool("type_text", { text });
    },

    async press(key: string): Promise<void> {
      await callTool("press_key", { key });
    },

    async back(): Promise<void> {
      await callTool("navigate_page", { type: "back" });
    },
  };
}

// --- Script runner ---

export interface RunResult {
  stdout: string;
}

/** Read all of stdin into a string. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runScript(
  content: string,
  callTool: CallTool,
): Promise<RunResult> {
  const page = createPageHelper(callTool);

  // Write to a temp .mjs so dynamic import supports top-level await
  const tmpDir = mkdtempSync(join(tmpdir(), "cda-run-"));
  const tmpFile = join(tmpDir, "script.mjs");
  writeFileSync(tmpFile, content, "utf-8");

  // Capture console.log output from the script
  const lines: string[] = [];
  const origLog = console.log;
  const captureLog = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  // Inject page global and capture console
  const prevPage = (globalThis as Record<string, unknown>).page;
  (globalThis as Record<string, unknown>).page = page;
  console.log = captureLog;

  try {
    const mod = await import(tmpFile);

    // Support optional default export function
    if (typeof mod.default === "function") {
      await mod.default();
    }
  } finally {
    console.log = origLog;
    if (prevPage === undefined) {
      delete (globalThis as Record<string, unknown>).page;
    } else {
      (globalThis as Record<string, unknown>).page = prevPage;
    }
    // Clean up temp file
    try { unlinkSync(tmpFile); rmdirSync(tmpDir); } catch { /* best effort */ }
  }

  const stdout = lines.length > 0 ? lines.join("\n") + "\n" : "";
  return { stdout };
}
