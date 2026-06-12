import { describe, expect, test } from "bun:test";
import { GithubStyleHeaders, NoopObserver, RetryAfterHeader } from "./rate-limit-observer.ts";

describe("GithubStyleHeaders", () => {
  test("reads X-RateLimit-Remaining and Reset", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Remaining", "3");
    h.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 30));
    const snap = obs.observe(h);
    expect(snap?.remaining).toBe(3);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now());
  });
  test("returns null snapshot if headers absent", () => {
    expect(new GithubStyleHeaders().observe(new Headers())).toBeNull();
  });
  test("falls back to lowercase x-ratelimit-remaining and x-ratelimit-reset", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    // Use lowercase header names so the ?? fallback branch is exercised
    h.set("x-ratelimit-remaining", "5");
    h.set("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 60));
    const snap = obs.observe(h);
    expect(snap?.remaining).toBe(5);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now());
  });
  test("returns null when only Remaining header is present (Reset absent)", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Remaining", "10");
    // Reset header deliberately omitted — triggers the rem !== null && reset === null branch
    expect(obs.observe(h)).toBeNull();
  });
  test("returns null when only Reset header is present (Remaining absent)", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 60));
    // Remaining header deliberately omitted
    expect(obs.observe(h)).toBeNull();
  });
  test("returns null when Remaining value is non-numeric (NaN)", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Remaining", "not-a-number");
    h.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 30));
    expect(obs.observe(h)).toBeNull();
  });
  test("returns null when Reset value is non-numeric (NaN)", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Remaining", "2");
    h.set("X-RateLimit-Reset", "invalid-reset");
    expect(obs.observe(h)).toBeNull();
  });
});

describe("RetryAfterHeader", () => {
  test("reads Retry-After seconds", () => {
    const h = new Headers();
    h.set("Retry-After", "60");
    const snap = new RetryAfterHeader().observe(h);
    expect(snap?.remaining).toBe(0);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now() + 50_000);
  });
  test("returns null when Retry-After header is absent", () => {
    const obs = new RetryAfterHeader();
    expect(obs.observe(new Headers())).toBeNull();
  });
  test("falls back to lowercase retry-after header", () => {
    const obs = new RetryAfterHeader();
    const h = new Headers();
    h.set("retry-after", "30");
    const snap = obs.observe(h);
    expect(snap?.remaining).toBe(0);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now() + 20_000);
  });
  test("returns null when Retry-After value is non-numeric (NaN)", () => {
    const obs = new RetryAfterHeader();
    const h = new Headers();
    h.set("Retry-After", "not-a-number");
    expect(obs.observe(h)).toBeNull();
  });
  test("resetAtMs is approximately now + seconds * 1000", () => {
    const before = Date.now();
    const obs = new RetryAfterHeader();
    const h = new Headers();
    h.set("Retry-After", "10");
    const snap = obs.observe(h);
    const after = Date.now();
    expect(snap).not.toBeNull();
    // resetAtMs should be within [before+10000, after+10000] with a small buffer
    expect(snap!.resetAtMs).toBeGreaterThanOrEqual(before + 10_000);
    expect(snap!.resetAtMs).toBeLessThanOrEqual(after + 10_000 + 100);
  });
});

describe("NoopObserver", () => {
  test("always returns null", () => {
    expect(new NoopObserver().observe(new Headers())).toBeNull();
  });
});
