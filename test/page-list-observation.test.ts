import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPageListObservation,
  consumePageListObservation,
  createPageListObservation,
  observationListsPage,
  pageMatchesObservation,
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
    expect(pageMatchesObservation(PAGES, first!, 1)).toBe(true);
    expect(second).toBeNull();
  });

  it("revokes the previous token when its replacement cannot be written", () => {
    const stateDir = resolveSessionStateDir();
    const firstToken = recordPageListObservation(PAGES);
    expect(firstToken).not.toBeNull();

    chmodSync(stateDir, 0o500);
    try {
      expect(
        recordPageListObservation([
          ...PAGES,
          { id: 2, url: "https://new.example/", selected: false },
        ]),
      ).toBeNull();
    } finally {
      chmodSync(stateDir, 0o700);
    }

    expect(consumePageListObservation()).toBeNull();
  });

  it("binds only the target id to its observed URL", () => {
    const observed = createPageListObservation(PAGES);

    expect(observationListsPage(observed, 1)).toBe(true);
    expect(observationListsPage(observed, 2)).toBe(false);
    expect(pageMatchesObservation(PAGES, observed, 1)).toBe(true);
    expect(
      pageMatchesObservation(
        [
          { ...PAGES[0], url: "https://changed.example/" },
          PAGES[1],
          { id: 2, url: "https://new.example/", selected: false },
        ],
        observed,
        1,
      ),
    ).toBe(true);
    expect(
      pageMatchesObservation(
        [PAGES[0], { ...PAGES[1], url: "https://changed.example/" }],
        observed,
        1,
      ),
    ).toBe(false);
    expect(pageMatchesObservation([{ ...PAGES[1], id: 0 }], observed, 0)).toBe(
      false,
    );
    expect(pageMatchesObservation(PAGES.slice(0, 1), observed, 1)).toBe(false);
  });

  it("consumes malformed state without authorizing a close", () => {
    const stateDir = resolveSessionStateDir();
    recordPageListObservation(PAGES);
    writeFileSync(
      join(stateDir, "page-list-observation.json"),
      JSON.stringify({
        version: 1,
        token: "00000000-0000-0000-0000-000000000000",
        pages: { "0": "not-a-digest" },
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

  it("invalidates an unconsumed token when its directory is read-only", () => {
    const stateDir = resolveSessionStateDir();
    recordPageListObservation(PAGES);

    chmodSync(stateDir, 0o500);
    try {
      expect(clearPageListObservation()).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700);
    }

    expect(consumePageListObservation()).toBeNull();
  });
});
