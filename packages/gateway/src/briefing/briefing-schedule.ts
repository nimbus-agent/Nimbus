import { nextFire } from "../automation/cron.ts";

/**
 * Which slot, if any, a scheduler tick should act on (Phase 10 MB5). Pure: the clock, the zone and the
 * "last fire" are parameters, so DST, catch-up and re-enable are table-driven tests with no timers.
 *
 *   cursor = max(baseline, lastSlotAt ?? baseline, now - 25 h)
 *
 * Every cron slot after the cursor and not after `now` is due; only the LATEST is acted on (older ones are
 * absorbed into it): within `CATCH_UP_WINDOW_MS` of its time it runs, later than that it is recorded as
 * skipped. `baseline` keeps a first-ever start (or a freshly enabled briefing) from inventing history. The
 * 25 h clamp bounds the loop: the schedule validator guarantees slots at least an hour apart.
 *
 * DST comes from `nextFire`: a wall time inside a spring-forward gap does not exist and that day has no
 * slot (a stated bound); a repeated fall-back minute fires once, at its first occurrence.
 */
export const CATCH_UP_WINDOW_MS = 3 * 3_600_000;
const LOOKBACK_MS = 25 * 3_600_000;
export const MAX_SLOT_STEPS = 30;
export const MISSED_REASON = "missed while the gateway was not running";

export type FirePlan =
  | { readonly kind: "none" }
  | { readonly kind: "run"; readonly slotAt: number }
  | { readonly kind: "skip"; readonly slotAt: number; readonly reason: string };

export type PlanFireInput = {
  readonly schedule: string;
  readonly tz: string;
  readonly nowMs: number;
  readonly baselineMs: number;
  readonly lastSlotAt: number | null;
  /** Test seam: counts or replaces the cron search. */
  readonly next?: (expr: string, tz: string, afterMs: number) => number | undefined;
};

export function planFire(input: PlanFireInput): FirePlan {
  const next = input.next ?? nextFire;
  let cursor = Math.max(
    input.baselineMs,
    input.lastSlotAt ?? input.baselineMs,
    input.nowMs - LOOKBACK_MS,
  );
  let latest: number | undefined;
  for (let i = 0; i < MAX_SLOT_STEPS; i++) {
    const slot = next(input.schedule, input.tz, cursor);
    if (slot === undefined || slot > input.nowMs) break;
    latest = slot;
    cursor = slot;
  }
  if (latest === undefined) return { kind: "none" };
  if (input.nowMs - latest <= CATCH_UP_WINDOW_MS) return { kind: "run", slotAt: latest };
  return { kind: "skip", slotAt: latest, reason: MISSED_REASON };
}
