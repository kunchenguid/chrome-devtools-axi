import {
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
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
  owner: LockOwner;
  predecessor?: ReclaimIdentity;
};

type ReclaimIdentity = {
  dev: number;
  ino: number;
  owner: LockOwner;
};

type ReclaimSnapshot = {
  dev: number;
  ino: number;
  claim: ReclaimClaim;
};

type ReclaimLease = {
  reclaimPath: string;
  anchorPath: string;
  claim: ReclaimClaim;
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
  expected: Pick<ReclaimClaim, "dev" | "ino">,
): boolean {
  return snapshot?.dev === expected.dev && snapshot.ino === expected.ino;
}

function samePathIdentity(leftPath: string, rightPath: string): boolean {
  try {
    const left = lstatSync(leftPath);
    const right = lstatSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
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

function readReclaimSnapshot(path: string): ReclaimSnapshot | undefined {
  try {
    const stat = lstatSync(path);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      dev?: unknown;
      ino?: unknown;
      owner?: Partial<LockOwner>;
      predecessor?: {
        dev?: unknown;
        ino?: unknown;
        owner?: Partial<LockOwner>;
      };
    };
    const predecessor = parsed.predecessor;
    if (
      typeof parsed.dev !== "number" ||
      typeof parsed.ino !== "number" ||
      !Number.isInteger(parsed.owner?.pid) ||
      (parsed.owner?.pid as number) <= 0 ||
      typeof parsed.owner?.token !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(parsed.owner.token) ||
      (predecessor !== undefined &&
        (typeof predecessor.dev !== "number" ||
          typeof predecessor.ino !== "number" ||
          !Number.isInteger(predecessor.owner?.pid) ||
          (predecessor.owner?.pid as number) <= 0 ||
          typeof predecessor.owner?.token !== "string" ||
          !/^[A-Za-z0-9_-]+$/.test(predecessor.owner.token)))
    ) {
      return undefined;
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      claim: {
        dev: parsed.dev,
        ino: parsed.ino,
        owner: {
          pid: parsed.owner.pid as number,
          token: parsed.owner.token,
        },
        predecessor:
          predecessor === undefined
            ? undefined
            : {
                dev: predecessor.dev as number,
                ino: predecessor.ino as number,
                owner: {
                  pid: predecessor.owner?.pid as number,
                  token: predecessor.owner?.token as string,
                },
              },
      },
    };
  } catch {
    return undefined;
  }
}

function sameReclaimTarget(
  left: ReclaimSnapshot,
  right: ReclaimSnapshot,
): boolean {
  return (
    left.claim.dev === right.claim.dev && left.claim.ino === right.claim.ino
  );
}

function sameReclaimIdentity(
  left: ReclaimSnapshot | undefined,
  right: ReclaimSnapshot,
): boolean {
  const leftPredecessor = left?.claim.predecessor;
  const rightPredecessor = right.claim.predecessor;
  return (
    left?.dev === right.dev &&
    left.ino === right.ino &&
    left.claim.dev === right.claim.dev &&
    left.claim.ino === right.claim.ino &&
    left.claim.owner.pid === right.claim.owner.pid &&
    left.claim.owner.token === right.claim.owner.token &&
    (leftPredecessor === undefined) === (rightPredecessor === undefined) &&
    (leftPredecessor === undefined ||
      (rightPredecessor !== undefined &&
        leftPredecessor.dev === rightPredecessor.dev &&
        leftPredecessor.ino === rightPredecessor.ino &&
        leftPredecessor.owner.pid === rightPredecessor.owner.pid &&
        leftPredecessor.owner.token === rightPredecessor.owner.token))
  );
}

function removeInheritedReclaimArtifacts(
  reclaimPath: string,
  snapshot: ReclaimSnapshot,
): void {
  const predecessor = snapshot.claim.predecessor;
  if (!predecessor) return;

  const predecessorCandidatePath = `${reclaimPath}.${predecessor.owner.token}`;
  const predecessorCandidate = readReclaimSnapshot(predecessorCandidatePath);
  if (
    predecessorCandidate?.dev === predecessor.dev &&
    predecessorCandidate.ino === predecessor.ino &&
    predecessorCandidate.claim.dev === snapshot.claim.dev &&
    predecessorCandidate.claim.ino === snapshot.claim.ino &&
    predecessorCandidate.claim.owner.pid === predecessor.owner.pid &&
    predecessorCandidate.claim.owner.token === predecessor.owner.token
  ) {
    try {
      unlinkSync(predecessorCandidatePath);
    } catch {}
  }

  const predecessorAnchorPath = `${reclaimPath}.takeover-${predecessor.dev}-${predecessor.ino}`;
  if (
    sameReclaimIdentity(readReclaimSnapshot(predecessorAnchorPath), snapshot)
  ) {
    try {
      unlinkSync(predecessorAnchorPath);
    } catch {}
  }
}

function removeReclaimCandidateAlias(
  reclaimPath: string,
  snapshot: ReclaimSnapshot,
): void {
  const candidatePath = `${reclaimPath}.${snapshot.claim.owner.token}`;
  if (sameFileIdentity(readLockSnapshot(candidatePath), snapshot)) {
    try {
      unlinkSync(candidatePath);
    } catch {}
  }
}

function removeReclaimAnchor(
  reclaimPath: string,
  anchorPath: string,
  snapshot: ReclaimSnapshot,
): void {
  removeReclaimCandidateAlias(reclaimPath, snapshot);
  if (sameReclaimIdentity(readReclaimSnapshot(anchorPath), snapshot)) {
    try {
      unlinkSync(anchorPath);
    } catch {}
  }
}

function publishReclaimClaim(
  reclaimPath: string,
  snapshot: LockSnapshot,
): ReclaimLease | undefined {
  const owner: LockOwner = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  const claim: ReclaimClaim = {
    dev: snapshot.dev,
    ino: snapshot.ino,
    owner,
  };
  const candidatePath = `${reclaimPath}.${owner.token}`;
  let published = false;
  try {
    writeFileSync(candidatePath, JSON.stringify(claim), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(candidatePath, reclaimPath);
      published = true;
    } catch {}
    if (!published) return undefined;
    return { reclaimPath, anchorPath: candidatePath, claim };
  } catch {
    return undefined;
  } finally {
    if (!published) {
      try {
        unlinkSync(candidatePath);
      } catch {}
    }
  }
}

function takeOverReclaimClaim(
  reclaimPath: string,
  stale: ReclaimSnapshot,
  isAlive: (pid: number) => boolean,
): ReclaimLease | undefined {
  if (isAlive(stale.claim.owner.pid)) return undefined;

  const owner: LockOwner = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  const claim: ReclaimClaim = {
    dev: stale.claim.dev,
    ino: stale.claim.ino,
    owner,
    predecessor: {
      dev: stale.dev,
      ino: stale.ino,
      owner: stale.claim.owner,
    },
  };
  const candidatePath = `${reclaimPath}.${owner.token}`;
  let predecessor = stale;
  let takeoverPath = "";
  let ownsTakeover = false;
  const staleAnchors: Array<{
    path: string;
    snapshot: ReclaimSnapshot;
  }> = [];
  const visited = new Set([`${stale.dev}:${stale.ino}`]);
  try {
    writeFileSync(candidatePath, JSON.stringify(claim), {
      flag: "wx",
      mode: 0o600,
    });
    while (!ownsTakeover) {
      takeoverPath = `${reclaimPath}.takeover-${predecessor.dev}-${predecessor.ino}`;
      try {
        linkSync(candidatePath, takeoverPath);
        ownsTakeover = true;
      } catch {
        const occupied = readReclaimSnapshot(takeoverPath);
        if (
          !occupied ||
          !sameReclaimTarget(occupied, stale) ||
          isAlive(occupied.claim.owner.pid)
        ) {
          return undefined;
        }
        const identity = `${occupied.dev}:${occupied.ino}`;
        if (visited.has(identity)) return undefined;
        visited.add(identity);
        staleAnchors.push({ path: takeoverPath, snapshot: occupied });
        predecessor = occupied;
      }
    }

    const current = readReclaimSnapshot(reclaimPath);
    if (
      !current ||
      !sameReclaimIdentity(current, stale) ||
      isAlive(current.claim.owner.pid)
    ) {
      return undefined;
    }

    removeInheritedReclaimArtifacts(reclaimPath, current);
    renameSync(candidatePath, reclaimPath);
    removeReclaimCandidateAlias(reclaimPath, stale);
    for (const anchor of staleAnchors.reverse()) {
      removeReclaimAnchor(reclaimPath, anchor.path, anchor.snapshot);
    }
    return { reclaimPath, anchorPath: takeoverPath, claim };
  } catch {
    return undefined;
  } finally {
    if (ownsTakeover && !samePathIdentity(reclaimPath, takeoverPath)) {
      try {
        unlinkSync(takeoverPath);
      } catch {}
    }
    try {
      unlinkSync(candidatePath);
    } catch {}
  }
}

function acquireReclaimLease(
  reclaimPath: string,
  snapshot: LockSnapshot,
  isAlive: (pid: number) => boolean,
): ReclaimLease | undefined {
  const existing = readReclaimSnapshot(reclaimPath);
  if (existing) return takeOverReclaimClaim(reclaimPath, existing, isAlive);
  return publishReclaimClaim(reclaimPath, snapshot);
}

function releaseReclaimLease(lease: ReclaimLease): void {
  if (samePathIdentity(lease.reclaimPath, lease.anchorPath)) {
    try {
      unlinkSync(lease.reclaimPath);
    } catch {}
  }
  try {
    unlinkSync(lease.anchorPath);
  } catch {}
}

/**
 * Reclaim only the stale lock generation named by a filesystem-identity
 * lease. The fixed device/inode claim prevents a delayed reclaimer from
 * deleting a replacement generation, and writers yield while that lease is
 * published. Takeover anchors are owner-and-inode identified: a live anchor is
 * removed only by the contender that published it, while dead-owner recovery
 * follows only same-target anchors through a chain bounded by inode-identity
 * cycle detection. Ownerless directories are age-reclaimed solely for
 * compatibility with the legacy mkdir-then-write lock format.
 */
export function removeStalePidFileLock(
  lockPath: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): void {
  try {
    const reclaimPath = `${lockPath}.reclaim`;
    const snapshot = readLockSnapshot(lockPath);
    const existing = readReclaimSnapshot(reclaimPath);
    let lease: ReclaimLease | undefined;
    if (existing) {
      lease = takeOverReclaimClaim(reclaimPath, existing, isAlive);
    } else {
      if (!snapshot || !isStaleSnapshot(snapshot, isAlive)) return;
      lease = acquireReclaimLease(reclaimPath, snapshot, isAlive);
    }

    if (!lease) return;

    try {
      const current = readLockSnapshot(lockPath);
      if (
        sameFileIdentity(current, lease.claim) &&
        current !== undefined &&
        isStaleSnapshot(current, isAlive) &&
        samePathIdentity(reclaimPath, lease.anchorPath)
      ) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } finally {
      releaseReclaimLease(lease);
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
        if (readReclaimSnapshot(reclaimPath)) {
          if (sameOwner(readLockOwner(lockPath), owner)) {
            unlinkSync(lockPath);
          }
          removeStalePidFileLock(lockPath);
          if (Date.now() >= deadline) {
            throw new Error(`Timed out acquiring PID file lock: ${lockPath}`);
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
