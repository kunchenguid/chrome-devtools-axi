import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock(lockDir: string): void {
  try {
    const ageMs = Date.now() - statSync(lockDir).mtimeMs;
    let owner: number | undefined;
    try {
      const parsed = Number.parseInt(
        readFileSync(`${lockDir}/owner`, "utf-8"),
        10,
      );
      if (!Number.isNaN(parsed)) owner = parsed;
    } catch {}
    if (
      (owner !== undefined && !processIsAlive(owner)) ||
      ageMs > STALE_LOCK_MS ||
      (owner === undefined && ageMs > LOCK_TIMEOUT_MS / 2)
    ) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {}
}

export function withPidFileLock<T>(pidFile: string, action: () => T): T {
  const lockDir = `${pidFile}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        writeFileSync(`${lockDir}/owner`, String(process.pid));
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      removeStaleLock(lockDir);
      if (Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
