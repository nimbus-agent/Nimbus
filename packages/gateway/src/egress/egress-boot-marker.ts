// packages/gateway/src/egress/egress-boot-marker.ts
import type { Database } from "bun:sqlite";
import {
  ALL_NONE_COVERAGE,
  type CoverageVector,
  parseCoverage,
  serializeCoverage,
  weakestCoverage,
} from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { listEgress } from "./egress-verify.ts";

/** `method` for every boot marker row. Stable — `coverageForWindow` selects on it. */
export const BOOT_MARKER_METHOD = "egress.boot";

/**
 * Append this process's boot marker.
 *
 * Without it, a build that never wires a sink produces an empty ledger and every window reads as a
 * clean `0` — a false zero indistinguishable from real silence. The marker is what makes that case
 * report `indeterminate` instead.
 *
 * The vector goes in `source_id` because `source_id` IS an input to `computeEgressRowHash`; a
 * coverage claim that could be edited without breaking the chain would be worthless.
 */
export function appendBootMarker(db: Database, coverage: CoverageVector, now: number): void {
  appendEgressEntry(db, {
    timestamp: now,
    sourceType: "boot",
    sourceId: serializeCoverage(coverage),
    destination: "local",
    method: BOOT_MARKER_METHOD,
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}

/**
 * The coverage that can be claimed for a window: the weakest granularity per class across every
 * boot marker at or before the window's end.
 *
 * Markers strictly AFTER the window are ignored — a binary that started later cannot vouch for what
 * was observed earlier. No covering marker yields all-`none`, i.e. claim nothing.
 *
 * An UNPARSEABLE marker contributes an all-`none` vector rather than being skipped. Skipping it
 * would let a sibling marker's richer claim stand, overstating coverage; contributing all-`none`
 * drives the weakest-merge to `none` everywhere, so the window reports `indeterminate`. This is the
 * "indeterminate, never a false zero" rule — NOT a throw, because one unreadable row must not take
 * `nimbus egress` down. (Deliberate tampering is already caught elsewhere: `source_id` is hashed,
 * so an edited marker breaks `verifyEgressChain`. The case handled here is a marker written by a
 * NEWER binary using a class or granularity this one does not know.)
 */
export function coverageForWindow(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined },
): CoverageVector {
  const rows = listEgress(db, {});
  const vectors: CoverageVector[] = [];
  for (const r of rows) {
    if (r.method !== BOOT_MARKER_METHOD) continue;
    if (opts.until !== undefined && r.timestamp > opts.until) continue;
    const v = r.sourceId === null ? null : parseCoverage(r.sourceId);
    // Unreadable marker → claim nothing for every class (see doc comment).
    vectors.push(v ?? ALL_NONE_COVERAGE);
  }
  return weakestCoverage(vectors);
}
