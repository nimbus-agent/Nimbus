// Phase 7 (the Cost Pack, slice 5): what a cost sync could NOT read, per source, for the views' freshness.
//
// The GitHub billing sync keeps a fixed-text gap per organization it could not read (no billing access, not
// on the enhanced billing platform, an Enterprise Server base) in its own cursor, which the sync scheduler
// stores in `scheduler_state.cursor`. This module owns that cursor's codec (the syncable writes it through
// `encodeGithubBillingCursor`) so `finops/` can read the gaps without importing `connectors/` (static D48).
// Read only; a cursor that does not decode reads as no gap.
import type { Database } from "bun:sqlite";

import { loadSchedulerState } from "../sync/scheduler-store.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

const PREFIX = "nimbus-ghb1:";
const GITHUB_BILLING = "github_billing";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The GitHub billing cursor: a fixed-text gap per org that could not be read, each org's last sync day, and
 * the months a run could not finish for an org (fetched again on every run until one succeeds).
 */
export type GithubBillingCursor = {
  readonly gaps: Readonly<Record<string, string>>;
  readonly synced: Readonly<Record<string, string>>;
  readonly pending: Readonly<Record<string, readonly string[]>>;
};

const EMPTY: GithubBillingCursor = { gaps: {}, synced: {}, pending: {} };

export function encodeGithubBillingCursor(c: GithubBillingCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(asRecord(v))) {
    if (typeof x === "string" && k !== "__proto__") out[k] = x;
  }
  return out;
};

const monthListMap = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [k, x] of Object.entries(asRecord(v))) {
    if (!Array.isArray(x) || k === "__proto__") continue;
    const months = (x as unknown[]).filter(
      (m): m is string => typeof m === "string" && MONTH_RE.test(m),
    );
    if (months.length > 0) out[k] = months;
  }
  return out;
};

export function decodeGithubBillingCursor(raw: string | null): GithubBillingCursor {
  if (!raw?.startsWith(PREFIX)) return EMPTY;
  try {
    const rec = asRecord(
      JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8")),
    );
    return {
      gaps: stringMap(rec["gaps"]),
      synced: stringMap(rec["synced"]),
      pending: monthListMap(rec["pending"]),
    };
  } catch {
    return EMPTY;
  }
}

/** Per cost source, the gaps its sync recorded (sorted), or an empty map. */
export function readCostSourceGaps(db: Database): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const row = loadSchedulerState(db, GITHUB_BILLING);
  const gaps = Object.values(decodeGithubBillingCursor(row?.cursor ?? null).gaps);
  if (gaps.length > 0) out.set(GITHUB_BILLING, [...gaps].sort(codeUnitCompare));
  return out;
}
