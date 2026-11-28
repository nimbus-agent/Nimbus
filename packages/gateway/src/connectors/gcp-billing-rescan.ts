// Phase 7 (the Cost Pack, slice 13): BigQuery bills every scan, so a month whose billed scan failed (a result over the
// row cap, an unreadable row, a job that did not finish, a row count that did not match) must not be scanned again
// on every daily run. The cursor records, per month, the day of the failed scan (`failedScan`); a PAST month is
// scanned again at most once every 7 days, the CURRENT month at most once a day. Pure.
import type { GcpFail } from "./gcp-billing-query.ts";

export const GCP_PAST_MONTH_RESCAN_DAYS = 7;
const DAY_MS = 86_400_000;

/** The gap suffix: a retry is a billed scan, and when it runs. */
export const GCP_RESCAN_NOTE =
  "; the next attempt runs another billed BigQuery scan (a past month at most every 7 days, the current month at most once a day)";

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The first day a month whose scan failed on `failedDay` may be scanned again. */
export function nextScanDay(failedDay: string, month: string, today: string): string {
  const days = today.slice(0, 7) === month ? 1 : GCP_PAST_MONTH_RESCAN_DAYS;
  return new Date(dayMs(failedDay) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whether `month` may be scanned on `today`, given the day of its last failed scan (undefined: none). */
export function scanDue(failedDay: string | undefined, month: string, today: string): boolean {
  if (failedDay === undefined) return true;
  return today >= nextScanDay(failedDay, month, today);
}

/** The outcome a failed billed scan shows: never a silent retry, always saying the next attempt is billed. */
export function failedScanOutcome(r: GcpFail, month: string): GcpFail {
  if (r.kind === "retry") {
    return {
      kind: "month_gap",
      reason: `a BigQuery request failed after the ${month} scan started${GCP_RESCAN_NOTE}`,
    };
  }
  return { ...r, reason: r.reason + GCP_RESCAN_NOTE };
}
