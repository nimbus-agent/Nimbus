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

  test("refuses exactly AT the wall-clock boundary, not only past it", () => {
    // Pins the `>=` comparison: flipping it to `>` would leave this green with the "past it"
    // test above alone. maxWallClockMs: 1000 means now === approvedAt + 1000 must already refuse.
    const s = new CuSession(envelope({ maxWallClockMs: 1000 }));
    expect(s.consumeAction(1000)).toEqual({ ok: false, reason: "wall_clock" });
  });

  test("a budget refusal CLOSES the session rather than leaving it live", () => {
    // Spec § 4.1: exceeding a budget terminates. It does not prompt to extend, and it must not
    // leave a session that a later call could keep poking at.
    const s = new CuSession(envelope({ maxActions: 1 }));
    s.consumeAction(0);
    s.consumeAction(0);
    expect(s.isOpen()).toBe(false);
  });

  test("a wall-clock refusal ALSO closes the session, not just the budget half", () => {
    const s = new CuSession(envelope());
    s.consumeAction(1001);
    expect(s.isOpen()).toBe(false);
  });

  test("a closed session refuses with closed, not budget", () => {
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

  test("the origin arrays themselves are frozen, not just the target object", () => {
    // I-3: freezing `target` alone still lets a holder push onto navigateOrigins/scriptOrigins
    // and widen the navigation allowlist in place. All 8 prior tests passed without this.
    const s = new CuSession(envelope());
    expect(Object.isFrozen(s.envelope.target.navigateOrigins)).toBe(true);
    expect(Object.isFrozen(s.envelope.target.scriptOrigins)).toBe(true);
    expect(() => {
      (s.envelope.target.navigateOrigins as string[]).push("https://evil.com");
    }).toThrow();
  });
});

describe("CuSession — runtime-enforced (not merely TS-discouraged) immutability", () => {
  // I-1 / I-2: readonly/private are compile-time-only. A caller that casts past the type system
  // can read AND write a private readonly field with no throw at runtime, which would let it
  // swap in a wider envelope or reopen a session consumeAction already closed. Hash-private
  // fields have no such escape hatch.

  test("the envelope reference cannot be swapped out from outside the class", () => {
    const s = new CuSession(envelope());
    expect(() => {
      (s as unknown as { envelope: CuEnvelope }).envelope = envelope({ maxActions: 999 });
    }).toThrow();
    expect(s.envelope.maxActions).toBe(3);
  });

  test("a closed session cannot be reopened by poking at a same-named property", () => {
    const s = new CuSession(envelope({ maxActions: 1 }));
    s.consumeAction(0); // succeeds
    s.consumeAction(0); // budget exhausted, closes
    expect(s.isOpen()).toBe(false);

    // There is no public `closed` property to assign; CuSession exposes only isOpen(). Casting
    // to a shape with one and assigning to it must not silently create a new own property that
    // reopens the session; the real state lives in a hash-private field this cast cannot reach.
    (s as unknown as { closed: boolean }).closed = false;
    expect(s.isOpen()).toBe(false);
    expect(s.consumeAction(0)).toEqual({ ok: false, reason: "closed" });
  });

  test("private state has no enumerable own string-keyed property an outside cast can find", () => {
    const s = new CuSession(envelope());
    // Hash-private fields are not own string-keyed properties at all; Object.keys and
    // getOwnPropertyNames never list them, unlike a TS `private` field, which is just a regular
    // property under a naming convention the compiler enforces and a runtime cast bypasses.
    expect(Object.keys(s)).toEqual([]);
    expect(Object.getOwnPropertyNames(s)).toEqual([]);
  });
});

describe("CuSession — timestamps", () => {
  test("close records closedAt from the caller-supplied clock", () => {
    const s = new CuSession(envelope());
    expect(s.closedAt).toBeUndefined();
    s.close("owner", 12345);
    expect(s.closedAt).toBe(12345);
  });

  test("a later close call does not move an already-recorded closedAt", () => {
    const s = new CuSession(envelope());
    s.close("owner", 100);
    s.close("owner", 200);
    expect(s.closedAt).toBe(100);
  });

  test("taint records taintedAt on first latch only", () => {
    const s = new CuSession(envelope());
    expect(s.taintedAt).toBeUndefined();
    s.taint();
    const first = s.taintedAt;
    expect(first).toBeDefined();
    s.taint();
    expect(s.taintedAt).toBe(first);
  });
});

describe("CuSession — constructor bounds guard (fail-closed on malformed budgets)", () => {
  test("rejects maxActions NaN, which would make used >= maxActions permanently false", () => {
    expect(() => new CuSession(envelope({ maxActions: Number.NaN }))).toThrow();
  });

  test("rejects maxWallClockMs NaN, which would make the wall-clock check permanently false", () => {
    expect(() => new CuSession(envelope({ maxWallClockMs: Number.NaN }))).toThrow();
  });

  test("rejects maxActions undefined", () => {
    expect(() => new CuSession(envelope({ maxActions: undefined as unknown as number }))).toThrow();
  });

  test("rejects maxWallClockMs undefined", () => {
    expect(
      () => new CuSession(envelope({ maxWallClockMs: undefined as unknown as number })),
    ).toThrow();
  });

  test("rejects non-positive maxActions", () => {
    expect(() => new CuSession(envelope({ maxActions: 0 }))).toThrow();
    expect(() => new CuSession(envelope({ maxActions: -1 }))).toThrow();
  });

  test("rejects non-positive maxWallClockMs", () => {
    expect(() => new CuSession(envelope({ maxWallClockMs: 0 }))).toThrow();
    expect(() => new CuSession(envelope({ maxWallClockMs: -1 }))).toThrow();
  });

  test("accepts a well-formed envelope", () => {
    expect(() => new CuSession(envelope())).not.toThrow();
  });
});
