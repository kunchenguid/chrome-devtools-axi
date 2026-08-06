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

export function readSessionIdleTimeoutPolicy(
  nowMs = Date.now(),
): number | undefined {
  try {
    const file = policyFile();
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      timeoutMs?: unknown;
      expiresAt?: unknown;
    };
    if (
      !Number.isInteger(parsed.timeoutMs) ||
      (parsed.timeoutMs as number) < 1000 ||
      !Number.isFinite(parsed.expiresAt) ||
      (parsed.expiresAt as number) <= nowMs
    ) {
      clearSessionIdleTimeoutPolicy();
      return undefined;
    }
    return parsed.timeoutMs as number;
  } catch {
    return undefined;
  }
}

export function writeSessionIdleTimeoutPolicy(
  timeoutMs: number,
  nowMs = Date.now(),
): void {
  const file = policyFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ timeoutMs, expiresAt: nowMs + timeoutMs }),
  );
}

export function clearSessionIdleTimeoutPolicy(): void {
  const file = policyFile();
  if (existsSync(file)) unlinkSync(file);
}
