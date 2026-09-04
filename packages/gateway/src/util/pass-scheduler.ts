/**
 * The debounced, single-flight scheduler behind every post-sync extraction pass — glossary,
 * decisions, ownership and pre-mortem.
 *
 * ONE state machine rather than four copies of it. The four copies had already drifted in ways
 * nobody decided: `trigger()` set the dirty flag directly in one of them and armed a redundant
 * timer in the other three, only two carried an `AbortController` at all, and only one `unref`'d
 * its timer. Every divergence was invisible because there was no single place to compare them.
 *
 * What the machine guarantees, for all four:
 *
 *  - A BURST of connector syncs coalesces into ONE pass.
 *  - A trigger arriving while a pass is already running sets a DIRTY flag rather than queueing:
 *    exactly one follow-up pass runs afterwards, no matter how many syncs landed meanwhile, so a
 *    slow pass cannot accumulate a backlog of redundant work. Dropping the trigger outright — the
 *    original behaviour — was cheaper still, but it lost the items of whichever sync happened to
 *    overlap the pass until some later sync triggered again, which for the last sync before an
 *    idle period could be a long time.
 *  - `stop()` aborts the shared signal, so a pass in flight at shutdown stops at its next
 *    checkpoint instead of running on against a database that is about to close.
 *  - The debounce timer is `unref`'d, so a pending pass never holds the process open.
 *
 * Each subsystem keeps its OWN error class and `ERR_<X>_*` codes: `refuse` is injected, so this
 * module decides WHEN a run is refused and the caller decides what that refusal is called.
 */

/** Why a `runNow` was refused. Ordered as the caller checks them — see `runNow` below. */
export type PassRefusal = "disabled" | "stopped" | "running";

export interface PassSchedulerDeps<S, O> {
  /** Omitted means "always enabled" — a subsystem with no `[section].enabled` key of its own. */
  readonly isEnabled?: () => boolean;
  readonly debounceMs: number;
  /**
   * Injected rather than imported so a scheduler is testable without a Database.
   *
   * The signal is aborted by `stop()`, so a pass in flight at shutdown stops at its next
   * checkpoint. A pass that ignores the signal simply keeps the pre-existing behaviour.
   */
  readonly runPass: (signal: AbortSignal, opts: O) => Promise<S>;
  /** What the DEBOUNCED path passes. `runNow` passes the caller's own options instead. */
  readonly scheduledOptions: O;
  readonly onError?: (err: unknown) => void;
  /** Build the error thrown for each refusal kind. */
  readonly refuse: (kind: PassRefusal) => Error;
}

export interface PassScheduler<S, O> {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Run a pass immediately, bypassing the debounce. Shares the single-flight guard with the
   * scheduled path: a scheduled pass and an on-demand pass must never run concurrently, since
   * both write the same tables and the same watermark, and both spend local-LLM time.
   */
  runNow: (opts: O) => Promise<S>;
  /** Synchronous, so an RPC handler can reject a concurrent request before starting a job. */
  status: () => "idle" | "running" | "stopped" | "disabled";
  stop: () => void;
}

export function createPassScheduler<S, O>(deps: PassSchedulerDeps<S, O>): PassScheduler<S, O> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  const controller = new AbortController();
  const enabled = (): boolean => deps.isEnabled?.() ?? true;

  function fire(): void {
    timer = undefined;
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    deps
      .runPass(controller.signal, deps.scheduledOptions)
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
        if (dirty) {
          dirty = false;
          // Re-enters through `fire`, so a `stop()` that landed during the pass is honoured by
          // the single check at the top rather than duplicated here.
          fire();
        }
      });
  }

  return {
    trigger(): void {
      // The `stopped` half is belt-and-braces for the PASS (`fire` checks it too, so no pass can
      // start), but not redundant for SHUTDOWN: arming a timer after `stop()` is scheduling a
      // no-op.
      if (!enabled() || stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
      // Never hold the process open for a background pass.
      timer.unref?.();
    },

    status(): "idle" | "running" | "stopped" | "disabled" {
      if (stopped) return "stopped";
      if (!enabled()) return "disabled";
      return running ? "running" : "idle";
    },

    async runNow(opts: O): Promise<S> {
      // Order matters: a disabled pass is a config problem the user can fix, a stopped one is
      // not, and both are more useful answers than "already running".
      if (!enabled()) throw deps.refuse("disabled");
      if (stopped) throw deps.refuse("stopped");
      if (running) {
        // Deliberately NOT "await the in-flight pass and return its summary": that pass is not
        // the one the caller asked for, and for a rebuild it would report success for work that
        // never happened.
        throw deps.refuse("running");
      }
      running = true;
      try {
        return await deps.runPass(controller.signal, opts);
      } finally {
        running = false;
        // Preserve the scheduled path's dirty-rerun: a sync that landed during this on-demand
        // pass still gets its follow-up.
        if (dirty) {
          dirty = false;
          fire();
        }
      }
    },

    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Aborting is what makes shutdown responsive: a pass that checks the signal between units
      // of work returns instead of continuing against a closing database.
      controller.abort();
    },
  };
}
