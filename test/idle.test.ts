import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdleTracker,
  MIN_IDLE_TIMEOUT_MS,
  resolveIdleTimeoutMs,
} from "../src/idle.js";

describe("resolveIdleTimeoutMs", () => {
  // The default argument reads the real environment, so a developer who
  // followed the README and exported CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS
  // globally must not see the `undefined` case pick that value up.
  let savedIdleTimeout: string | undefined;

  beforeEach(() => {
    savedIdleTimeout = process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (savedIdleTimeout === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = savedIdleTimeout;
    }
  });

  it("reads CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS when no value is passed", () => {
    process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS = "1800000";
    expect(resolveIdleTimeoutMs()).toBe(1_800_000);
  });

  it("leaves idle shutdown off unless a positive integer is configured", () => {
    for (const raw of [
      undefined,
      "",
      "   ",
      "0",
      "30m",
      "1e6",
      "-5",
      "1.5",
      "99999999999999999999",
    ]) {
      expect(resolveIdleTimeoutMs(raw), String(raw)).toBe(0);
    }
  });

  it("returns a configured timeout, trimmed", () => {
    expect(resolveIdleTimeoutMs("1800000")).toBe(1_800_000);
    expect(resolveIdleTimeoutMs(" 60000 ")).toBe(60_000);
  });

  it("raises a timeout below the floor to the floor", () => {
    expect(resolveIdleTimeoutMs("1")).toBe(MIN_IDLE_TIMEOUT_MS);
  });
});

describe("createIdleTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shuts down once, after the timeout with no requests", () => {
    const onIdle = vi.fn();
    createIdleTracker(1_000, onIdle);

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("restarts the full timeout when an activity request ends", () => {
    const onIdle = vi.fn();
    const idle = createIdleTracker(1_000, onIdle);

    vi.advanceTimersByTime(900);
    idle.begin()(true);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not let a non-activity request renew the timeout", () => {
    const onIdle = vi.fn();
    const idle = createIdleTracker(1_000, onIdle);

    vi.advanceTimersByTime(900);
    idle.begin()(false);
    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("defers shutdown while a request is in flight across the deadline", () => {
    const onIdle = vi.fn();
    const idle = createIdleTracker(1_000, onIdle);

    const end = idle.begin();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
    end(true);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("shuts down promptly when a non-activity request ends past the deadline", () => {
    const onIdle = vi.fn();
    const idle = createIdleTracker(1_000, onIdle);

    const end = idle.begin();
    vi.advanceTimersByTime(5_000);
    end(false);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("waits for every overlapping request, and counts each end once", () => {
    const onIdle = vi.fn();
    const idle = createIdleTracker(1_000, onIdle);

    const endFirst = idle.begin();
    const endSecond = idle.begin();
    endFirst(false);
    endFirst(false);
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
    endSecond(false);
    vi.advanceTimersByTime(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not shut down early for a timeout beyond setTimeout's 32-bit limit", () => {
    const onIdle = vi.fn();
    const timeoutMs = 2 ** 31 + 60_000;
    createIdleTracker(timeoutMs, onIdle);

    vi.advanceTimersByTime(timeoutMs - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
