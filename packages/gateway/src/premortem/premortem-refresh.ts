import { createPassScheduler } from "../util/pass-scheduler.ts";
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
 * Debounced, single-flight trigger for the pre-mortem theme pass. The debounce, the
 * single-flight guard and the dirty-rerun all live in `util/pass-scheduler.ts`, shared with the
 * glossary, decisions and ownership passes.
 *
 * This pass READS the scheduler's `AbortSignal`, unlike decisions and ownership, which accept and
 * discard it. So `stop()` here ends an in-flight pass at its NEXT BATCH BOUNDARY —
 * `runPremortemPass` checks the signal between batches — rather than only refusing later runs. It
 * is still not truly cancellable: a pass blocked inside `llm.complete()` mid-batch cannot be
 * interrupted, since `ThemeLlm.complete` takes no signal of its own (mirrors the LIMIT note in
 * `decisions/decision-llm-adapter.ts`).
 */
export function createPremortemRefresher(deps: PremortemRefresherDeps): PremortemRefresher {
  const scheduler = createPassScheduler<PremortemPassResult, void>({
    debounceMs: deps.debounceMs,
    runPass: (signal) => deps.runPass(signal),
    scheduledOptions: undefined,
    onError: deps.onError,
    refuse: (kind) =>
      new PremortemRefresherError(
        kind === "running"
          ? "ERR_PREMORTEM_PASS_RUNNING: a pre-mortem pass is already running"
          : "ERR_PREMORTEM_STOPPED: the gateway is shutting down",
      ),
  });

  return {
    trigger: scheduler.trigger,
    runNow: () => scheduler.runNow(undefined),
    stop: scheduler.stop,
  };
}
