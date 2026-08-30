import { describe, expect, test } from "bun:test";
import { CuSession } from "./cu-session.ts";
import type { CuEnvelope } from "./cu-types.ts";

function envelope(over: Partial<CuEnvelope> = {}): CuEnvelope {
  return {
    sessionId: "s1",
    lane: "browser",
    target: { navigateOrigins: ["https://example.com"], scriptOrigins: [] },
    maxActions: 3,
    maxWallClockMs: 1000,
    approvedAt: 0,
    ...over,
  } as CuEnvelope;
}

describe("CuSession — budget", () => {
  test("consumes actions and refuses past the budget", () => {
    const s = new CuSession(envelope());
    expect(s.consumeAction(0)).toEqual({ ok: true, seq: 1 });
    expect(s.consumeAction(0)).toEqual({ ok: true, seq: 2 });
    expect(s.consumeAction(0)).toEqual({ ok: true, seq: 3 });
    expect(s.consumeAction(0)).toEqual({ ok: false, reason: "budget" });
  });

  test("refuses past the wall clock", () => {
    const s = new CuSession(envelope());
    expect(s.consumeAction(1001)).toEqual({ ok: false, reason: "wall_clock" });
  });

  test("a budget refusal CLOSES the session rather than leaving it live", () => {
    // Spec § 4.1: exceeding a budget terminates. It does not prompt to extend, and it must not
    // leave a session that a later call could keep poking at.
    const s = new CuSession(envelope({ maxActions: 1 }));
    s.consumeAction(0);
    s.consumeAction(0);
    expect(s.isOpen()).toBe(false);
  });

  test("a closed session refuses with 'closed', not 'budget'", () => {
    const s = new CuSession(envelope());
    s.close("owner", 0);
    expect(s.consumeAction(0)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("CuSession — taint ratchet", () => {
  test("starts untainted and latches on", () => {
    const s = new CuSession(envelope());
    expect(s.isTainted()).toBe(false);
    s.taint();
    expect(s.isTainted()).toBe(true);
  });

  test("the latch NEVER clears", () => {
    // Spec § 4.4: one-way. There is deliberately no untaint() to call.
    const s = new CuSession(envelope());
    s.taint();
    s.taint();
    expect(s.isTainted()).toBe(true);
    expect("untaint" in s).toBe(false);
  });

  test("the envelope object is frozen, so widening is unrepresentable", () => {
    // Spec § 3.4 / § 4.4: the approved envelope cannot be mutated by anyone holding a reference,
    // tainted or not. This is the structural half of "the envelope may only narrow".
    const s = new CuSession(envelope());
    expect(Object.isFrozen(s.envelope)).toBe(true);
    expect(Object.isFrozen(s.envelope.target)).toBe(true);
    expect(() => {
      (s.envelope as { maxActions: number }).maxActions = 999;
    }).toThrow();
  });

  test("origin arrays are COPIED, so a caller mutating its own array cannot widen the envelope", () => {
    const origins = ["https://example.com"];
    const s = new CuSession(envelope({ target: { navigateOrigins: origins, scriptOrigins: [] } }));
    origins.push("https://evil.com");
    expect(s.envelope.target.navigateOrigins).toEqual(["https://example.com"]);
  });
});
