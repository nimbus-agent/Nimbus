import type { GlossaryPassSummary } from "./glossary-extract.ts";
import type { GlossaryPassProgress } from "./glossary-types.ts";

/** Carries `rpcCode` so `ipc/glossary-rpc.ts` maps it without re-deriving a code. */
export class GlossaryRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "GlossaryRefresherError";
    this.rpcCode = -32000;
  }
}

export type GlossaryRunOptions = {
  rebuild: boolean;
  onProgress?: (p: GlossaryPassProgress) => void;
};

export type GlossaryRefresherDeps = {
  enabled: boolean;
  debounceMs: number;
  /**
   * Injected rather than imported so the module is testable without a Database.
   *
   * The signal is aborted by `stop()`, so a pass in flight at shutdown stops at
   * its next checkpoint instead of running on against a closing database.
   */
  runPass: (signal: AbortSignal, opts: GlossaryRunOptions) => Promise<GlossaryPassSummary>;
  onError?: (err: unknown) => void;
};

export type GlossaryRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Runs a pass immediately, bypassing the debounce, for `nimbus glossary
   * --refresh`/`--rebuild`. Shares the single-flight guard with the scheduled
   * path: a scheduled pass and an on-demand pass must never run concurrently,
   * since both would write the watermark and `glossary_term`, and both spend
   * local-LLM time.
   */
  runNow: (opts: GlossaryRunOptions) => Promise<GlossaryPassSummary>;
  /** Synchronous, so an RPC handler can reject a concurrent request before starting a job. */
  status: () => "idle" | "running" | "stopped" | "disabled";
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
      .runPass(controller.signal, { rebuild: false })
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

    status(): "idle" | "running" | "stopped" | "disabled" {
      if (stopped) return "stopped";
      if (!deps.enabled) return "disabled";
      return running ? "running" : "idle";
    },

    async runNow(o: GlossaryRunOptions): Promise<GlossaryPassSummary> {
      // Order matters: a disabled glossary is a config problem the user can
      // fix, a stopped one is not, and both are more useful answers than
      // "already running".
      if (!deps.enabled) {
        throw new GlossaryRefresherError(
          "ERR_GLOSSARY_DISABLED: the glossary is disabled — set [glossary].enabled = true in nimbus.toml",
        );
      }
      if (stopped) {
        throw new GlossaryRefresherError("ERR_GLOSSARY_STOPPED: the gateway is shutting down");
      }
      if (running) {
        // Deliberately NOT "await the in-flight pass and return its summary":
        // that pass is not the one the caller asked for, and for a rebuild it
        // would report success for work that never happened.
        throw new GlossaryRefresherError(
          "ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running",
        );
      }
      running = true;
      try {
        return await deps.runPass(controller.signal, o);
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
      // Aborting is what makes shutdown responsive: `runGlossaryPass` checks
      // the signal between terms, so an in-flight pass returns instead of
      // continuing to consolidate against a database that is about to close.
      controller.abort();
    },
  };
}
