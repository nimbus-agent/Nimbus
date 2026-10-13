import { describe, expect, test } from "bun:test";

import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";

describe("CaptureAttemptLimiter", () => {
  test("allows cap attempts per window, then refuses until the oldest ages out", () => {
    const l = new CaptureAttemptLimiter(1000);
    expect(l.tryAcquire(0, 2)).toBe(true);
    expect(l.tryAcquire(10, 2)).toBe(true);
    expect(l.tryAcquire(20, 2)).toBe(false);
    expect(l.tryAcquire(999, 2)).toBe(false);
    expect(l.tryAcquire(1000, 2)).toBe(true); // attempt at 0 aged out (window is (now-1000, now])
  });

  test("a refused attempt does not consume a slot", () => {
    const l = new CaptureAttemptLimiter(1000);
    l.tryAcquire(0, 1);
    for (let i = 1; i < 50; i++) l.tryAcquire(i, 1);
    expect(l.tryAcquire(1000, 1)).toBe(true);
  });

  test("ONE window for the whole gateway — there is no per-connection key to reset", () => {
    const l = new CaptureAttemptLimiter(1000);
    expect(l.tryAcquire(0, 1)).toBe(true);
    // A reconnecting client is the same limiter instance; nothing in the API takes a client id.
    expect(l.tryAcquire(1, 1)).toBe(false);
  });
});

describe("CaptureRefusalCounter", () => {
  test("counts per code and snapshots a copy", () => {
    const c = new CaptureRefusalCounter();
    c.bump("ERR_CAPTURE_DISABLED");
    c.bump("ERR_CAPTURE_DISABLED");
    c.bump("ERR_CAPTURE_RATE_LIMITED");
    const s = c.snapshot();
    expect(s).toEqual({ ERR_CAPTURE_DISABLED: 2, ERR_CAPTURE_RATE_LIMITED: 1 });
    c.bump("ERR_CAPTURE_DISABLED");
    expect(s["ERR_CAPTURE_DISABLED"]).toBe(2);
  });
});
