import type { CuBudgetVerdict, CuEnvelope } from "./cu-types.ts";

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
 */
export class CuSession {
  readonly envelope: CuEnvelope;
  private used = 0;
  private tainted = false;
  private closed = false;
  private closeReason: string | undefined;

  constructor(envelope: CuEnvelope) {
    // Copy the origin arrays before freezing: a caller that keeps a reference to the array it
    // passed in must not be able to push onto it and widen a policy the owner already approved.
    // Same reasoning as `exec-policy.ts`'s `requireAbsolute` copy.
    const target = Object.freeze({
      navigateOrigins: Object.freeze([...envelope.target.navigateOrigins]),
      scriptOrigins: Object.freeze([...envelope.target.scriptOrigins]),
    });
    this.envelope = Object.freeze({ ...envelope, target });
  }

  isOpen(): boolean {
    return !this.closed;
  }

  isTainted(): boolean {
    return this.tainted;
  }

  /** One-way. Called on every observation; idempotent by construction. */
  taint(): void {
    this.tainted = true;
  }

  get actionsUsed(): number {
    return this.used;
  }

  get reason(): string | undefined {
    return this.closeReason;
  }

  close(reason: string, _now: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
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
    if (this.closed) return { ok: false, reason: "closed" };
    if (now - this.envelope.approvedAt >= this.envelope.maxWallClockMs) {
      this.close("terminated_wall_clock", now);
      return { ok: false, reason: "wall_clock" };
    }
    if (this.used >= this.envelope.maxActions) {
      this.close("terminated_budget", now);
      return { ok: false, reason: "budget" };
    }
    this.used += 1;
    return { ok: true, seq: this.used };
  }
}
