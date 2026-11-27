// Phase 7 (the Cost Pack, slice 5): what a cost sync could NOT read, per source, for the views' freshness.
//
// The GitHub billing sync keeps a fixed-text gap per organization it could not read (no billing access, not
// on the enhanced billing platform, an Enterprise Server base) in its own cursor, which the sync scheduler
// stores in `scheduler_state.cursor`. This module owns that cursor's codec (the syncable writes it through
// `encodeGithubBillingCursor`) so `finops/` can read the gaps without importing `connectors/` (static D48).
// Read only; a cursor that does not decode reads as no gap.
import type { Database } from "bun:sqlite";

import { loadSchedulerState } from "../sync/scheduler-store.ts";

const PREFIX = "nimbus-ghb1:";
const GITHUB_BILLING = "github_billing";

/** The GitHub billing cursor: a fixed-text gap per org that could not be read, and each org's last sync day. */
export type GithubBillingCursor = {
  readonly gaps: Readonly<Record<string, string>>;
  readonly synced: Readonly<Record<string, string>>;
};

export function encodeGithubBillingCursor(c: GithubBillingCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string") out[k] = x;
  }
  return out;
};

export function decodeGithubBillingCursor(raw: string | null): GithubBillingCursor {
  if (raw === null || !raw.startsWith(PREFIX)) return { gaps: {}, synced: {} };
  try {
    const v: unknown = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8"),
    );
    const rec = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { gaps: stringMap(rec["gaps"]), synced: stringMap(rec["synced"]) };
  } catch {
    return { gaps: {}, synced: {} };
  }
}

/** Per cost source, the gaps its sync recorded (sorted), or an empty map. */
export function readCostSourceGaps(db: Database): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const row = loadSchedulerState(db, GITHUB_BILLING);
  const gaps = Object.values(decodeGithubBillingCursor(row?.cursor ?? null).gaps);
  if (gaps.length > 0) out.set(GITHUB_BILLING, [...gaps].sort());
  return out;
}
