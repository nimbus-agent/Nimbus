import type { CuBudgetVerdict, CuEnvelope, CuOutcome } from "./cu-types.ts";

/**
 * One live computer-use session: the frozen envelope plus the mutable state beside it (I35).
 *
 * The split is the point. The ENVELOPE is what the owner approved and is frozen at construction, so
 * no code path — including one written later, including one running after the taint latch is set —
 * can widen it. Budget consumption and the latch are mutable state that lives OUTSIDE it. A design
 * that put `actionsUsed` on the envelope would have had to leave the envelope mutable, and the
 * "may only narrow" property would then rest on every caller's good behaviour instead of on
 * `Object.freeze`.
 *
 * There is deliberately no `untaint()` and no `widen()`. The absence is the invariant.
 *
 * All mutable state (and the envelope reference itself) is held in ECMAScript `#private` fields,
 * not TypeScript `private`/`readonly`. This is a deliberate, singular exception to house style
 * (`private` elsewhere in packages/gateway/src) — the design spec requires widening to be
 * "unrepresentable rather than merely discouraged", and TS `private`/`readonly` are erased at
 * compile time: a caller that casts past the type system (`s as unknown as {...}`) can read AND
 * WRITE a `private readonly` field with no throw, which would let it swap in a wider envelope or
 * reopen a session `consumeAction` closed for budget exhaustion. `#` fields have no such escape
 * hatch — they throw a real `TypeError` from outside the class, so the "cannot widen" property
 * holds at runtime, not just under the type checker. Do not "normalise" this back to `private`.
 */
export class CuSession {
  readonly #envelope: CuEnvelope;
  #used = 0;
  #tainted = false;
  #closed = false;
  #closeReason: string | undefined;
  #closedAt: number | undefined;
  #taintedAt: number | undefined;

  constructor(envelope: CuEnvelope) {
    // Fail closed on a non-finite or non-positive bound: `NaN` (or `undefined` coerced to it)
    // makes `used >= maxActions` and the wall-clock comparison both permanently false, so a
    // malformed envelope would grant unlimited actions and report `isOpen() === true` forever.
    // Guarding here — once, at construction — means every future caller inherits the fail-closed
    // posture instead of having to reimplement it.
    if (!Number.isFinite(envelope.maxActions) || envelope.maxActions <= 0) {
      throw new Error(
        `CuEnvelope.maxActions must be a finite number > 0, got ${envelope.maxActions}`,
      );
    }
    if (!Number.isFinite(envelope.maxWallClockMs) || envelope.maxWallClockMs <= 0) {
      throw new Error(
        `CuEnvelope.maxWallClockMs must be a finite number > 0, got ${envelope.maxWallClockMs}`,
      );
    }

    // Copy the origin arrays before freezing: a caller that keeps a reference to the array it
    // passed in must not be able to push onto it and widen a policy the owner already approved.
    // Same reasoning as `exec-policy.ts`'s `requireAbsolute` copy.
    const target = Object.freeze({
      navigateOrigins: Object.freeze([...envelope.target.navigateOrigins]),
      scriptOrigins: Object.freeze([...envelope.target.scriptOrigins]),
    });
    this.#envelope = Object.freeze({ ...envelope, target });
  }

  get envelope(): CuEnvelope {
    return this.#envelope;
  }

  isOpen(): boolean {
    return !this.#closed;
  }

  isTainted(): boolean {
    return this.#tainted;
  }

  /** One-way. Called on every observation; idempotent by construction. */
  taint(): void {
    if (this.#tainted) return;
    this.#tainted = true;
    // Not `??=`: a later call must never move an already-latched timestamp either.
    if (this.#taintedAt === undefined) this.#taintedAt = Date.now();
  }

  get taintedAt(): number | undefined {
    return this.#taintedAt;
  }

  get actionsUsed(): number {
    return this.#used;
  }

  get reason(): string | undefined {
    return this.#closeReason;
  }

  get closedAt(): number | undefined {
    return this.#closedAt;
  }

  close(reason: CuOutcome | "owner", now: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#closedAt = now;
  }

  /**
   * Claim the next action slot.
   *
   * A budget or wall-clock refusal CLOSES the session rather than merely denying the one action:
   * spec § 4.1 says exceeding a bound terminates, and prompting to extend — or leaving a live
   * session a caller can keep retrying against — is how an unbounded sequence launders itself
   * through a bounded one.
   */
  consumeAction(now: number): CuBudgetVerdict {
    if (this.#closed) return { ok: false, reason: "closed" };
    if (now - this.#envelope.approvedAt >= this.#envelope.maxWallClockMs) {
      this.close("terminated_wall_clock", now);
      return { ok: false, reason: "wall_clock" };
    }
    if (this.#used >= this.#envelope.maxActions) {
      this.close("terminated_budget", now);
      return { ok: false, reason: "budget" };
    }
    this.#used += 1;
    return { ok: true, seq: this.#used };
  }
}
