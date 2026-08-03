// packages/gateway/src/egress/egress-boot-marker.ts
import type { Database } from "bun:sqlite";
import { type CoverageVector, serializeCoverage } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";

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
