export type GlossaryRefresherDeps = {
  enabled: boolean;
  debounceMs: number;
  /**
   * Injected rather than imported so the module is testable without a Database.
   *
   * The signal is aborted by `stop()`, so a pass in flight at shutdown stops at
   * its next checkpoint instead of running on against a closing database.
   */
  runPass: (signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
};

export type GlossaryRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the extraction pass.
 *
 * A burst of connector syncs must coalesce into ONE pass. A trigger arriving
 * while a pass is already running sets a DIRTY flag rather than queueing:
 * exactly one follow-up pass runs afterwards, no matter how many syncs landed
 * meanwhile, so a slow pass cannot accumulate a backlog of redundant work.
 * Dropping the trigger outright — the original behaviour — was cheaper still,
 * but it lost the items of whichever sync happened to overlap the pass until
 * some later sync triggered again, which for the last sync before an idle
 * period could be a long time.
 */
export function createGlossaryRefresher(deps: GlossaryRefresherDeps): GlossaryRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  const controller = new AbortController();

  function fire(): void {
    timer = undefined;
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    deps
      .runPass(controller.signal)
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
        if (dirty) {
          dirty = false;
          // Re-enters through `fire`, so a `stop()` that landed during the pass
          // is honoured by the single check at the top rather than duplicated
          // here.
          fire();
        }
      });
  }

  return {
    trigger(): void {
      // The `stopped` half is belt-and-braces for the PASS (`fire` checks it
      // too, so no pass can start), but not redundant for SHUTDOWN: a pending
      // `setTimeout` keeps Bun's event loop alive, so arming one here would
      // delay process exit by up to `debounceMs` to run a no-op.
      if (!deps.enabled || stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Aborting is what makes shutdown responsive: `runGlossaryPass` checks
      // the signal between terms, so an in-flight pass returns instead of
      // continuing to consolidate against a database that is about to close.
      controller.abort();
    },
  };
}
