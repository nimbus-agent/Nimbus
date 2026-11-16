import type { Database } from "bun:sqlite";

import { queryOncallNow } from "../index/oncall-now-query.ts";

/**
 * "Is the local owner on call for this service right now?", proved from the index only (Phase 10 IC3, design G
 * step 4). THE ONE function that decides the on-call half of the proof a non-PagerDuty record needs before it is
 * pushed, so loosening or tightening that rule is a change here and nowhere else.
 *
 * It asks `queryOncallNow` for each PagerDuty service id the service is configured with by EXACT id
 * (`pagerdutyServiceId`, never the `term` path, whose service-name and schedule-name SUBSTRING matches could
 * accept an unrelated schedule). `yes` needs a shift whose `isMe` is set AND data fetched within the staleness
 * bound; anything the index cannot prove is not `yes`:
 *
 * - `yes`: some id has a current shift of yours from fresh data.
 * - `stale`: the data that would answer is older than the bound, so it proves nothing either way.
 * - `no`: fresh shift data exists and it is not you (or nobody is on call).
 * - `no_data`: no shift rows for any of the ids, or the service has no PagerDuty service ids at all. A JSM shift
 *   carries no service mapping, so it can never prove this.
 *
 * `isMe` is set only when PagerDuty's `/users/me` or `pagerduty.from_email` resolved the owner, so a gateway
 * without that identity answers `no`, never `yes`.
 */
export type OwnerOnCall = "yes" | "no" | "no_data" | "stale";

export function ownerOnCallForService(
  db: Database,
  service: { readonly pagerdutyServices: readonly string[] },
  nowMs: number,
): OwnerOnCall {
  let fresh: OwnerOnCall = "no_data";
  let sawStale = false;
  for (const id of service.pagerdutyServices) {
    const r = queryOncallNow(db, { nowMs, pagerdutyServiceId: id });
    if (r.status === "no_data" || r.status === "no_match") continue;
    const stale = r.sources.some((s) => s.stale);
    if (stale) {
      sawStale = true;
      continue;
    }
    if (r.status === "ok" && r.youAreOnCall) return "yes";
    fresh = "no";
  }
  if (sawStale) return "stale";
  return fresh;
}
