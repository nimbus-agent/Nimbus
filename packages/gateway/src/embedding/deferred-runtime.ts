/**
 * Bind-first embedding runtime (issue #928).
 *
 * The gateway used to `await` the embedding runtime BEFORE `ipc.start()`. On a cold
 * machine that awaits a MiniLM fetch from a third-party CDN, so `nimbus init` — the very
 * first command a new user runs — could sit for minutes with the socket unbound and no
 * error, indistinguishable from a hang.
 *
 * This wrapper breaks that coupling. It is a SYNCHRONOUS factory: it returns a live
 * `EmbeddingRuntime` on the same tick and runs the real (slow, network-bound) construction
 * in the background. Startup reaches `ipc.start()` immediately; the model catches up.
 *
 * The wrapper also owns the honesty contract while the real runtime is missing or itself
 * still warming: `embedQuery`/`embedQueryDual` THROW `EmbeddingWarmingError` rather than
 * resolve `null`. A null vector during warm-up silently degrades hybrid search to BM25,
 * and a query with no lexical overlap then returns `[]` — a false green that reads exactly
 * like a legitimate "nothing matched". Callers that genuinely want to degrade must say so
 * with `embedQueryBestEffort` / `embedQueryDualBestEffort`.
 *
 * A failed fetch is NOT fatal: init rejection settles the state to `unavailable` and the
 * gateway keeps serving everything that does not need vectors.
 */

import {
  type EmbeddingReadiness,
  type EmbeddingReadinessState,
  EmbeddingWarmingError,
  NO_DUAL_VECTORS,
} from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import type { EmbeddingDualVectors } from "./types.ts";

/** Items buffered while warming. Beyond this the pipeline backfill picks up the rest. */
const DEFAULT_MAX_QUEUED_ITEMS = 2000;

export type DeferredEmbeddingRuntimeDeps = {
  /**
   * Builds the real runtime. Deliberately NOT awaited by the caller — that is the entire
   * point of this module. May reject or throw synchronously; both degrade to `unavailable`.
   */
  init: () => Promise<EmbeddingRuntime | null>;
  /** Identity reported while no real runtime exists yet. */
  fallbackModel: string;
  fallbackDims: number;
  nowMs?: () => number;
  /** Max item ids buffered during warm-up. Defaults to {@link DEFAULT_MAX_QUEUED_ITEMS}. */
  maxQueuedItems?: number;
  /** Best-effort observability hook, fired whenever the settled state changes. */
  onStateChange?: (readiness: EmbeddingReadiness) => void;
};

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message === "" ? err.name : err.message;
  }
  return String(err);
}

export function createDeferredEmbeddingRuntime(
  deps: DeferredEmbeddingRuntimeDeps,
): EmbeddingRuntime {
  const now = deps.nowMs ?? ((): number => Date.now());
  const maxQueued = deps.maxQueuedItems ?? DEFAULT_MAX_QUEUED_ITEMS;
  const startedMs = now();

  let delegate: EmbeddingRuntime | null = null;
  /** State owned by THIS wrapper. Once a delegate exists, the delegate's state wins. */
  let ownState: Exclude<EmbeddingReadinessState, "ready"> = "warming";
  let reason: string | null = null;
  let settledMs: number | null = null;
  let terminated = false;
  let backgroundRequested = false;
  const queued: string[] = [];

  function effectiveState(): EmbeddingReadinessState {
    if (terminated) {
      return ownState === "warming" ? "disabled" : ownState;
    }
    if (delegate === null) {
      return ownState;
    }
    return delegate.getReadiness().state;
  }

  function elapsedMs(state: EmbeddingReadinessState): number {
    // Freeze on the first observation of a settled state so `elapsedMs` reads as
    // "time spent warming" rather than "process uptime".
    if (state !== "warming" && settledMs === null) {
      settledMs = now();
    }
    return Math.max(0, (settledMs ?? now()) - startedMs);
  }

  function getReadiness(): EmbeddingReadiness {
    const state = effectiveState();
    const inner = delegate?.getReadiness();
    return {
      state,
      elapsedMs: elapsedMs(state),
      model: inner?.model ?? (state === "warming" ? deps.fallbackModel : null),
      dims: inner?.dims ?? (state === "warming" ? deps.fallbackDims : null),
      download: inner?.download ?? null,
      reason: reason ?? inner?.reason ?? null,
    };
  }

  function settleOwn(
    state: Exclude<EmbeddingReadinessState, "ready" | "warming">,
    why: string | null,
  ): void {
    ownState = state;
    reason = why;
    deps.onStateChange?.(getReadiness());
  }

  function adopt(rt: EmbeddingRuntime): void {
    delegate = rt;
    if (terminated) {
      rt.terminate();
      return;
    }
    for (const itemId of queued.splice(0, queued.length)) {
      rt.scheduleItemEmbedding(itemId);
    }
    if (backgroundRequested) {
      rt.startBackgroundJobs();
    }
    deps.onStateChange?.(getReadiness());
  }

  // `(async () => deps.init())()` converts a SYNCHRONOUS throw from init into a rejection,
  // so a broken factory degrades instead of taking the gateway down at boot.
  void (async () => deps.init())()
    .then((rt) => {
      if (rt === null) {
        settleOwn("disabled", null);
        return;
      }
      adopt(rt);
    })
    .catch((err: unknown) => {
      settleOwn("unavailable", errText(err));
    });

  /**
   * Throws while warming; otherwise returns the live runtime, or `null` when vectors are
   * permanently unavailable for this process. Returning the delegate (rather than a boolean)
   * keeps the callers free of a re-null-check that can never actually fire.
   */
  function requireUsableRuntime(): EmbeddingRuntime | null {
    const readiness = getReadiness();
    if (readiness.state === "warming") {
      throw new EmbeddingWarmingError(readiness);
    }
    return readiness.state === "ready" ? delegate : null;
  }

  return {
    scheduleItemEmbedding(itemId: string): void {
      if (delegate !== null) {
        delegate.scheduleItemEmbedding(itemId);
        return;
      }
      if (ownState !== "warming" || terminated) {
        return;
      }
      if (queued.length >= maxQueued) {
        return;
      }
      queued.push(itemId);
    },

    async embedQuery(text: string): Promise<Float32Array | null> {
      const live = requireUsableRuntime();
      if (live === null) {
        return null;
      }
      return live.embedQuery(text);
    },

    async embedQueryDual(text: string): Promise<EmbeddingDualVectors> {
      const live = requireUsableRuntime();
      if (live === null) {
        return { ...NO_DUAL_VECTORS };
      }
      return live.embedQueryDual(text);
    },

    getEmbeddingModel(): string {
      return delegate?.getEmbeddingModel() ?? deps.fallbackModel;
    },

    getEmbeddingDims(): number {
      return delegate?.getEmbeddingDims() ?? deps.fallbackDims;
    },

    getBackfillProgress(): { done: number; total: number } | null {
      return delegate?.getBackfillProgress() ?? null;
    },

    getReadiness,

    startBackgroundJobs(): void {
      if (delegate !== null) {
        if (!backgroundRequested) {
          backgroundRequested = true;
          delegate.startBackgroundJobs();
        }
        return;
      }
      backgroundRequested = true;
    },

    terminate(): void {
      if (terminated) {
        return;
      }
      terminated = true;
      delegate?.terminate();
    },
  };
}
