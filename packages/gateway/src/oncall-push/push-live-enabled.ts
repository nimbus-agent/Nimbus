/**
 * A synchronous live reader for `[oncall.push] enabled` (role-packs spec § 5.9), so a role pack
 * can turn the pushed brief on or off without a restart. Only `enabled` is live; every other
 * `[oncall.push]` key keeps its boot-time read.
 *
 * Like `FleetSupervisor`, the layered-snapshot `version()` is compared BEFORE `load()`, so an idle
 * gateway never re-reads the section. Unlike it, everything here is synchronous: the config load
 * is synchronous, so the version cannot move during a load and no re-check loop is needed.
 *
 * `reconcile` (`PushStore.reconcileEnabledState`) runs only when the value actually changed: a
 * disable deletes the `oncall_push_state` row, an enable inserts it with `enabled_at = now`, so
 * enabling never backfills history and an unrelated pack change never resets `enabled_at`.
 */

export const ONCALL_PUSH_RELOAD_CHECK_MS = 5_000;

export interface LiveEnabledDeps {
  /** The layered snapshot's version. */
  readonly version: () => number;
  /** Re-reads `[oncall.push] enabled`. May throw. */
  readonly load: () => boolean;
  /** `PushStore.reconcileEnabledState`. */
  readonly reconcile: (enabled: boolean, nowMs: number) => void;
  readonly now: () => number;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
  /** Test seam; production uses ONCALL_PUSH_RELOAD_CHECK_MS. */
  readonly checkMs?: number;
}

export interface LiveEnabled {
  /** Refreshes first when the version moved. Never throws. */
  isEnabled(): boolean;
  /** Idempotent. The interval is `.unref()`'d. */
  start(): void;
  /** Idempotent. Clears the interval; `isEnabled` keeps answering the last value. */
  stop(): void;
}

export function createLiveEnabled(
  deps: LiveEnabledDeps,
  boot: { readonly version: number; readonly enabled: boolean },
): LiveEnabled {
  let enabled = boot.enabled;
  let lastVersion = boot.version;
  let lastLoggedVersion: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  /** Never throws. The timer and `isEnabled` share this one path. */
  function refresh(): void {
    try {
      const version = deps.version();
      if (version === lastVersion) return;
      let next: boolean;
      try {
        next = deps.load();
      } catch (err) {
        // Keep the old value and leave `lastVersion` alone so the next call retries; log once
        // per failing version so a persistent error does not repeat on every tick.
        if (lastLoggedVersion !== version) {
          lastLoggedVersion = version;
          deps.logger.error(
            { err, version },
            "[oncall.push] re-reading enabled failed; keeping the last value",
          );
        }
        return;
      }
      if (next !== enabled) {
        // Reconcile FIRST: the runner must never see "enabled" without its reconciled row. A throw
        // leaves the old value and version so the next refresh retries (reconcile is idempotent).
        try {
          deps.reconcile(next, deps.now());
        } catch (err) {
          if (lastLoggedVersion !== version) {
            lastLoggedVersion = version;
            deps.logger.error(
              { err, version },
              "[oncall.push] reconciling enabled state failed; keeping the last value",
            );
          }
          return;
        }
        enabled = next;
      }
      lastVersion = version;
    } catch (err) {
      deps.logger.error({ err }, "[oncall.push] live enabled refresh failed unexpectedly");
    }
  }

  return {
    isEnabled(): boolean {
      if (!stopped) refresh();
      return enabled;
    },
    start(): void {
      if (timer !== undefined || stopped) return;
      timer = setInterval(refresh, deps.checkMs ?? ONCALL_PUSH_RELOAD_CHECK_MS);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
