/**
 * The run bookkeeping shared by the gateway's two in-memory, HTTP-polled run stores:
 * `briefs/brief-run-store.ts` (research briefs) and `agent-runs/agent-run-store.ts` (agent runs).
 *
 * ONE copy rather than two. `AgentRunController` was modelled on `BriefRunController` by copying
 * its mechanics, so the TTL sweep, the tombstone set, the terminal trim and the soonest-expiry
 * arithmetic each existed twice, and a fix to one copy had no reason to reach the other.
 *
 * What it owns, for both stores — a plain Map, an injected clock, no timer and no sweeper thread:
 *
 *  - LAZY TTL expiry: `sweep()` drops every run past its `expiresAtMs`, and `get()` re-checks the
 *    one run it is asked for. Strictly `now > expiresAtMs`, so a run sitting exactly on its expiry
 *    is still live. The TTL is never refreshed on access — a polling client must not pin memory.
 *  - The tombstone set behind 410 vs 404: every id the registry drops, by TTL or by the terminal
 *    trim, is remembered. It is capped at `maxTombstones` with the OLDEST evicted first (a Set
 *    preserves insertion order), which degrades that id from 410 to 404 — both are terminal
 *    "discard" signals to a client.
 *  - The concurrency count: NON-terminal runs only. A run is terminal once its status is `done` or
 *    `failed`, the two terminal states both stores share.
 *  - Terminal retention: at most `maxRetainedTerminal` terminal runs, oldest (by `createdAtMs`)
 *    evicted first.
 *
 * What it deliberately leaves to each store: the admission rule (the agent store also counts
 * in-flight reservations the registry never sees), the TTL (each store stamps `expiresAtMs` on the
 * runs it creates), every field beyond the four below, and anything that must be released when a
 * run expires — that is `onExpire`.
 */

/** The fields the registry reads. Both stores' run types carry more; it never touches the rest. */
export type ExpiringRun = {
  readonly id: string;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

export type ExpiringRunRegistryOptions<R extends ExpiringRun> = {
  readonly nowMs: () => number;
  /** Cap on the tombstone set that drives 410 vs 404. Oldest evicted first. */
  readonly maxTombstones: number;
  /** Terminal runs retained for polling after finishing. Oldest evicted first. */
  readonly maxRetainedTerminal: number;
  /**
   * Called with each run the TTL drops — by `sweep()` AND by a lazy `get()` — BEFORE it leaves the
   * map. NOT called for a run `trimTerminal()` evicts: a store holding something only a live run
   * needs must release it on the way to a terminal state, as `BriefRunController.finish`/`fail` do.
   */
  readonly onExpire?: (run: R) => void;
};

function isTerminal(run: ExpiringRun): boolean {
  return run.status === "done" || run.status === "failed";
}

export class ExpiringRunRegistry<R extends ExpiringRun> {
  private readonly runs = new Map<string, R>();
  /** Ids that existed and have since expired or been evicted — drives 410 vs 404. */
  private readonly expired = new Set<string>();
  private readonly nowMs: () => number;
  private readonly maxTombstones: number;
  private readonly maxRetainedTerminal: number;
  private readonly onExpire: ((run: R) => void) | undefined;

  constructor(options: ExpiringRunRegistryOptions<R>) {
    this.nowMs = options.nowMs;
    this.maxTombstones = options.maxTombstones;
    this.maxRetainedTerminal = options.maxRetainedTerminal;
    this.onExpire = options.onExpire;
  }

  /** Holds `run` under its own id. The caller has already stamped `createdAtMs`/`expiresAtMs`. */
  add(run: R): void {
    this.runs.set(run.id, run);
  }

  /** The run under `id` with NO expiry check, for a caller that must adopt a record as it stands. */
  peek(id: string): R | undefined {
    return this.runs.get(id);
  }

  /** Returns the run, or null when it is unknown OR has expired (expiry is checked here). */
  get(id: string): R | null {
    const run = this.runs.get(id);
    if (run === undefined) return null;
    if (this.nowMs() > run.expiresAtMs) {
      this.expire(id, run);
      return null;
    }
    return run;
  }

  /** True when this id was a real run that has since expired or been evicted — the 410 signal. */
  wasKnown(id: string): boolean {
    return this.expired.has(id);
  }

  /**
   * Drops every run past its TTL. Expiry is otherwise access-triggered, so a store calls this before
   * an admission check: runs created and never polled would never expire and would pin the cap
   * until the gateway restarted.
   */
  sweep(): void {
    const now = this.nowMs();
    for (const [id, run] of this.runs) {
      if (now > run.expiresAtMs) this.expire(id, run);
    }
  }

  /** Sweeps, then counts NON-terminal runs — a terminal run holds no work and takes no slot. */
  activeCount(): number {
    this.sweep();
    let n = 0;
    for (const run of this.runs.values()) if (!isTerminal(run)) n += 1;
    return n;
  }

  /** Bounds retained terminal runs at `maxRetainedTerminal`, dropping the oldest first. */
  trimTerminal(): void {
    const terminal = [...this.runs.values()]
      .filter((r) => isTerminal(r))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < terminal.length - this.maxRetainedTerminal; i++) {
      const run = terminal[i] as R;
      this.runs.delete(run.id);
      this.rememberExpired(run.id);
    }
  }

  /**
   * Seconds until the soonest NON-terminal run expires — rounded up, never negative — or null when
   * no non-terminal run is held. Never Infinity: JSON.stringify would turn it into `null` anyway,
   * but silently, and meaning "unknown" rather than "not clock-bounded".
   *
   * Does not sweep. A store calls it right after `activeCount()`, which already has.
   */
  secondsUntilSoonestExpiry(): number | null {
    const now = this.nowMs();
    let soonest = Number.POSITIVE_INFINITY;
    for (const run of this.runs.values()) {
      if (!isTerminal(run)) soonest = Math.min(soonest, run.expiresAtMs);
    }
    return soonest === Number.POSITIVE_INFINITY
      ? null
      : Math.max(0, Math.ceil((soonest - now) / 1000));
  }

  /** The one TTL-eviction path: release (`onExpire`), drop, then remember the id for 410. */
  private expire(id: string, run: R): void {
    this.onExpire?.(run);
    this.runs.delete(id);
    this.rememberExpired(id);
  }

  /**
   * Adds `id` to the tombstone set, evicting the OLDEST entry once the cap is exceeded (a Set
   * preserves insertion order).
   */
  private rememberExpired(id: string): void {
    this.expired.add(id);
    while (this.expired.size > this.maxTombstones) {
      const oldest = this.expired.values().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }
}
