// packages/gateway/src/agent-runs/agent-run-store.ts

/**
 * In-memory store for HTTP-invoked agent runs, modelled on `briefs/brief-run-store.ts` (which is
 * itself modelled on `clips/pairing-window.ts`, invariant I30): a plain Map, an injected clock,
 * lazy expiry, no timer and no sweeper thread.
 *
 * A gateway restart drops everything, DELIBERATELY. Persisting these would write synthesised brief
 * text — derived from the private index — into a new on-disk table, which is a privacy expansion,
 * to buy resumption of something already reproducible by re-issuing the call. The cost is that a
 * client polling across a restart sees 404 rather than 410, because the tombstone set dies with the
 * process. That is a stated contract, not an accident: 404 means "unknown OR lost to a restart",
 * and the client's response to both is to re-issue, never to keep waiting.
 */

/** Run lifetime from creation. NOT refreshed on access — a polling client must not pin memory. */
export const AGENT_RUN_TTL_MS = 10 * 60_000;
/**
 * Live (non-terminal) runs plus outstanding reservations.
 *
 * Mirrors briefs' MAX_CONCURRENT_RUNS. The TTL here is a third of briefs' 30 minutes on purpose: a
 * brief run sits in `collecting` for as long as a human keeps feeding it tabs, so its TTL bounds a
 * PERSON's pace. An agent run has no collecting phase — it goes running → terminal in seconds with
 * no client participation — so the TTL only bounds how long a FINISHED brief stays pollable.
 */
export const MAX_CONCURRENT_AGENT_RUNS = 3;
/** Terminal runs retained for polling after finishing, oldest evicted first. */
export const MAX_RETAINED_TERMINAL_AGENT_RUNS = 16;
/** Cap on the expired-run tombstone set (drives 410 vs 404). Oldest evicted first. */
export const MAX_EXPIRED_AGENT_TOMBSTONES = 256;
/**
 * `Retry-After` on a busy refusal, in seconds.
 *
 * Small ON PURPOSE, and NOT derived from the run TTL. A slot frees when a run FINISHES, which for
 * an agent brief is seconds — not when it EXPIRES, which is ten minutes. Reporting the expiry
 * distance (as the briefs store does, where a run legitimately sits collecting for as long as a
 * human keeps feeding it) would tell a client to wait ten minutes for a three-second brief. That is
 * a misleading number, not a conservative one. A client that retries too early simply gets another
 * 429 carrying the header again, which costs one request.
 */
export const AGENT_BUSY_RETRY_AFTER_SECONDS = 1;

export type AgentRunStatus = "running" | "done" | "failed";

export type AgentRun = {
  readonly id: string;
  status: AgentRunStatus;
  createdAtMs: number;
  expiresAtMs: number;
  /** Synthesised markdown from `<agent>.briefReady`. */
  brief: string | null;
  /** The typed brief from the same notification. `unknown`: the shape is per-agent. */
  findings: unknown;
  error: string | null;
};

export type AgentRunControllerDeps = {
  readonly nowMs: () => number;
  readonly ttlMs?: number;
};

export type AdmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly activeRuns: number;
      /**
       * Seconds until the soonest non-terminal run expires — the UPPER bound on the wait, offered
       * as context rather than as the retry hint. `null` when every occupied slot is an in-flight
       * RESERVATION rather than an opened run: nothing on the clock bounds that wait, and both 0
       * and Infinity would be claims the store cannot support.
       */
      readonly oldestExpiresInSeconds: number | null;
    };

const READY_SUFFIX = ".briefReady";
const ERROR_SUFFIX = ".briefError";

function readSessionId(params: unknown): string | null {
  if (params === null || typeof params !== "object") return null;
  const p = params as { sessionId?: unknown };
  return typeof p.sessionId === "string" && p.sessionId !== "" ? p.sessionId : null;
}

export class AgentRunController {
  private readonly runs = new Map<string, AgentRun>();
  /** Ids that existed and have since expired or been evicted — drives 410 vs 404. */
  private readonly expired = new Set<string>();
  /** Admitted but not yet opened. Held across the await between admit() and open(). */
  private pending = 0;
  private readonly nowMs: () => number;
  private readonly ttlMs: number;

  constructor(deps: AgentRunControllerDeps) {
    this.nowMs = deps.nowMs;
    this.ttlMs = deps.ttlMs ?? AGENT_RUN_TTL_MS;
  }

  /**
   * Drops every run past its TTL. Called before the admission check because expiry is otherwise
   * access-triggered: three runs created and never polled would never expire and would pin the cap
   * until the gateway restarted.
   */
  private sweep(): void {
    const now = this.nowMs();
    for (const [id, run] of this.runs) {
      if (now > run.expiresAtMs) {
        this.runs.delete(id);
        this.rememberExpired(id);
      }
    }
  }

  private rememberExpired(id: string): void {
    this.expired.add(id);
    while (this.expired.size > MAX_EXPIRED_AGENT_TOMBSTONES) {
      const oldest = this.expired.values().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }

  private isTerminal(run: AgentRun): boolean {
    return run.status === "done" || run.status === "failed";
  }

  /** Non-terminal runs only — a terminal run holds no work and must not lock a caller out. */
  activeCount(): number {
    this.sweep();
    let n = 0;
    for (const run of this.runs.values()) if (!this.isTerminal(run)) n += 1;
    return n;
  }

  private trimTerminal(): void {
    const terminal = [...this.runs.values()]
      .filter((r) => this.isTerminal(r))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < terminal.length - MAX_RETAINED_TERMINAL_AGENT_RUNS; i++) {
      const run = terminal[i] as AgentRun;
      this.runs.delete(run.id);
      this.rememberExpired(run.id);
    }
  }

  /**
   * Seconds until the soonest non-terminal run expires, or null when there is none.
   *
   * The null case is real here in a way it is not for briefs: a busy refusal can be caused purely
   * by in-flight RESERVATIONS, with zero opened runs. The briefs store computes its equivalent only
   * after `activeCount() >= MAX`, so a run always exists there and POSITIVE_INFINITY is
   * unreachable. Copying its shape without this guard would return Infinity, which JSON.stringify
   * turns into `null` anyway — but silently, and meaning "unknown" rather than "not clock-bounded".
   */
  private soonestExpiry(): number | null {
    const now = this.nowMs();
    let soonest = Number.POSITIVE_INFINITY;
    for (const run of this.runs.values()) {
      if (!this.isTerminal(run)) soonest = Math.min(soonest, run.expiresAtMs);
    }
    return soonest === Number.POSITIVE_INFINITY
      ? null
      : Math.max(0, Math.ceil((soonest - now) / 1000));
  }

  /**
   * Reserves a concurrency slot SYNCHRONOUSLY, before the caller awaits the dispatch that mints the
   * run id. Two in-flight dispatches that had merely checked `activeCount()` would both pass and
   * over-admit; the reservation is what makes the cap hold across the await.
   */
  admit(): AdmitResult {
    const active = this.activeCount() + this.pending;
    if (active >= MAX_CONCURRENT_AGENT_RUNS) {
      return { ok: false, activeRuns: active, oldestExpiresInSeconds: this.soonestExpiry() };
    }
    this.pending += 1;
    return { ok: true };
  }

  /** Releases a reservation whose dispatch never produced a run. Never goes negative. */
  abandon(): void {
    if (this.pending > 0) this.pending -= 1;
  }

  /**
   * Converts a reservation into a run. ADOPTS an existing record rather than overwriting it: the
   * agent's notify can fire before this runs (emitBriefWithSynthesis starts work before returning
   * the sessionId), in which case `observe` already created the run in a terminal state, and
   * resetting it to `running` would strand a finished brief forever.
   */
  open(runId: string): void {
    this.abandon();
    this.ensure(runId);
  }

  private ensure(runId: string): AgentRun {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing;
    const now = this.nowMs();
    const run: AgentRun = {
      id: runId,
      status: "running",
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      brief: null,
      findings: null,
      error: null,
    };
    this.runs.set(runId, run);
    return run;
  }

  /**
   * The notify sink. Keyed purely on the `sessionId` in the params and on the method SUFFIX, so it
   * needs no per-agent list and cannot drift as agents are added. Anything it does not recognise is
   * ignored rather than guessed at — this is the same injected `notify` channel the socket server
   * uses for unrelated notifications.
   */
  observe(method: string, params: unknown): void {
    const isReady = method.endsWith(READY_SUFFIX);
    const isError = method.endsWith(ERROR_SUFFIX);
    if (!isReady && !isError) return;
    const runId = readSessionId(params);
    if (runId === null) return;
    const run = this.ensure(runId);
    const p = params as { brief?: unknown; findings?: unknown; error?: unknown };
    if (isError) {
      run.status = "failed";
      run.error = typeof p.error === "string" ? p.error : "internal_error";
    } else {
      run.status = "done";
      run.brief = typeof p.brief === "string" ? p.brief : null;
      run.findings = p.findings ?? null;
    }
    this.trimTerminal();
  }

  /** Returns the run, or null when it is unknown OR has expired (expiry is checked here). */
  get(runId: string): AgentRun | null {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    if (this.nowMs() > run.expiresAtMs) {
      this.runs.delete(runId);
      this.rememberExpired(runId);
      return null;
    }
    return run;
  }

  /** True when this id was a real run that has since expired or been evicted — the 410 signal. */
  wasKnown(runId: string): boolean {
    return this.expired.has(runId);
  }
}
