// Phase 7 (the Cost Pack, slice 5): the ONE door through which a syncable writes cost lines (static D24,
// clause `cost-line-confined`). A syncable reaches it only through the `replaceCostLinesForMonth` capability
// (`sync/sync-capabilities.ts`), which binds `source` to the syncable's own service id, so a sync can never
// write, replace or clear another source's lines (a FOCUS import's included).
//
// One call replaces one (source, provider, billing account) tuple's lines for one month: for the CURRENT UTC
// month, day 1 to today; for an earlier month, every calendar day of it (a provider restates days while a month
// is open). A day the sync returned nothing for is cleared. No `cost_import` ledger row is written: that ledger
// records owner file imports only, and a re-sync is idempotent through `replaceCostLines` (`unchanged`).
import type { Database } from "bun:sqlite";

import type { CostLine } from "./cost-line.ts";
import {
  type ReplaceCostLinesResult,
  type RepriceCostLinesResult,
  readCostLinesForAccountMonth,
  replaceCostLines,
  repriceCostLines,
} from "./cost-line-store.ts";
import type { CostRates } from "./cost-rate-price.ts";

export interface CostSyncTarget {
  readonly provider: string;
  readonly billingAccountId: string;
  /** `YYYY-MM` */
  readonly month: string;
}

export class CostSyncIntakeError extends Error {
  override readonly name = "CostSyncIntakeError";
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The UTC days a sync of `month` replaces at `nowMs`. Throws for a malformed or future month. */
export function costSyncDays(month: string, nowMs: number): string[] {
  const m = MONTH_RE.exec(month);
  if (m === null) throw new CostSyncIntakeError(`"${month.slice(0, 16)}" is not a YYYY-MM month`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const current = today.slice(0, 7);
  if (month > current) throw new CostSyncIntakeError(`${month} has not started yet`);
  const last =
    month === current ? Number(today.slice(8, 10)) : new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * Replace `source`'s lines of one (provider, account, month) with `lines`: the month's days, plus the lines' own
 * charge days up to today (a late credit dated before the period). Every line must carry exactly that
 * source, provider, account and month (a sync cannot reach another tuple), or nothing is written.
 */
export function ingestSyncedCostLines(
  db: Database,
  source: string,
  target: CostSyncTarget,
  lines: readonly CostLine[],
  nowMs: number,
): ReplaceCostLinesResult {
  const days = costSyncDays(target.month, nowMs);
  for (const l of lines) {
    if (
      l.source !== source ||
      l.provider !== target.provider ||
      l.billingAccountId !== target.billingAccountId ||
      l.billingPeriod !== target.month
    ) {
      throw new CostSyncIntakeError(
        `a ${source} sync of ${target.provider}/${target.billingAccountId} ${target.month} cannot write a line of ${l.source}/${l.provider}/${l.billingAccountId} ${l.billingPeriod}`,
      );
    }
  }
  // A provider dates a late credit or adjustment before its billing period starts (a charge day outside the
  // month, inside the SAME billing period): the lines own charge days are replaced too, never a day after today.
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const own = new Set(days);
  for (const l of lines) {
    if (own.has(l.chargeDay) || !DAY_RE.test(l.chargeDay)) continue;
    if (l.chargeDay > today) {
      throw new CostSyncIntakeError(
        `a ${source} line is dated ${l.chargeDay}, after today (${today}); it is not written`,
      );
    }
    own.add(l.chargeDay);
  }
  return replaceCostLines(
    db,
    {
      source,
      provider: target.provider,
      billingAccountId: target.billingAccountId,
      billingPeriod: target.month,
    },
    [...own],
    lines,
  );
}

/** `source`'s own stored lines of one (provider, account, month): what a delta sync builds on. Read only. */
export function readOwnSyncedCostLines(
  db: Database,
  source: string,
  target: CostSyncTarget,
): CostLine[] {
  return readCostLinesForAccountMonth(db, source, target);
}

/** Price `source`'s own stored lines again with `rates` (a changed rate or currency; no API call). */
export function repriceSyncedCostLines(
  db: Database,
  source: string,
  rates: CostRates,
): RepriceCostLinesResult {
  return repriceCostLines(db, source, rates);
}
