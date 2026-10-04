import { randomUUID } from "node:crypto";
import { ExpiringRunRegistry } from "../util/expiring-run-registry.ts";
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
 * expiry, no timer and no sweeper thread. The TTL sweep, terminal trim and
 * 410-vs-404 tombstones live in `util/expiring-run-registry.ts`, shared with
 * the agent-run store.
 *
 * A gateway restart drops everything, and that is the point — it makes "source
 * text is ephemeral" a structural property rather than a promise. Source bodies
 * are NEVER written to disk from here.
 */
export class BriefRunController {
  private readonly runs: ExpiringRunRegistry<BriefRun>;
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly genId: () => string;

  constructor(deps: BriefRunControllerDeps) {
    this.nowMs = deps.nowMs;
    this.ttlMs = deps.ttlMs ?? DEFAULT_RUN_TTL_MS;
    this.genId = deps.genId ?? (() => `run_${randomUUID().replaceAll("-", "").slice(0, 20)}`);
    this.runs = new ExpiringRunRegistry<BriefRun>({
      nowMs: deps.nowMs,
      maxTombstones: MAX_EXPIRED_TOMBSTONES,
      maxRetainedTerminal: MAX_RETAINED_TERMINAL_RUNS,
      // EVERY TTL path — the sweep and a lazy get() — drops the source bodies before the run
      // itself. A run the terminal trim evicts has none left: finish() and fail() dropped them.
      onExpire: (run) => {
        run.sources.clear();
      },
    });
  }

  /**
   * Non-terminal runs only. The cap is a MEMORY bound, and a terminal run has
   * already dropped its source bodies — counting it here would lock a user out
   * for the rest of the TTL over a report of at most ~20 KB.
   */
  activeCount(): number {
    return this.runs.activeCount();
  }

  create(input: CreateInput): CreateResult {
    this.runs.sweep();
    const active = this.activeCount();
    if (active >= MAX_CONCURRENT_RUNS) {
      return {
        error: "busy",
        activeRuns: active,
        // `active >= MAX_CONCURRENT_RUNS` means a non-terminal run is held, so this is null only
        // when every such run expires at Infinity: a `ttlMs` of Infinity, which is what an absurdly
        // large `[briefs] ttl_minutes` becomes once `ttlMinutes * 60_000` overflows at the wiring
        // site. `now + ttlMs` cannot overflow by itself: a finite TTL keeps the sum finite at any
        // real clock value. Infinity is what the expiry arithmetic yields for those runs too —
        // never an invented 0.
        oldestExpiresInSeconds: this.runs.secondsUntilSoonestExpiry() ?? Number.POSITIVE_INFINITY,
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
    this.runs.add(run);
    return { run };
  }

  /**
   * Returns the run, or null when it is unknown OR has expired (expiry is checked
   * here, and an expired run's source bodies are dropped with it).
   */
  get(id: string): BriefRun | null {
    return this.runs.get(id);
  }

  /** True when this id was a real run that has since expired or been evicted — the 410 signal. */
  wasKnown(id: string): boolean {
    return this.runs.wasKnown(id);
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
    this.runs.trimTerminal();
  }

  /** Terminal. Drops every source body. */
  fail(run: BriefRun, error: string): void {
    run.error = error;
    run.status = "failed";
    run.sources.clear();
    run.bytesHeld = 0;
    this.runs.trimTerminal();
  }
}
