/**
 * The in-process counterpart of the worker bridge's backfill bookkeeping, for the runtimes that run
 * `backfillAll` on the gateway's own thread (`hybrid` via `create-routing-runtime.ts`, `openai` via
 * `lazy-scheduler.ts`). Before this, both reported `null` from `getActiveBackfillPass()` while a pass
 * was running, so a search on those runtimes never disclosed that its results might be incomplete.
 *
 * Same semantics as `worker-bridge.ts`, deliberately:
 *  - a pass is ACTIVE from its first progress report until it settles — so a pass with nothing to
 *    embed never becomes active, exactly as the worker's never sends `backfill_progress`;
 *  - `last()` keeps the final figure after the pass ends (what `nimbus status` shows);
 *  - settling clears `active` whether the pass finished, was stopped by its gate, or threw.
 */
export type BackfillPassProgress = { readonly done: number; readonly total: number };

export type BackfillPassTracker = {
  /** Runs one pass, feeding it the progress callback and clearing the active state when it settles. */
  run: (
    pass: (onProgress: (done: number, total: number) => void) => Promise<void>,
  ) => Promise<void>;
  /** The pass running now, or `null`. */
  active: () => BackfillPassProgress | null;
  /** The last reported progress, kept after the pass ends. */
  last: () => BackfillPassProgress | null;
};

export function createBackfillPassTracker(): BackfillPassTracker {
  let running = false;
  let progress: BackfillPassProgress | null = null;
  return {
    async run(pass) {
      try {
        await pass((done, total) => {
          progress = { done, total };
          running = true;
        });
      } finally {
        running = false;
      }
    },
    active: () => (running ? progress : null),
    last: () => progress,
  };
}
