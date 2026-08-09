import type { PremortemPassResult } from "./premortem-pass.ts";

/** Carries `rpcCode` so a future `ipc/premortem-rpc.ts` maps it without re-deriving a code. */
export class PremortemRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "PremortemRefresherError";
    this.rpcCode = -32000;
  }
}

export type PremortemRefresherDeps = {
  debounceMs: number;
  /**
   * Injected rather than imported so the module is testable without a
   * Database.
   *
   * The signal is aborted by `stop()`, so a pass in flight at shutdown stops
   * at its next checkpoint (`runPremortemPass` checks it per batch) instead
   * of running on against a closing database.
   */
  runPass: (signal: AbortSignal) => Promise<PremortemPassResult>;
  onError: (err: unknown) => void;
};

export type PremortemRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Runs a pass immediately, bypassing the debounce. Shares the single-flight
   * guard with the scheduled path: a scheduled pass and an on-demand pass
   * must never run concurrently, since both write `theme` rows and the pass
   * watermark. This is the path the `premortem.refresh` IPC calls.
   */
  runNow: () => Promise<PremortemPassResult>;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the pre-mortem theme pass. Mirrors
 * `decisions/decision-refresh.ts`: a burst of connector syncs must coalesce
 * into ONE pass, and a trigger arriving mid-pass sets a DIRTY flag rather
 * than queueing — exactly one follow-up pass runs however many syncs landed
 * meanwhile, so a slow pass cannot accumulate a backlog of redundant work.
 * Dropping the trigger outright would lose whichever sync overlapped the
 * pass until some later sync fired again.
 *
 * Unlike `decisions/decision-refresh.ts` (whose `runPass` takes no signal,
 * per the LIMIT note there — "the abort has nowhere to go"), this module's
 * `runPass` takes an `AbortSignal`, mirroring `glossary/glossary-refresh.ts`.
 * So `stop()` here can actually cancel an in-flight pass rather than only
 * clearing the debounce timer.
 *
 * The debounce timer is `unref`'d: a pending pass must never hold this
 * long-lived gateway process open.
 */
export function createPremortemRefresher(deps: PremortemRefresherDeps): PremortemRefresher {
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
        deps.onError(err);
      })
      .finally(() => {
        running = false;
        if (dirty) {
          dirty = false;
          // Re-enters through `fire`, so a `stop()` that landed during the
          // pass is honoured by the single check at the top rather than
          // duplicated here.
          fire();
        }
      });
  }

  return {
    trigger(): void {
      // Belt-and-braces here (`fire` checks `stopped` too), but not
      // redundant for SHUTDOWN: an unref'd pending `setTimeout` is harmless,
      // but arming one after `stop()` would still be scheduling a no-op.
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
      // Never hold the process open for a background pass.
      timer.unref?.();
    },

    async runNow(): Promise<PremortemPassResult> {
      if (stopped) {
        throw new PremortemRefresherError("ERR_PREMORTEM_STOPPED: the gateway is shutting down");
      }
      if (running) {
        // Deliberately NOT "await the in-flight pass and return its result":
        // that pass is not the one the caller asked for.
        throw new PremortemRefresherError(
          "ERR_PREMORTEM_PASS_RUNNING: a pre-mortem pass is already running",
        );
      }
      running = true;
      try {
        return await deps.runPass(controller.signal);
      } finally {
        running = false;
        // Preserve the scheduled path's dirty-rerun: a sync that landed
        // during this on-demand pass still gets its follow-up.
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
      // Aborting is what makes shutdown responsive: `runPremortemPass` checks
      // the signal between batches, so an in-flight pass returns instead of
      // continuing against a database that is about to close.
      controller.abort();
    },
  };
}
