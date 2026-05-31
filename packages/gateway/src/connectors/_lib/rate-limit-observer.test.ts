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
});

describe("RetryAfterHeader", () => {
  test("reads Retry-After seconds", () => {
    const h = new Headers();
    h.set("Retry-After", "60");
    const snap = new RetryAfterHeader().observe(h);
    expect(snap?.remaining).toBe(0);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now() + 50_000);
  });
});

describe("NoopObserver", () => {
  test("always returns null", () => {
    expect(new NoopObserver().observe(new Headers())).toBeNull();
  });
});
