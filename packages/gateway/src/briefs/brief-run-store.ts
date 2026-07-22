import { randomUUID } from "node:crypto";
import { canonicalizeUrl } from "../util/url-canonical.ts";
import {
  DEFAULT_RUN_TTL_MS,
  MAX_CONCURRENT_RUNS,
  MAX_EXPIRED_TOMBSTONES,
  MAX_RETAINED_TERMINAL_RUNS,
  MAX_RUN_BYTES,
  MAX_SOURCE_BYTES,
} from "./brief-constants.ts";
import type { BriefRun, BriefSource, Report } from "./brief-types.ts";

export type BriefRunControllerDeps = {
  readonly nowMs: () => number;
  readonly ttlMs?: number;
  readonly genId?: () => string;
};

export type CreateInput = {
  readonly brief: string;
  readonly sources: readonly { url: string; title: string }[];
  readonly useIndex: boolean;
};

export type CreateResult =
  | { run: BriefRun }
  | { error: "busy"; activeRuns: number; oldestExpiresInSeconds: number };

export type AddSourceInput = {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
};

export type AddSourceResult =
  | { accepted: boolean; received: number }
  | { error: "undeclared" | "source_too_large" | "run_capacity" };

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * In-memory store for research-brief runs, modelled on
 * `clips/pairing-window.ts` (invariant I30): a plain Map, injected clock, lazy
 * expiry, no timer and no sweeper thread.
 *
 * A gateway restart drops everything, and that is the point — it makes "source
 * text is ephemeral" a structural property rather than a promise. Source bodies
 * are NEVER written to disk from here.
 */
export class BriefRunController {
  private readonly runs = new Map<string, BriefRun>();
  /** Ids that existed and have since expired — drives 410 vs 404. */
  private readonly expired = new Set<string>();
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly genId: () => string;

  constructor(deps: BriefRunControllerDeps) {
    this.nowMs = deps.nowMs;
    this.ttlMs = deps.ttlMs ?? DEFAULT_RUN_TTL_MS;
    this.genId = deps.genId ?? (() => `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
  }

  /**
   * Drops every run past its TTL. Called before the concurrency check because
   * expiry is otherwise access-triggered: three runs created and never polled
   * would never expire and would pin the cap until the gateway restarted.
   */
  private sweep(): void {
    const now = this.nowMs();
    for (const [id, run] of this.runs) {
      if (now > run.expiresAtMs) {
        run.sources.clear();
        this.runs.delete(id);
        this.rememberExpired(id);
      }
    }
  }

  private isTerminal(run: BriefRun): boolean {
    return run.status === "done" || run.status === "failed";
  }

  /**
   * Adds `id` to the expired-tombstone set, evicting the OLDEST entry once the
   * cap is exceeded (a Set preserves insertion order). See MAX_EXPIRED_TOMBSTONES.
   */
  private rememberExpired(id: string): void {
    this.expired.add(id);
    while (this.expired.size > MAX_EXPIRED_TOMBSTONES) {
      const oldest = this.expired.values().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }

  /**
   * Non-terminal runs only. The cap is a MEMORY bound, and a terminal run has
   * already dropped its source bodies — counting it here would lock a user out
   * for the rest of the TTL over a report of at most ~20 KB.
   */
  activeCount(): number {
    this.sweep();
    let n = 0;
    for (const run of this.runs.values()) if (!this.isTerminal(run)) n += 1;
    return n;
  }

  /** Bounds retained terminal runs, dropping the oldest first. */
  private trimTerminal(): void {
    const terminal = [...this.runs.values()]
      .filter((r) => this.isTerminal(r))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < terminal.length - MAX_RETAINED_TERMINAL_RUNS; i++) {
      const run = terminal[i] as BriefRun;
      this.runs.delete(run.id);
      this.rememberExpired(run.id);
    }
  }

  create(input: CreateInput): CreateResult {
    this.sweep();
    const active = this.activeCount();
    if (active >= MAX_CONCURRENT_RUNS) {
      const now = this.nowMs();
      let soonest = Number.POSITIVE_INFINITY;
      for (const run of this.runs.values()) {
        if (!this.isTerminal(run)) soonest = Math.min(soonest, run.expiresAtMs);
      }
      return {
        error: "busy",
        activeRuns: active,
        oldestExpiresInSeconds: Math.max(0, Math.ceil((soonest - now) / 1000)),
      };
    }

    const declared = new Map<string, { url: string; title: string }>();
    for (const s of input.sources) {
      const key = canonicalizeUrl(s.url);
      if (!declared.has(key)) declared.set(key, { url: s.url, title: s.title });
    }

    const now = this.nowMs();
    const run: BriefRun = {
      id: this.genId(),
      brief: input.brief,
      useIndex: input.useIndex,
      declared,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      status: "collecting",
      sources: new Map(),
      bytesHeld: 0,
      report: null,
      error: null,
    };
    this.runs.set(run.id, run);
    return { run };
  }

  /** Returns the run, or null when it is unknown OR has expired (expiry is checked here). */
  get(id: string): BriefRun | null {
    const run = this.runs.get(id);
    if (run === undefined) return null;
    if (this.nowMs() > run.expiresAtMs) {
      run.sources.clear();
      this.runs.delete(id);
      this.rememberExpired(id);
      return null;
    }
    return run;
  }

  /** True when this id was a real run that has since expired — the 410 signal. */
  wasKnown(id: string): boolean {
    return this.expired.has(id);
  }

  addSource(run: BriefRun, input: AddSourceInput): AddSourceResult {
    const key = canonicalizeUrl(input.url);
    if (!run.declared.has(key)) return { error: "undeclared" };
    if (run.sources.has(key)) return { accepted: false, received: run.sources.size };

    // NFC once, here, so quote offsets computed later line up with what we hold.
    const body = input.body.normalize("NFC");
    // Every string this source pins in memory counts, not just the body — an unbounded
    // title/url would otherwise evade both the per-source and per-run caps entirely.
    const bytes = utf8Bytes(body) + utf8Bytes(input.title) + utf8Bytes(input.url);
    if (bytes > MAX_SOURCE_BYTES) return { error: "source_too_large" };
    if (run.bytesHeld + bytes > MAX_RUN_BYTES) return { error: "run_capacity" };

    const source: BriefSource = {
      canonicalUrl: key,
      url: input.url,
      title: input.title,
      body,
      capturedAt: input.capturedAt,
      truncated: input.truncated,
      bytes,
    };
    run.sources.set(key, source);
    run.bytesHeld += bytes;
    return { accepted: true, received: run.sources.size };
  }

  markRunning(run: BriefRun): void {
    run.status = "running";
  }

  /** Terminal. Drops every source body — the report no longer needs them. */
  finish(run: BriefRun, report: Report): void {
    run.report = report;
    run.status = "done";
    run.sources.clear();
    run.bytesHeld = 0;
    this.trimTerminal();
  }

  /** Terminal. Drops every source body. */
  fail(run: BriefRun, error: string): void {
    run.error = error;
    run.status = "failed";
    run.sources.clear();
    run.bytesHeld = 0;
    this.trimTerminal();
  }
}
