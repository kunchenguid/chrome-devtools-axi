import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPageListObservation,
  consumePageListObservation,
  createPageListObservation,
  pageListMatchesObservation,
  recordPageListObservation,
} from "../src/page-list-observation.js";
import type { PageListEntry } from "../src/pages.js";
import { resolveSessionStateDir } from "../src/sessions.js";

const PAGES: PageListEntry[] = [
  { id: 0, url: "https://example.com/", selected: true },
  { id: 1, url: "https://other.example/path", selected: false },
];

describe("page-list close observation", () => {
  const savedHome = process.env.HOME;
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "axi-close-observation-"));
    process.env.HOME = home;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "safe-close";
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSession === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("persists a digest without leaking page URLs", () => {
    const token = recordPageListObservation(PAGES);
    expect(token).toMatch(/^[a-f0-9-]{36}$/);

    const raw = readFileSync(
      join(resolveSessionStateDir(), "page-list-observation.json"),
      "utf-8",
    );
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("other.example");
    expect(JSON.parse(raw)).toEqual(createPageListObservation(PAGES, token!));
  });

  it("atomically consumes one observation only once", () => {
    recordPageListObservation(PAGES);

    const first = consumePageListObservation();
    const second = consumePageListObservation();

    expect(first).not.toBeNull();
    expect(pageListMatchesObservation(PAGES, first!)).toBe(true);
    expect(second).toBeNull();
  });

  it("detects any id, URL, order or count change", () => {
    const observed = createPageListObservation(PAGES);

    expect(pageListMatchesObservation(PAGES, observed)).toBe(true);
    expect(
      pageListMatchesObservation(
        [
          { ...PAGES[0], id: 1 },
          { ...PAGES[1], id: 0 },
        ],
        observed,
      ),
    ).toBe(false);
    expect(
      pageListMatchesObservation(
        [{ ...PAGES[0], url: "https://changed.example/" }, PAGES[1]],
        observed,
      ),
    ).toBe(false);
    expect(pageListMatchesObservation([...PAGES].reverse(), observed)).toBe(
      false,
    );
    expect(pageListMatchesObservation(PAGES.slice(1), observed)).toBe(false);
  });

  it("consumes malformed state without authorizing a close", () => {
    const stateDir = resolveSessionStateDir();
    recordPageListObservation(PAGES);
    writeFileSync(
      join(stateDir, "page-list-observation.json"),
      JSON.stringify({
        version: 1,
        token: "00000000-0000-0000-0000-000000000000",
        count: 2,
        digest: "not-a-digest",
      }),
    );

    expect(consumePageListObservation()).toBeNull();
    expect(consumePageListObservation()).toBeNull();
  });

  it("clears an unconsumed observation", () => {
    recordPageListObservation(PAGES);
    expect(clearPageListObservation()).toBe(true);
    expect(consumePageListObservation()).toBeNull();
  });
});
