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
      const record = await deps.requestPurge(req.peerId);
      if (record !== null) {
        deps.store.markDone(jobId, req.peerId, record, deps.nowMs());
      }
    }
    if (deps.store.allDone(jobId)) {
      deps.store.closeJob(jobId, deps.signCompletion(jobId), deps.nowMs());
    }
  }
}
