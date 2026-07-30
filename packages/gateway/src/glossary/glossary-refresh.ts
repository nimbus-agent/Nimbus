export type GlossaryRefresherDeps = {
  enabled: boolean;
  debounceMs: number;
  /** Injected rather than imported so the module is testable without a Database. */
  runPass: () => Promise<void>;
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
 * A burst of connector syncs must coalesce into ONE pass, and a trigger
 * arriving while a pass is running is DROPPED rather than queued — the next
 * sync will trigger again anyway, and queueing would let a slow pass build an
 * unbounded backlog of redundant work.
 */
export function createGlossaryRefresher(deps: GlossaryRefresherDeps): GlossaryRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  function fire(): void {
    timer = undefined;
    if (running) return;
    running = true;
    deps
      .runPass()
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
      });
  }

  return {
    trigger(): void {
      if (!deps.enabled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },
    stop(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
