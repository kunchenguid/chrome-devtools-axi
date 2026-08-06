import {
  existsSync,
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

type LockSnapshot = {
  dev: number;
  ino: number;
  isDirectory: boolean;
  mtimeMs: number;
  owner: LockOwner | undefined;
};

type ReclaimClaim = {
  dev: number;
  ino: number;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
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

function readLockSnapshot(lockPath: string): LockSnapshot | undefined {
  try {
    const stat = lstatSync(lockPath);
    const ownerPath = stat.isDirectory() ? `${lockPath}/owner` : lockPath;
    let owner: LockOwner | undefined;
    try {
      owner = parseOwner(readFileSync(ownerPath, "utf-8"));
    } catch {}
    return {
      dev: stat.dev,
      ino: stat.ino,
      isDirectory: stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      owner,
    };
  } catch {
    return undefined;
  }
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  return readLockSnapshot(lockPath)?.owner;
}

function sameFileIdentity(
  snapshot: LockSnapshot | undefined,
  expected: ReclaimClaim,
): boolean {
  return snapshot?.dev === expected.dev && snapshot.ino === expected.ino;
}

function isStaleSnapshot(
  snapshot: LockSnapshot,
  isAlive: (pid: number) => boolean,
): boolean {
  if (snapshot.owner) return !isAlive(snapshot.owner.pid);
  return (
    snapshot.isDirectory && Date.now() - snapshot.mtimeMs > LEGACY_STALE_LOCK_MS
  );
}

function readReclaimClaim(path: string): ReclaimClaim | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      dev?: unknown;
      ino?: unknown;
    };
    if (typeof parsed.dev !== "number" || typeof parsed.ino !== "number") {
      return undefined;
    }
    return { dev: parsed.dev, ino: parsed.ino };
  } catch {
    return undefined;
  }
}

function publishReclaimClaim(
  reclaimPath: string,
  snapshot: LockSnapshot,
): void {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const candidatePath = `${reclaimPath}.${token}`;
  try {
    writeFileSync(
      candidatePath,
      JSON.stringify({ dev: snapshot.dev, ino: snapshot.ino }),
      { flag: "wx", mode: 0o600 },
    );
    try {
      linkSync(candidatePath, reclaimPath);
    } catch {}
  } finally {
    try {
      unlinkSync(candidatePath);
    } catch {}
  }
}

export function removeStalePidFileLock(
  lockPath: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): void {
  try {
    const snapshot = readLockSnapshot(lockPath);
    if (!snapshot || !isStaleSnapshot(snapshot, isAlive)) return;

    const reclaimPath = `${lockPath}.reclaim`;
    publishReclaimClaim(reclaimPath, snapshot);
    const claim = readReclaimClaim(reclaimPath);
    if (!claim) return;

    const current = readLockSnapshot(lockPath);
    if (
      sameFileIdentity(current, claim) &&
      current !== undefined &&
      isStaleSnapshot(current, isAlive)
    ) {
      rmSync(lockPath, { recursive: true, force: true });
    }

    if (!sameFileIdentity(readLockSnapshot(lockPath), claim)) {
      try {
        unlinkSync(reclaimPath);
      } catch {}
    }
  } catch {}
}

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return left?.pid === right.pid && left.token === right.token;
}

export function withPidFileLock<T>(pidFile: string, action: () => T): T {
  const lockPath = `${pidFile}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
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
        if (existsSync(reclaimPath)) {
          if (sameOwner(readLockOwner(lockPath), owner)) {
            unlinkSync(lockPath);
          }
          Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
          continue;
        }
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
