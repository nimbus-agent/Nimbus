import { randomUUID } from "node:crypto";

export type QuorumOutcome = "approved" | "denied" | "failed";
export interface QuorumResult {
  readonly outcome: QuorumOutcome;
  readonly approvers: readonly string[];
}
export interface QuorumRequestOpts {
  readonly approvers: number;
  readonly windowMs: number;
}

interface Pending {
  readonly need: number;
  readonly approved: Set<string>;
  readonly resolve: (r: QuorumResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type QuorumBroadcast = (requestId: string) => void;

/** Session-only N-of-M approval aggregator. I21: counts ONLY distinct peerIds; deny aborts. */
export class QuorumCoordinator {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly broadcast: QuorumBroadcast) {}

  collect(opts: QuorumRequestOpts): Promise<QuorumResult> {
    const requestId = randomUUID();
    return new Promise<QuorumResult>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(requestId);
        this.pending.delete(requestId);
        resolve({ outcome: "failed", approvers: p ? [...p.approved] : [] });
      }, opts.windowMs);
      // NB: do NOT unref() this timer. The collect() promise resolves ONLY when this timer fires
      // (timeout) or respond() clears it — unref'ing an awaited timer makes `bun test` spin/hang
      // on Windows (the timer is the sole live handle, so it never fires). See memory.
      this.pending.set(requestId, {
        need: opts.approvers,
        approved: new Set<string>(),
        resolve,
        timer,
      });
      this.broadcast(requestId);
    });
  }

  /** Returns true if the response matched a live request. */
  respond(requestId: string, peerId: string, approved: boolean): boolean {
    const p = this.pending.get(requestId);
    if (p === undefined) return false;
    if (!approved) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ outcome: "denied", approvers: [...p.approved] });
      return true;
    }
    p.approved.add(peerId); // Set dedupes — no double-count (I21).
    if (p.approved.size >= p.need) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.resolve({ outcome: "approved", approvers: [...p.approved] });
    }
    return true;
  }
}
