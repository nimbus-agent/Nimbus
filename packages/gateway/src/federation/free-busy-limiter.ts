/**
 * Per-peer limits on inbound free/busy requests (Phase 10, OR-S4-SCHED). The owner is asked about
 * EVERY request, so the limits protect the owner's attention, not the data: one prompt per peer at
 * a time, at most `MAX_PER_PEER_PER_HOUR` prompts per peer per rolling hour (a declined or timed-out
 * request counts), and at most `MAX_PENDING_TOTAL` prompts open across all peers. In memory only: a
 * restart forgets them, which costs the owner at most a few extra prompts.
 */
export const MAX_PER_PEER_PER_HOUR = 6;
export const MAX_PENDING_TOTAL = 3;
const HOUR_MS = 3_600_000;

export class FreeBusyLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly pending = new Set<string>();

  /** True when the request may proceed to a prompt; the caller MUST call `release` after. */
  tryAcquire(peerId: string, nowMs: number): boolean {
    if (this.pending.has(peerId) || this.pending.size >= MAX_PENDING_TOTAL) return false;
    const recent = (this.attempts.get(peerId) ?? []).filter((t) => nowMs - t < HOUR_MS);
    if (recent.length >= MAX_PER_PEER_PER_HOUR) {
      this.attempts.set(peerId, recent);
      return false;
    }
    recent.push(nowMs);
    this.attempts.set(peerId, recent);
    this.pending.add(peerId);
    return true;
  }

  release(peerId: string): void {
    this.pending.delete(peerId);
  }
}
