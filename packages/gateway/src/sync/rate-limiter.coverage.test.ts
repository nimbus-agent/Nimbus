/**
 * `ProviderRateLimiter` arms `rate-limiter.test.ts` does not reach:
 *  - a provider id with no bucket (the type says it cannot happen; a connector's service id is a
 *    runtime string, so it can), on all three entry points;
 *  - a quota override that sets only ONE of its two fields — the other must fall back to the
 *    provider's default, not to `undefined`.
 *
 * Every timing assertion runs on an injected clock. The only real timer is one zero-delay yield in
 * the `penalise` case, which waits on nothing but the lock's microtasks and the runtime's
 * unhandled-rejection check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_QUOTAS,
  type Provider,
  type ProviderQuota,
  ProviderRateLimiter,
} from "./rate-limiter.ts";

const UNKNOWN = "not-a-provider" as Provider;

describe("a provider with no bucket", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  test("acquire and tryAcquire reject at once with the provider error, before taking any lock", async () => {
    const limiter = new ProviderRateLimiter(undefined, () => 0);
    await expect(limiter.acquire(UNKNOWN)).rejects.toThrow("Unknown rate-limit provider");
    await expect(limiter.tryAcquire(UNKNOWN)).rejects.toThrow("Unknown rate-limit provider");
  });

  test("penalise swallows it: no throw to the caller, no unhandled rejection, known providers unaffected", async () => {
    const limiter = new ProviderRateLimiter(undefined, () => 0);
    // penalise is fire-and-forget (its caller is a 429 handler mid-sync); the unknown-provider
    // failure happens INSIDE the per-provider lock, after the call has returned.
    expect(() => limiter.penalise(UNKNOWN, 1_000)).not.toThrow();
    expect(() => limiter.penalise(UNKNOWN, 2_000)).not.toThrow();
    // Let the lock's microtasks and the runtime's unhandled-rejection check both run. Filtered to
    // THIS failure, so a stray rejection from unrelated work in a shared test process cannot
    // flake the assertion.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ours = unhandled.filter((r) => String(r).includes("Unknown rate-limit provider"));
    expect(ours).toEqual([]);
    await expect(limiter.tryAcquire("github")).resolves.toBe(true);
  });
});

describe("a quota override that sets only one field", () => {
  test("burstSize alone: the refill rate stays the provider default", async () => {
    let now = 0;
    const override = { burstSize: 3 } as unknown as ProviderQuota;
    const limiter = new ProviderRateLimiter({ gitlab: override }, () => now);
    const msPerToken = 60_000 / DEFAULT_QUOTAS.gitlab.requestsPerMinute;

    await expect(limiter.tryAcquire("gitlab", 3)).resolves.toBe(true);
    await expect(limiter.tryAcquire("gitlab", 4)).rejects.toThrow("exceeds provider burstSize");
    await expect(limiter.tryAcquire("gitlab")).resolves.toBe(false);

    now = msPerToken - 1;
    await expect(limiter.tryAcquire("gitlab")).resolves.toBe(false);
    now = msPerToken;
    await expect(limiter.tryAcquire("gitlab")).resolves.toBe(true);
  });

  test("requestsPerMinute alone: the bucket size stays the provider default", async () => {
    let now = 0;
    const override = { requestsPerMinute: 6 } as unknown as ProviderQuota;
    const limiter = new ProviderRateLimiter({ github: override }, () => now);
    const burst = DEFAULT_QUOTAS.github.burstSize;

    await expect(limiter.tryAcquire("github", burst + 1)).rejects.toThrow(
      "exceeds provider burstSize",
    );
    await expect(limiter.tryAcquire("github", burst)).resolves.toBe(true);
    await expect(limiter.tryAcquire("github")).resolves.toBe(false);

    // 6 requests/minute = one token every 10 s — the OVERRIDDEN rate, not github's default 83.
    now = 9_999;
    await expect(limiter.tryAcquire("github")).resolves.toBe(false);
    now = 10_000;
    await expect(limiter.tryAcquire("github")).resolves.toBe(true);
  });
});
