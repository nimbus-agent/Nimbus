// packages/gateway/src/egress/egress-boot-marker.ts
import type { Database } from "bun:sqlite";
import { type CoverageVector, serializeCoverage } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";

/** `method` for every boot marker row. Stable — `coverageForWindow` selects on it. */
export const BOOT_MARKER_METHOD = "egress.boot";

/**
 * Append this process's boot marker.
 *
 * Without it, a window with no covering marker produces an empty ledger and reads as a clean `0` —
 * a false zero indistinguishable from real silence. The marker is what makes that case report
 * `indeterminate` instead. Note this is about the WINDOW, not the binary: `THIS_BINARY_COVERAGE`
 * (the value passed in as `coverage`) is a compile-time constant decoupled from whether a sink is
 * actually wired, so a build that drops the sink but still runs this append still claims
 * `task=per-call` regardless of what it wires — it is a window lacking ANY marker (e.g. one that
 * predates every process that has ever booted, or one served by a binary old enough not to call
 * this function) that claims nothing.
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
