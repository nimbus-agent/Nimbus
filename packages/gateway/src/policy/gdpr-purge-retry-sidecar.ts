import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "../db/audit-chain.ts";
import { signDeletionRecord } from "./deletion-record.ts";
import { type RetryDeps, retryPendingPurges } from "./gdpr-purge-retry.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

/** Default cadence for the purge-retry sidecar (5 min). */
export const GDPR_PURGE_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export interface StartGdprPurgeRetryOptions {
  /**
   * Send `federation.purge` to a peer; returns the signed deletion record string,
   * or null if the peer is unreachable / has not yet approved. Defaults to a no-op
   * (always-null) retry — the concrete over-the-wire request lands in Task 26.
   */
  readonly requestPurge?: (peerId: string) => Promise<string | null>;
  /** Anchor Ed25519 signing seed (base64). Never leaves this closure. */
  readonly anchorPrivkeyB64: string;
  /** Cadence override (ms); defaults to {@link GDPR_PURGE_RETRY_INTERVAL_MS}. */
  readonly intervalMs?: number;
  /** Clock source; defaults to Date.now. Injected in tests. */
  readonly nowMs?: () => number;
}

export interface GdprPurgeRetryHandle {
  stop(): void;
}

/**
 * Build the {@link RetryDeps} for the GDPR purge-retry tick. The completion
 * signature is an aggregate {@link signDeletionRecord} over a minimal, deterministic
 * job summary; when a job closes, a `team.purge.completed` audit entry is appended
 * with that aggregate signature so the compliance ledger records the closure.
 */
export function buildGdprPurgeRetryDeps(db: Database, opts: StartGdprPurgeRetryOptions): RetryDeps {
  const clock = opts.nowMs ?? Date.now;
  const store = new GdprPurgeStore(db);
  const requestPurge = opts.requestPurge ?? (async () => null);
  return {
    store,
    requestPurge,
    nowMs: clock,
    signCompletion: (jobId: string): string => {
      const at = clock();
      const sig = signDeletionRecord(
        { externalId: jobId, peerId: jobId, deletedCount: 0, at },
        opts.anchorPrivkeyB64,
      );
      appendAuditEntry(db, {
        actionType: "team.purge.completed",
        hitlStatus: "not_required",
        actionJson: JSON.stringify({ job_id: jobId, completion_sig: sig }),
        timestamp: at,
      });
      return sig;
    },
  };
}

/**
 * Run one purge-retry tick immediately, then on an interval. Each tick is isolated
 * (a thrown tick never escapes). Returns a stop handle to clear the timer; push it
 * onto the sidecar stop list.
 */
export function startGdprPurgeRetry(
  db: Database,
  opts: StartGdprPurgeRetryOptions,
): GdprPurgeRetryHandle {
  const deps = buildGdprPurgeRetryDeps(db, opts);
  const interval = opts.intervalMs ?? GDPR_PURGE_RETRY_INTERVAL_MS;
  const tick = (): void => {
    void retryPendingPurges(deps).catch(() => {
      // Best-effort maintenance — never crash the scheduler.
    });
  };
  tick();
  const timer = setInterval(tick, interval);
  return { stop: () => clearInterval(timer) };
}
