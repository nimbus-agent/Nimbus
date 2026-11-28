// Phase 7 (the Cost Pack, slices 5, 6 and 8): what a cost sync could NOT read, per source, for the views' freshness.
//
// A cost sync (GitHub billing, OpenAI costs, Anthropic costs) keeps, per account it reads, a fixed-text gap when
// it could not read it, the day it last synced, and the months a run could not finish, in its own cursor, which
// the sync scheduler stores in `scheduler_state.cursor`. This module owns that cursor's codec (the syncables
// write it through `encodeCostSyncCursor`) so `finops/` can read the gaps without importing `connectors/`
// (static D48). Read only; a cursor that does not decode reads as no gap.
import type { Database } from "bun:sqlite";

import { loadSchedulerState } from "../sync/scheduler-store.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Each cost-sync service and its cursor prefix (the prefix is part of the stored cursor; never change one). */
export const COST_SYNC_CURSOR_PREFIXES = Object.freeze({
  github_billing: "nimbus-ghb1:",
  openai_billing: "nimbus-oai1:",
  anthropic_billing: "nimbus-ant1:",
  gitlab_billing: "nimbus-glb1:",
} as const);
export type CostSyncServiceId = keyof typeof COST_SYNC_CURSOR_PREFIXES;

/**
 * A cost sync's cursor, per account (a GitHub org; for OpenAI and Anthropic the one organization the key
 * belongs to): a fixed-text gap when it could not be read, its last sync day, and the months a run could not
 * finish (fetched again on every run until one succeeds).
 */
export type CostSyncCursor = {
  readonly gaps: Readonly<Record<string, string>>;
  readonly synced: Readonly<Record<string, string>>;
  readonly pending: Readonly<Record<string, readonly string[]>>;
  /** Slice 8: the fingerprint of the rates the stored lines were priced with (absent: none recorded). */
  readonly rates?: string;
};

const EMPTY: CostSyncCursor = { gaps: {}, synced: {}, pending: {} };

export function encodeCostSyncCursor(prefix: string, c: CostSyncCursor): string {
  return prefix + Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
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

export function decodeCostSyncCursor(prefix: string, raw: string | null): CostSyncCursor {
  if (!raw?.startsWith(prefix)) return EMPTY;
  try {
    const rec = asRecord(
      JSON.parse(Buffer.from(raw.slice(prefix.length), "base64url").toString("utf8")),
    );
    return {
      gaps: stringMap(rec["gaps"]),
      synced: stringMap(rec["synced"]),
      pending: monthListMap(rec["pending"]),
      ...(typeof rec["rates"] === "string" ? { rates: rec["rates"] } : {}),
    };
  } catch {
    return EMPTY;
  }
}

/** Slice 5 names, kept so the GitHub billing sync and its tests read as before. */
export type GithubBillingCursor = CostSyncCursor;
export const encodeGithubBillingCursor = (c: CostSyncCursor): string =>
  encodeCostSyncCursor(COST_SYNC_CURSOR_PREFIXES.github_billing, c);
export const decodeGithubBillingCursor = (raw: string | null): CostSyncCursor =>
  decodeCostSyncCursor(COST_SYNC_CURSOR_PREFIXES.github_billing, raw);

/** Per cost source, the gaps its sync recorded (sorted), or an empty map. */
export function readCostSourceGaps(db: Database): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [source, prefix] of Object.entries(COST_SYNC_CURSOR_PREFIXES)) {
    const row = loadSchedulerState(db, source);
    const gaps = Object.values(decodeCostSyncCursor(prefix, row?.cursor ?? null).gaps);
    if (gaps.length > 0) out.set(source, [...gaps].sort(codeUnitCompare));
  }
  return out;
}
