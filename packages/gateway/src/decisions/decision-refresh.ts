import type { DecisionPassSummary } from "./decision-extract.ts";

/** Carries `rpcCode` so a future `ipc/decisions-rpc.ts` maps it without re-deriving a code. */
export class DecisionRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "DecisionRefresherError";
    this.rpcCode = -32000;
  }
}

export type DecisionRunOptions = {
  /** Reserved for a future `rebuildDecisions` path; the debounced `trigger()` path never sets it. */
  rebuild?: boolean;
};

export type DecisionRefresherDeps = {
  debounceMs: number;
  /** Injected rather than imported so the module is testable without a Database. */
  runPass: (opts?: DecisionRunOptions) => Promise<DecisionPassSummary>;
  onError?: (err: unknown) => void;
};

export type DecisionRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Runs a pass immediately, bypassing the debounce. Shares the single-flight
   * guard with the scheduled path: a scheduled pass and an on-demand pass must
   * never run concurrently, since both write `decision_record` and the pass
   * watermark.
   */
  run: (opts?: DecisionRunOptions) => Promise<DecisionPassSummary>;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the decision extraction pass.
 *
 * Mirrors `glossary/glossary-refresh.ts`: a burst of connector syncs must
 * coalesce into ONE pass. A trigger arriving while a pass is already running
 * sets a DIRTY flag rather than queueing: exactly one follow-up pass runs
 * afterwards, no matter how many syncs landed meanwhile, so a slow pass
 * cannot accumulate a backlog of redundant work. Dropping the trigger
 * outright would lose the items of whichever sync overlapped the pass until
 * some later sync triggered again.
 *
 * LIMIT — `stop()` is not cancellation. It clears the debounce timer only; a
 * pass already awaiting `provider.generate` runs to completion, and there is
 * no timeout beneath it. A hung local model therefore pins `running = true`
 * for the life of the process, and every later `run()` throws
 * `ERR_DECISIONS_PASS_RUNNING` until the gateway restarts — which is the
 * documented recovery (`docs/cli-reference.md`, `nimbus decisions`).
 *
 * Adding an `AbortController` here would NOT fix that: the abort has nowhere
 * to go, because `LlmGenerateOptions` carries no `signal` field. The fix is
 * that cross-cutting LLM-layer change, which glossary needs identically — see
 * the LIMIT notes in `decisions/decision-llm-adapter.ts` and
 * `glossary/glossary-llm-adapter.ts`. Do it there first, then give this
 * refresher a per-pass controller.
 */
export function createDecisionRefresher(deps: DecisionRefresherDeps): DecisionRefresher {
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
          // Re-enters through `fire`, so a `stop()` that landed during the pass
          // is honoured by the single check at the top rather than duplicated
          // here.
          fire();
        }
      });
  }

  return {
    trigger(): void {
      // Belt-and-braces here (`fire` checks `stopped` too), but not redundant
      // for SHUTDOWN: a pending `setTimeout` keeps Bun's event loop alive, so
      // arming one here would delay process exit by up to `debounceMs` to run
      // a no-op.
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },

    async run(opts?: DecisionRunOptions): Promise<DecisionPassSummary> {
      if (stopped) {
        throw new DecisionRefresherError("ERR_DECISIONS_STOPPED: the gateway is shutting down");
      }
      if (running) {
        // Deliberately NOT "await the in-flight pass and return its summary":
        // that pass is not the one the caller asked for.
        throw new DecisionRefresherError(
          "ERR_DECISIONS_PASS_RUNNING: a decisions pass is already running",
        );
      }
      running = true;
      try {
        return await deps.runPass(opts);
      } finally {
        running = false;
        // Preserve the scheduled path's dirty-rerun: a sync that landed during
        // this on-demand pass still gets its follow-up.
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
    },
  };
}
