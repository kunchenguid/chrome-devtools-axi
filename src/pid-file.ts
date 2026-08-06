import {
  linkSync,
  lstatSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const LEGACY_STALE_LOCK_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

type LockOwner = {
  pid: number;
  token: string;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseOwner(value: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
      return { pid: parsed, token: "legacy" };
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as Partial<LockOwner>).pid) &&
      ((parsed as Partial<LockOwner>).pid as number) > 0 &&
      typeof (parsed as Partial<LockOwner>).token === "string" &&
      ((parsed as Partial<LockOwner>).token as string).length > 0
    ) {
      return {
        pid: (parsed as Partial<LockOwner>).pid as number,
        token: (parsed as Partial<LockOwner>).token as string,
      };
    }
  } catch {
    const legacyPid = Number.parseInt(value, 10);
    if (!Number.isNaN(legacyPid) && legacyPid > 0) {
      return { pid: legacyPid, token: "legacy" };
    }
  }
  return undefined;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const stat = lstatSync(lockPath);
    const ownerPath = stat.isDirectory() ? `${lockPath}/owner` : lockPath;
    return parseOwner(readFileSync(ownerPath, "utf-8"));
  } catch {
    return undefined;
  }
}

export function removeStalePidFileLock(lockPath: string): void {
  try {
    const stat = lstatSync(lockPath);
    const owner = readLockOwner(lockPath);
    if (owner) {
      if (!processIsAlive(owner.pid)) {
        rmSync(lockPath, { recursive: true, force: true });
      }
      return;
    }

    // Current writers publish a fully populated lock file atomically. This
    // age check only migrates ownerless directories left by the older
    // mkdir-then-write implementation; a lock with a live owner is never
    // evicted merely because the machine slept or the holder was paused.
    if (
      stat.isDirectory() &&
      Date.now() - stat.mtimeMs > LEGACY_STALE_LOCK_MS
    ) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {}
}

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return left?.pid === right.pid && left.token === right.token;
}

export function withPidFileLock<T>(pidFile: string, action: () => T): T {
  const lockPath = `${pidFile}.lock`;
  const owner: LockOwner = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  const candidatePath = `${lockPath}.${owner.token}`;
  writeFileSync(candidatePath, JSON.stringify(owner), {
    flag: "wx",
    mode: 0o600,
  });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (true) {
      try {
        // The hard link publishes a complete owner record and acquires the
        // well-known lock path in one atomic filesystem operation.
        linkSync(candidatePath, lockPath);
        break;
      } catch (error) {
        removeStalePidFileLock(lockPath);
        if (Date.now() >= deadline) throw error;
        Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
      }
    }

    try {
      return action();
    } finally {
      if (sameOwner(readLockOwner(lockPath), owner)) {
        unlinkSync(lockPath);
      }
    }
  } finally {
    try {
      unlinkSync(candidatePath);
    } catch {}
  }
}
