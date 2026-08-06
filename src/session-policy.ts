import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

/**
 * Per-logical-session idle policy written by agent lifecycle integrations.
 * Keeping it beside the generation counter lets later short-lived CLI
 * processes inherit the policy without changing the direct CLI default.
 */
const POLICY_FILE = "agent-idle-timeout";

function policyFile(): string {
  return join(resolveSessionStateDir(), POLICY_FILE);
}

export function readSessionIdleTimeoutPolicy(): number | undefined {
  try {
    const value = Number(readFileSync(policyFile(), "utf-8").trim());
    return Number.isInteger(value) && value >= 1000 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionIdleTimeoutPolicy(timeoutMs: number): void {
  const file = policyFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(timeoutMs));
}

export function clearSessionIdleTimeoutPolicy(): void {
  const file = policyFile();
  if (existsSync(file)) unlinkSync(file);
}
