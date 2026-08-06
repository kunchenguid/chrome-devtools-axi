import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeStalePidFileLock, withPidFileLock } from "../src/pid-file.js";

describe("PID file locking", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes a complete owner atomically and removes only its own lock", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-pid-lock-"));
    roots.push(root);
    const pidFile = join(root, "bridge.pid");
    const lockPath = `${pidFile}.lock`;

    withPidFileLock(pidFile, () => {
      const owner = JSON.parse(readFileSync(lockPath, "utf-8")) as {
        pid: number;
        token: string;
      };
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).not.toBe("");
    });

    expect(existsSync(lockPath)).toBe(false);
  });

  it("never age-evicts a lock whose owner is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-live-pid-lock-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "live-owner" }),
    );
    utimesSync(lockPath, new Date(0), new Date(0));

    removeStalePidFileLock(lockPath);

    expect(existsSync(lockPath)).toBe(true);
  });

  it("retains an old directory lock with a live numeric owner", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-live-legacy-pid-lock-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), String(process.pid));
    utimesSync(lockPath, new Date(0), new Date(0));

    removeStalePidFileLock(lockPath);

    expect(existsSync(lockPath)).toBe(true);
  });

  it("reclaims an old directory lock with a dead numeric owner", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-dead-legacy-pid-lock-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), "99999999");

    removeStalePidFileLock(lockPath);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims an old ownerless legacy directory", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-ownerless-legacy-lock-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    mkdirSync(lockPath);
    utimesSync(lockPath, new Date(0), new Date(0));

    removeStalePidFileLock(lockPath);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not remove a replacement installed during stale-owner recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-replaced-pid-lock-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, token: "stale-owner" }),
    );

    removeStalePidFileLock(lockPath, () => {
      rmSync(lockPath);
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token: "replacement-owner" }),
      );
      return false;
    });

    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual({
      pid: process.pid,
      token: "replacement-owner",
    });
  });

  it("recovers an orphaned reclaimer lease before admitting a writer", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-orphaned-reclaim-"));
    roots.push(root);
    const pidFile = join(root, "bridge.pid");
    const lockPath = `${pidFile}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, token: "stale-owner" }),
    );
    const stale = lstatSync(lockPath);
    writeFileSync(
      reclaimPath,
      JSON.stringify({
        dev: stale.dev,
        ino: stale.ino,
        owner: { pid: 99999999, token: "dead-reclaimer" },
      }),
    );

    let entered = false;
    withPidFileLock(pidFile, () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(reclaimPath)).toBe(false);
  });

  it("does not join an active reclaimer lease", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-active-reclaim-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, token: "stale-owner" }),
    );
    const stale = lstatSync(lockPath);
    writeFileSync(
      reclaimPath,
      JSON.stringify({
        dev: stale.dev,
        ino: stale.ino,
        owner: { pid: process.pid, token: "active-reclaimer" },
      }),
    );

    removeStalePidFileLock(lockPath);

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(reclaimPath)).toBe(true);
  });

  it("does not unlink another contender's takeover anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-reclaim-takeover-"));
    roots.push(root);
    const lockPath = join(root, "bridge.pid.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, token: "stale-owner" }),
    );
    const staleLock = lstatSync(lockPath);
    writeFileSync(
      reclaimPath,
      JSON.stringify({
        dev: staleLock.dev,
        ino: staleLock.ino,
        owner: { pid: 99999999, token: "dead-reclaimer" },
      }),
    );
    const staleReclaim = lstatSync(reclaimPath);
    const takeoverPath = `${reclaimPath}.takeover-${staleReclaim.dev}-${staleReclaim.ino}`;
    writeFileSync(
      takeoverPath,
      JSON.stringify({
        dev: staleLock.dev,
        ino: staleLock.ino,
        owner: { pid: process.pid, token: "winning-reclaimer" },
      }),
    );

    removeStalePidFileLock(lockPath);

    expect(existsSync(takeoverPath)).toBe(true);
    expect(existsSync(reclaimPath)).toBe(true);
  });
});
