import {
  existsSync,
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
});
