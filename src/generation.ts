/**
 * Snapshot generation persistence. The counter survives across CLI
 * invocations (which are short-lived processes sharing one bridge) by
 * writing to a file in STATE_DIR. Each new snapshot bumps the counter,
 * so refs minted in older snapshots can be detected as stale.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".chrome-devtools-axi");
const GEN_FILE = join(STATE_DIR, "snapshot-generation");

export function getCurrentGeneration(): number {
  try {
    if (!existsSync(GEN_FILE)) return 0;
    const parsed = Number.parseInt(readFileSync(GEN_FILE, "utf-8").trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

export function bumpGeneration(): number {
  const next = getCurrentGeneration() + 1;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(GEN_FILE, String(next));
  } catch {
    // Best-effort: a write failure still returns the bumped value so the
    // current invocation behaves consistently. The next process will
    // re-read the on-disk value (potentially the prior one) and the
    // worst case is one missed stale-ref detection, not a hang.
  }
  return next;
}

export function resetGeneration(): void {
  try {
    if (existsSync(GEN_FILE)) unlinkSync(GEN_FILE);
  } catch {
    // ignore
  }
}
