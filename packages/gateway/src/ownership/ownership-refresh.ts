import { createPassScheduler } from "../util/pass-scheduler.ts";
import type { OwnershipPassSummary } from "./ownership-pass.ts";

/**
 * Carries `rpcCode` so `ipc/_lib/long-running.ts`'s `rpcCodeOf` can lift it into the
 * `ownership.passError` payload without re-deriving a code, and so a caller can branch on
 * the CLASS rather than string-matching a message. `ipc/ownership-rpc.ts` deliberately does
 * NOT map it — it has no `<X>RpcError` class (see the doc comment there): `startPass`'s sole
 * handler always returns `{ jobId }` synchronously, so nothing there ever throws before
 * returning "hit" or "miss". Mirrors `DecisionRefresherError` (`decisions/decision-refresh.ts`).
 * Both refreshers use -32000 (JSON-RPC implementation-defined server error).
 */
export class OwnershipRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "OwnershipRefresherError";
    this.rpcCode = -32000;
  }
}

export type OwnershipRefresherDeps = {
  readonly debounceMs: number;
  /** Injected rather than imported so this module is testable without a Database. */
  readonly runPass: () => Promise<OwnershipPassSummary>;
  readonly onError?: (err: unknown) => void;
};

export type OwnershipRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Runs immediately, bypassing the debounce, sharing the single-flight guard.
   * Rejects after `stop()` (`ERR_OWNERSHIP_STOPPED`).
   */
  run: () => Promise<OwnershipPassSummary>;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the ownership pass. The debounce, the single-flight guard
 * and the dirty-rerun all live in `util/pass-scheduler.ts`, shared with the glossary, decisions
 * and pre-mortem passes.
 *
 * `run()` shares the scheduler's state with the debounced path: it rejects if a pass is already
 * in flight (never runs two passes concurrently — both write graph relations and would race), and
 * a trigger that lands during an on-demand `run()` still gets its follow-up via the same dirty
 * re-fire, exactly as it would during a debounced pass.
 *
 * LIMIT — `stop()` refuses later runs and clears the debounce timer; a pass already in flight
 * runs to completion, since `runOwnershipPass` takes no signal to abort. Unlike the decisions
 * pass there is no model call underneath, so the unbounded-hang failure mode that pass documents
 * does not apply here: every await is SQLite or a timeout-bounded `git` spawn.
 */
export function createOwnershipRefresher(deps: OwnershipRefresherDeps): OwnershipRefresher {
  const scheduler = createPassScheduler<OwnershipPassSummary, void>({
    debounceMs: deps.debounceMs,
    // The signal is accepted and DISCARDED: `runOwnershipPass` takes none, so there is nowhere
    // to route an abort. `stop()` still refuses every later run, which is what matters here.
    runPass: () => deps.runPass(),
    scheduledOptions: undefined,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    refuse: (kind) =>
      new OwnershipRefresherError(
        kind === "running"
          ? "ERR_OWNERSHIP_PASS_RUNNING: an ownership pass is already running"
          : // `stop()` is a gateway shutdown callback (`platform/assemble.ts` `sidecarStops`).
            // Without this refusal, an on-demand `run()` arriving after shutdown would start a
            // fresh pass and write graph rows while the sidecars close.
            "ERR_OWNERSHIP_STOPPED: the gateway is shutting down",
      ),
  });

  return {
    trigger: scheduler.trigger,
    run: () => scheduler.runNow(undefined),
    stop: scheduler.stop,
  };
}
