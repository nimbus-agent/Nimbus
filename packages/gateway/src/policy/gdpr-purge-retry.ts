import type { GdprPurgeStore } from "./gdpr-purge-store.ts";

export interface RetryDeps {
  readonly store: GdprPurgeStore;
  /** Send federation.purge to a peer; returns the signed deletion record string, or null if unreachable/not-yet-approved. */
  readonly requestPurge: (peerId: string) => Promise<string | null>;
  readonly signCompletion: (jobId: string) => string;
  readonly nowMs: () => number;
}

/** One retry tick: attempt every pending request; close jobs whose requests are all done. */
export async function retryPendingPurges(deps: RetryDeps): Promise<void> {
  for (const jobId of deps.store.openJobIds()) {
    for (const req of deps.store.pendingRequests(jobId)) {
      deps.store.incrementAttempt(jobId, req.peerId, deps.nowMs());
      try {
        const record = await deps.requestPurge(req.peerId); // NOSONAR S9382: each request is bracketed by its own incrementAttempt/markDone writes, stamped in order; concurrent requests would reorder those rows and fan out to every peer at once
        if (record !== null) {
          deps.store.markDone(jobId, req.peerId, record, deps.nowMs());
        }
      } catch {
        // Keep this request pending; a failed peer must not abort the rest of the tick.
      }
    }
    if (deps.store.allDone(jobId)) {
      deps.store.closeJob(jobId, deps.signCompletion(jobId), deps.nowMs());
    }
  }
}
