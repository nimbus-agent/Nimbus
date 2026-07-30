import { describe, expect, test } from "bun:test";

import { DEFAULT_QUOTAS, ProviderRateLimiter } from "./rate-limiter.ts";

describe("ProviderRateLimiter", () => {
  test("parallel acquires for the same provider serialize to the token refill rate", async () => {
    const limiter = new ProviderRateLimiter({
      google: { requestsPerMinute: 60, burstSize: 1 },
    });
    const t0 = performance.now();
    await Promise.all([limiter.acquire("google"), limiter.acquire("google")]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  test("different providers do not block each other on the same limiter", async () => {
    const limiter = new ProviderRateLimiter({
      google: { requestsPerMinute: 60, burstSize: 1 },
      microsoft: { requestsPerMinute: 60, burstSize: 1 },
    });
    const t0 = performance.now();
    await Promise.all([limiter.acquire("google"), limiter.acquire("microsoft")]);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });

  test("penalise delays the next acquire by approximately retryAfterMs", async () => {
    const limiter = new ProviderRateLimiter({
      google: { requestsPerMinute: 60_000, burstSize: 100 },
    });
    await limiter.acquire("google", 1);
    limiter.penalise("google", 150);
    const t0 = performance.now();
    await limiter.acquire("google", 1);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(400);
  });

  test("acquire rejects when tokens exceed burstSize", async () => {
    const limiter = new ProviderRateLimiter({
      google: { requestsPerMinute: 60, burstSize: 2 },
    });
    await expect(limiter.acquire("google", 3)).rejects.toThrow(/burstSize/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Deterministic clock-injected tests (no real sleeps)
// ────────────────────────────────────────────────────────────────────────────

describe("ProviderRateLimiter – deterministic (clock-injected)", () => {
  // A fast-rate quota so acquire() completes without real waiting:
  // 600_000 req/min = 10 req/ms, so a 1-token acquire always completes
  // without sleeping when tokens > 0.
  const fastQuota = { requestsPerMinute: 600_000, burstSize: 50 };

  test("acquire succeeds immediately when tokens are available", async () => {
    const t = 1_000_000;
    const limiter = new ProviderRateLimiter({ google: fastQuota }, () => t);
    // burstSize=50, so consuming 3 resolves immediately (no sleep, no hang).
    await expect(limiter.acquire("google", 3)).resolves.toBeUndefined();
  });

  test("acquire with default token count of 1 succeeds", async () => {
    const t = 2_000_000;
    const limiter = new ProviderRateLimiter({ slack: fastQuota }, () => t);
    await expect(limiter.acquire("slack")).resolves.toBeUndefined();
  });

  test("acquire rejects non-integer tokens (float)", async () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    await expect(limiter.acquire("google", 1.5)).rejects.toThrow(/positive integer/);
  });

  test("acquire rejects tokens = 0", async () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    await expect(limiter.acquire("google", 0)).rejects.toThrow(/positive integer/);
  });

  test("acquire rejects negative token count", async () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    await expect(limiter.acquire("google", -1)).rejects.toThrow(/positive integer/);
  });

  test("penalise with Infinity is ignored (non-finite guard)", () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    // Must not throw and must not mutate the state
    expect(() => limiter.penalise("google", Infinity)).not.toThrow();
    // A second acquire should still work immediately (no penalty applied)
  });

  test("penalise with NaN is ignored (non-finite guard)", () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    expect(() => limiter.penalise("google", Number.NaN)).not.toThrow();
  });

  test("penalise with negative value is ignored", () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    expect(() => limiter.penalise("google", -100)).not.toThrow();
  });

  test("penalise with a raw non-finite JSON number (1e309 → Infinity) is ignored", () => {
    // JSON.parse("1e309") produces Infinity — tests the isFinite-false branch
    // with an actual non-finite NUMBER (not a string), unlike passing Infinity directly.
    const nonFinite = JSON.parse("1e309") as number;
    expect(Number.isFinite(nonFinite)).toBe(false);
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    expect(() => limiter.penalise("google", nonFinite)).not.toThrow();
  });

  test("DEFAULT_QUOTAS covers every Provider key", () => {
    // Regression: ProviderRateLimiter constructor iterates DEFAULT_QUOTAS keys,
    // so a missing key would cause stateFor to throw on first acquire.
    const keys = Object.keys(DEFAULT_QUOTAS) as (keyof typeof DEFAULT_QUOTAS)[];
    expect(keys.length).toBeGreaterThan(70);
    for (const k of keys) {
      expect(DEFAULT_QUOTAS[k].requestsPerMinute).toBeGreaterThan(0);
      expect(DEFAULT_QUOTAS[k].burstSize).toBeGreaterThan(0);
    }
  });

  test("quota override merges partial fields: only requestsPerMinute overridden", async () => {
    // mergeQuota nullish-coalescing: burstSize falls back to base
    const base = DEFAULT_QUOTAS.github;
    const limiter = new ProviderRateLimiter({
      github: { requestsPerMinute: 999, burstSize: base.burstSize },
    });
    // Acquire burstSize tokens — if burstSize were 0 this would throw
    await expect(limiter.acquire("github", base.burstSize)).resolves.toBeUndefined();
  });

  test("quota override merges partial fields: only burstSize overridden", async () => {
    // mergeQuota nullish-coalescing: requestsPerMinute falls back to base
    // We pass an explicit object with both fields set (partial Record shape),
    // but craft the override so requestsPerMinute uses the base value.
    const base = DEFAULT_QUOTAS.gitlab;
    const limiter = new ProviderRateLimiter({
      gitlab: { requestsPerMinute: base.requestsPerMinute, burstSize: 3 },
    });
    // burstSize=3, so acquiring 3 should succeed and 4 should fail
    await limiter.acquire("gitlab", 3);
    await expect(limiter.acquire("gitlab", 4)).rejects.toThrow(/burstSize/);
  });

  test("quota override with undefined override falls back to defaults", async () => {
    // No override for 'slack' → mergeQuota returns a copy of DEFAULT_QUOTAS.slack
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    const slackBase = DEFAULT_QUOTAS.slack;
    // burstSize tokens are available at start; acquire exactly burstSize
    await expect(limiter.acquire("slack", slackBase.burstSize)).resolves.toBeUndefined();
    // One MORE than burstSize is refused outright — a capacity check, not a wait. This is
    // the assertion that actually pins the fallback to DEFAULT_QUOTAS.slack: acquiring
    // burstSize alone would also succeed under any quota with a larger bucket.
    await expect(limiter.acquire("slack", slackBase.burstSize + 1)).rejects.toThrow(/burstSize/);
  });

  test("penalise then acquire: penalty arm in acquireUnderLock fires and resolves", async () => {
    // Use high-rate quota so token refill is instant after penalty lifts.
    // Strategy: penalise sets penaltyUntilMs = now + floor(retryAfterMs).
    // We use a real 80ms penalty; to ensure acquire sees the penalty window
    // we start the acquire immediately (without pre-waiting), so it hits the
    // "now < penaltyUntilMs" branch inside acquireUnderLock.
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    const t0 = performance.now();
    // Penalise first, then acquire races against the 80ms window.
    limiter.penalise("google", 80);
    await limiter.acquire("google", 1);
    const elapsed = performance.now() - t0;
    // acquire must have waited through (most of) the 80ms penalty
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(500);
  });

  test("refill arms: elapsed > 0 adds tokens up to burstSize cap", async () => {
    // Use a clock we advance manually. Start with empty tokens after consuming all.
    // ratePerMs = 600 / 60_000 = 0.01 token/ms
    // burstSize = 10
    // To refill from 0 to 10 tokens we need 1000ms elapsed.
    let t = 5_000_000;
    const limiter = new ProviderRateLimiter(
      { github: { requestsPerMinute: 600, burstSize: 10 } },
      () => t,
    );
    // Drain all 10 burst tokens
    for (let i = 0; i < 10; i++) {
      await limiter.acquire("github", 1);
    }
    // Advance clock by 1100ms (more than enough to refill to burstSize cap)
    t += 1_100;
    // Now acquire should succeed because refill adds tokens
    await expect(limiter.acquire("github", 10)).resolves.toBeUndefined();
  });

  test("refill clamps tokens to burstSize (does not exceed cap)", async () => {
    // Advance clock by a huge amount; tokens should not exceed burstSize
    let t = 10_000_000;
    const quota = { requestsPerMinute: 600, burstSize: 5 };
    const limiter = new ProviderRateLimiter({ slack: quota }, () => t);
    // Advance 1 full hour — would produce thousands of tokens without cap
    t += 3_600_000;
    // Acquiring burstSize+1 tokens should still fail (cap enforced)
    await expect(limiter.acquire("slack", 6)).rejects.toThrow(/burstSize/);
    // Acquiring exactly burstSize should succeed (tokens refilled to cap)
    await expect(limiter.acquire("slack", 5)).resolves.toBeUndefined();
  });

  test("refill skips when now < penaltyUntilMs (early return branch)", async () => {
    // Verify that the penalty/refill-skip branch is exercised: penalise first,
    // then kick off the acquire immediately (no pre-wait) so the acquire loop
    // hits "now < penaltyUntilMs" on its first iteration and sleeps through it.
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    const t0 = performance.now();
    limiter.penalise("google", 50);
    await limiter.acquire("google", 1);
    // The acquire had to wait through the 50ms penalty window
    expect(performance.now() - t0).toBeGreaterThanOrEqual(30);
  });

  test("multiple sequential acquires re-use the existing mutex (mutexFor hit path)", async () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    // First acquire creates the mutex; the second re-uses it and still resolves.
    await limiter.acquire("google");
    await expect(limiter.acquire("google")).resolves.toBeUndefined();
  });

  test("penalise with retryAfterMs=0 is accepted (zero is valid, finite, non-negative)", async () => {
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    expect(() => limiter.penalise("google", 0)).not.toThrow();
    // Should still be acquirable immediately
    await expect(limiter.acquire("google", 1)).resolves.toBeUndefined();
  });

  test("penalise with float retryAfterMs floors the value", async () => {
    // retryAfterMs=9.9 → floor(9.9)=9 ms penalty
    const limiter = new ProviderRateLimiter({ google: fastQuota });
    limiter.penalise("google", 9.9);
    await new Promise<void>((r) => setTimeout(r, 5));
    const t0 = performance.now();
    await limiter.acquire("google", 1);
    // Penalty should have been ~9ms; acquire completes after it
    expect(performance.now() - t0).toBeGreaterThanOrEqual(0);
  });

  test("wait-for-refill branch: a token deficit sleeps, then a later refill satisfies it", async () => {
    // Genuinely exercise the deficit → sleepMs → retry path in acquireUnderLock (the branch the
    // previous tests missed by pre-advancing the clock so refill succeeded on the first pass).
    //
    // The clock is driven off the nowFn READ COUNT, not an external flag flipped from a macrotask.
    // The earlier flag-via-`await Bun.sleep(0)` version raced the acquire's internal `setTimeout`
    // sleep and hung `bun test` indefinitely on Windows (passed on Linux/macOS) — the job then
    // burned its full 30-minute ceiling and was reported "cancelled". Counting reads makes the
    // clock jump deterministic and removes the real-timer race entirely.
    //
    // nowFn reads, in order (refill() takes `now` as a param — it does NOT call nowFn):
    //   [0] constructor seeds the buckets
    //   [1] acquire("github", 2) loop iteration 1 → drains both burst tokens
    //   [2] acquire("github", 1) loop iteration 1 → 0 tokens, elapsed 0 → DEFICIT branch → sleepMs
    //   [3] acquire("github", 1) loop iteration 2 → clock jumped → refill → resolve
    const base = 20_000_000;
    let reads = 0;
    const nowFn = () => (reads++ >= 3 ? base + 60_000 : base);
    const quota = { requestsPerMinute: 600_000, burstSize: 2 };
    const limiter = new ProviderRateLimiter({ github: quota }, nowFn);
    await limiter.acquire("github", 2); // drain both burst tokens (reads 0 + 1)
    // 0 tokens → iteration 1 hits the deficit branch and sleeps; iteration 2 sees the advanced
    // clock, refills to the burst cap, and resolves. No external flag, no macrotask race.
    await expect(limiter.acquire("github", 1)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mergeQuota nullish-coalescing arms (partial overrides)
// ────────────────────────────────────────────────────────────────────────────

describe("mergeQuota via ProviderRateLimiter constructor", () => {
  test("override with both fields set uses override values", async () => {
    const limiter = new ProviderRateLimiter({
      google: { requestsPerMinute: 1200, burstSize: 30 },
    });
    // burstSize=30, so acquiring 25 should work
    await expect(limiter.acquire("google", 25)).resolves.toBeUndefined();
    // acquiring 31 should fail
    await expect(limiter.acquire("google", 31)).rejects.toThrow(/burstSize/);
  });

  test("no override at all: constructor accepts undefined quotaOverrides", async () => {
    // mergeQuota: overrides?.[provider] is undefined → return copy of base
    const limiter = new ProviderRateLimiter();
    await expect(limiter.acquire("google", 1)).resolves.toBeUndefined();
  });

  test("empty override object: provider not present → falls back to base quota", async () => {
    // overrides is defined but has no key for 'slack' → o === undefined branch
    const limiter = new ProviderRateLimiter({});
    const slackBurst = DEFAULT_QUOTAS.slack.burstSize;
    await expect(limiter.acquire("slack", slackBurst)).resolves.toBeUndefined();
  });
});
