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
 * Debounced, single-flight trigger for the ownership pass. Mirrors
 * `decisions/decision-refresh.ts`: a burst of connector syncs must coalesce
 * into ONE pass, and a trigger arriving mid-pass sets a DIRTY flag rather than
 * queueing — exactly one follow-up runs however many syncs landed meanwhile,
 * so a slow pass cannot accumulate a backlog. Dropping the trigger outright
 * would lose whichever sync overlapped the pass until some later sync fired.
 *
 * `run()` shares the same `running`/`dirty` state as the debounced path: it
 * rejects if a pass is already in flight (never runs two passes
 * concurrently — both write graph relations and would race), and a trigger
 * that lands during an on-demand `run()` still gets its follow-up via the
 * same dirty re-fire, exactly as it would during a debounced pass.
 *
 * LIMIT — `stop()` clears the debounce timer only; a pass already in flight
 * runs to completion. Unlike the decisions pass there is no model call
 * underneath, so the unbounded-hang failure mode that pass documents does not
 * apply here: every await is SQLite or a timeout-bounded `git` spawn.
 */
export function createOwnershipRefresher(deps: OwnershipRefresherDeps): OwnershipRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;

  function fire(): void {
    timer = undefined;
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    deps
      .runPass()
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
        if (dirty) {
          dirty = false;
          fire();
        }
      });
  }

  return {
    trigger(): void {
      if (stopped) return;
      if (running) {
        dirty = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },
    async run(): Promise<OwnershipPassSummary> {
      // `stop()` is a gateway shutdown callback (`platform/assemble.ts`
      // `sidecarStops`). Without this, an on-demand `run()` arriving after
      // shutdown would start a fresh pass and write graph rows while the
      // sidecars close. Mirrors `ERR_DECISIONS_STOPPED` in
      // `decisions/decision-refresh.ts`.
      if (stopped) {
        throw new OwnershipRefresherError("ERR_OWNERSHIP_STOPPED: the gateway is shutting down");
      }
      if (running) {
        throw new OwnershipRefresherError(
          "ERR_OWNERSHIP_PASS_RUNNING: an ownership pass is already running",
        );
      }
      running = true;
      try {
        return await deps.runPass();
      } finally {
        running = false;
        if (dirty) {
          dirty = false;
          fire();
        }
      }
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
