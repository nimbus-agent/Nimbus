import { describe, expect, test } from "bun:test";
import { HttpWriteRateLimiter } from "../../../src/ipc/http-rate-limit.ts";

describe("HttpWriteRateLimiter", () => {
  test("allows up to maxRequests in the window", () => {
    const t = 0;
    const rl = new HttpWriteRateLimiter({ maxRequests: 3, windowMs: 1000 }, () => t);
    for (let i = 0; i < 3; i++) {
      const r = rl.check("fp1");
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    expect(rl.check("fp1").allowed).toBe(false);
  });

  test("isolates tokens by fingerprint", () => {
    const t = 0;
    const rl = new HttpWriteRateLimiter({ maxRequests: 1, windowMs: 1000 }, () => t);
    expect(rl.check("fp1").allowed).toBe(true);
    expect(rl.check("fp2").allowed).toBe(true);
    expect(rl.check("fp1").allowed).toBe(false);
  });

  test("reset is the earliest request's expiry", () => {
    let t = 0;
    const rl = new HttpWriteRateLimiter({ maxRequests: 2, windowMs: 1000 }, () => t);
    rl.check("fp1");
    t = 500;
    rl.check("fp1");
    t = 600;
    const r = rl.check("fp1");
    expect(r.allowed).toBe(false);
    expect(r.resetMs).toBe(1000);
  });

  test("sliding window — old requests roll off", () => {
    let t = 0;
    const rl = new HttpWriteRateLimiter({ maxRequests: 1, windowMs: 100 }, () => t);
    rl.check("fp1");
    t = 101;
    expect(rl.check("fp1").allowed).toBe(true);
  });
});
