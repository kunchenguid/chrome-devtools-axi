/**
 * One-shot proof that `closepage <id>` still refers to the page list the
 * caller most recently inspected with `pages`.
 *
 * Page ids from chrome-devtools-mcp are positional and can be reissued after a
 * tab closes or the browser reconnects. A short-lived CLI process cannot keep
 * an in-memory identity, so `pages` records each listed id with a digest of
 * its URL in the active session directory. `closepage` atomically consumes
 * that observation, re-lists the pages, and closes only when the target id
 * still shows the URL it had in that listing; unrelated tabs may change. One
 * observation authorizes at most one close.
 *
 * Only SHA-256 digests are persisted: page URLs can contain credentials or
 * other private fragments and must not be written to the state directory.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PageListEntry } from "./pages.js";
import { resolveSessionStateDir } from "./sessions.js";

export type PageListObservation = {
  version: 1;
  token: string;
  /** Page id -> SHA-256 digest of the URL listed for that id. */
  pages: Record<string, string>;
};

function observationFile(): string {
  return join(resolveSessionStateDir(), "page-list-observation.json");
}

function pageUrlDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function createPageListObservation(
  pages: readonly PageListEntry[],
  token: string = randomUUID(),
): PageListObservation {
  return {
    version: 1,
    token,
    pages: Object.fromEntries(
      pages.map(({ id, url }) => [String(id), pageUrlDigest(url)]),
    ),
  };
}

function parseObservation(raw: string): PageListObservation | null {
  try {
    const value = JSON.parse(raw) as Partial<PageListObservation>;
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.token) ||
      typeof value.pages !== "object" ||
      value.pages === null ||
      Array.isArray(value.pages) ||
      !Object.entries(value.pages).every(
        ([id, digest]) =>
          /^\d+$/.test(id) &&
          typeof digest === "string" &&
          /^[a-f0-9]{64}$/.test(digest),
      )
    ) {
      return null;
    }
    return value as PageListObservation;
  } catch {
    return null;
  }
}

/** Persist the last explicit `pages` result. Returns null on any write failure. */
export function recordPageListObservation(
  pages: readonly PageListEntry[],
): string | null {
  const file = observationFile();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const observation = createPageListObservation(pages);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(observation), {
      mode: 0o600,
    });
    renameSync(temp, file);
    return observation.token;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best effort only; the false return keeps closepage fail-closed.
    }
    return null;
  }
}

/**
 * Atomically claim and consume the last explicit `pages` observation.
 * Concurrent close commands cannot both receive the same authorization.
 */
export function consumePageListObservation(): PageListObservation | null {
  const file = observationFile();
  const claimed = `${file}.${process.pid}.${randomUUID()}.claimed`;
  try {
    renameSync(file, claimed);
  } catch {
    return null;
  }
  try {
    return parseObservation(readFileSync(claimed, "utf-8"));
  } catch {
    return null;
  } finally {
    try {
      rmSync(claimed, { force: true });
    } catch {
      // The original authorization path is already gone, so a later close
      // cannot reuse it even if this private claim file survives cleanup.
    }
  }
}

/** True when `pageId` was part of the observed listing. */
export function observationListsPage(
  observation: PageListObservation,
  pageId: number,
): boolean {
  return Object.hasOwn(observation.pages, String(pageId));
}

/** True when `pageId` still shows the URL it had in the observed listing. */
export function pageMatchesObservation(
  pages: readonly PageListEntry[],
  observation: PageListObservation,
  pageId: number,
): boolean {
  return pages.some(
    (page) =>
      page.id === pageId &&
      pageUrlDigest(page.url) === observation.pages[String(pageId)],
  );
}

/** Invalidate any unconsumed observation after a browser/page mutation. */
export function clearPageListObservation(): boolean {
  const file = observationFile();
  try {
    if (existsSync(file)) rmSync(file);
  } catch {
    return false;
  }
  return !existsSync(file);
}
