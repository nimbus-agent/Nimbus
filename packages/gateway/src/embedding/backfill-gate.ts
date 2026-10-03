import type { HostActivity } from "../platform/host-activity.ts";

/**
 * Consulted before EVERY backfill batch. Resolves `true` when the batch may proceed and `false`
 * when the backfill must stop for good. A gate that is PAUSING simply does not resolve yet — that
 * is what makes "pause" mean pause rather than "abandon until the next gateway restart", which is
 * the shape a plain early-`return` would have had: nothing re-triggers `startBackgroundJobs()`
 * after boot, so a run that gave up would never have come back.
 */
export type BackfillGate = () => Promise<boolean>;

/** How often a paused backfill re-probes power. Long enough to be free, short enough to feel live. */
export const DEFAULT_BACKFILL_POLL_MS = 30_000;

export interface BatteryBackfillGateDeps {
  /** `[embedding] pause_on_battery`. `false` returns a gate that never pauses. */
  readonly pauseOnBattery: boolean;
  readonly hostActivity: HostActivity;
  readonly pollMs?: number | undefined;
}

export interface BatteryBackfillGate {
  readonly gate: BackfillGate;
  /**
   * Ends the pause permanently: any waiting `gate()` resolves `false` at once and every later call
   * does the same. Registered in `sidecarStops` by the caller that builds this — the poll timer is
   * deliberately NOT `unref`'d (an unref'd timer does not fire at all when nothing else holds the
   * loop, which makes the pause both untestable and, in a quiet process, permanent), so cancelling
   * it explicitly is what keeps a paused backfill from outliving the thing that started it.
   */
  stop(): void;
}

/**
 * The consumer `[embedding] pause_on_battery` never had.
 *
 * The key has parsed and defaulted to `true` since it was added and NOTHING read it — a key that
 * lied about what it does. `HostActivity` is what it always needed, so this is where the two meet.
 *
 * Only `power === "battery"` pauses. `"unknown"` — a desktop, a VM, a host whose backend could not
 * answer — proceeds: the promise this key makes is "do not drain my battery", not "do not embed
 * unless you can prove I am plugged in", and treating an unmeasurable host as discharging would
 * silently switch semantic search off on every machine without a battery.
 *
 * One handle may back SEVERAL pipelines (the hybrid runtime backfills two), so the sleepers are a
 * SET: a single pending resolver would be overwritten by the second concurrent pause and that
 * backfill would then wait forever on a timer nobody could cancel.
 */
export function createBatteryBackfillGate(deps: BatteryBackfillGateDeps): BatteryBackfillGate {
  const pollMs = deps.pollMs ?? DEFAULT_BACKFILL_POLL_MS;
  const sleepers = new Set<() => void>();
  let stopped = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sleepers.delete(wake);
        resolve();
      }, ms);
      // No double-resolve guard: settling an already-settled promise is a no-op, and a guard here
      // would be a branch nothing can drive to both sides.
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      sleepers.add(wake);
    });

  return {
    gate: async (): Promise<boolean> => {
      for (;;) {
        if (stopped) return false;
        // Checked BEFORE the probe: a disabled key must not spawn a power probe on every batch
        // for an answer nothing will read.
        if (!deps.pauseOnBattery) return true;
        const probe = await deps.hostActivity.probe();
        if (probe.power !== "battery") return true;
        await sleep(pollMs); // NOSONAR S9382: power poll - each pass re-probes only after the previous wait, and the waiting IS the pause
      }
    },
    stop(): void {
      stopped = true;
      const waiting = [...sleepers];
      sleepers.clear();
      for (const wake of waiting) wake();
    },
  };
}
