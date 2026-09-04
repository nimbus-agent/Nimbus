import { createPassScheduler, type PassRefusal } from "../util/pass-scheduler.ts";
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
 * Debounced, single-flight trigger for the glossary extraction pass. The debounce, the
 * single-flight guard and the dirty-rerun all live in `util/pass-scheduler.ts`, shared with the
 * decisions, ownership and pre-mortem passes — this module supplies only what is specific to the
 * glossary: the `[glossary].enabled` kill switch, the summary type, and the `ERR_GLOSSARY_*`
 * codes.
 *
 * This is the ONLY one of the four with an `enabled` flag, which is why it is also the only one
 * exposing `status()` — the scheduler's fourth state, `"disabled"`, is unreachable without it.
 */
export function createGlossaryRefresher(deps: GlossaryRefresherDeps): GlossaryRefresher {
  const scheduler = createPassScheduler<GlossaryPassSummary, GlossaryRunOptions>({
    isEnabled: () => deps.enabled,
    debounceMs: deps.debounceMs,
    runPass: deps.runPass,
    scheduledOptions: { rebuild: false },
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    refuse: (kind) => new GlossaryRefresherError(GLOSSARY_REFUSAL_MESSAGES[kind]),
  });

  return {
    trigger: scheduler.trigger,
    status: scheduler.status,
    runNow: (o: GlossaryRunOptions) => scheduler.runNow(o),
    stop: scheduler.stop,
  };
}

/**
 * One message per refusal kind. A disabled glossary is a config problem the user can fix, a
 * stopped one is not, and both are more useful answers than "already running" — which is why the
 * scheduler checks them in that order.
 */
const GLOSSARY_REFUSAL_MESSAGES: Record<PassRefusal, string> = {
  disabled:
    "ERR_GLOSSARY_DISABLED: the glossary is disabled — set [glossary].enabled = true in nimbus.toml",
  stopped: "ERR_GLOSSARY_STOPPED: the gateway is shutting down",
  running: "ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running",
};
