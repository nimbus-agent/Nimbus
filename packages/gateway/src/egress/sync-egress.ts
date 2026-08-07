// packages/gateway/src/egress/sync-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * The sole append site for `sync` egress rows (I29, D22(b)) — shared by BOTH of that class's
 * appenders: `sync/scheduler.ts`'s per-RUN `appendSyncEgress` (one row before `connector.sync(...)`
 * in `runJob`) and `sync/targeted-fetch.ts`'s per-CALL `appendEgress` (one row before `fetchOne`).
 * `packages/gateway/src/platform/assemble.ts` is the only production caller of either seam; it
 * injects a thin closure around this function into `new SyncScheduler(...)` and into
 * `TargetedFetchDeps`, never the raw `appendEgressEntry` (D22(b) confines that identifier to this
 * directory).
 *
 * `per-run` is the honest coverage granularity for the `sync` class as a whole (see the `sync`
 * paragraph on `THIS_BINARY_COVERAGE` in `egress-coverage.ts`): a scheduled sync is a paginated run
 * that can make many upstream calls and appends exactly ONE row for the whole run, while a targeted
 * fetch appends one row for its one call — the weaker of the two shapes is what the coverage vector
 * must claim, and `per-run` is that shape.
 *
 * Called BEFORE the outbound call by both callers; throwing here aborts the caller's run/fetch
 * before any connector call is made — fail-closed, no row means no dispatch. Returns `undefined`,
 * never `void`: both callers' own seam types (`sync/targeted-fetch.ts`'s `appendEgress` especially)
 * are typed to return `undefined` so that an `async` implementation assigned there is a compile
 * error — see that file's doc comment for why an async append would break the fail-closed property.
 * Matching that return type here, rather than `void`, keeps this function assignable to either seam
 * without a wrapping arrow function hiding an accidental async leak.
 */
export function recordSyncEgress(
  db: Database,
  args: {
    readonly destination: string;
    readonly method: string;
    readonly now: number;
  },
): undefined {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "sync",
    sourceId: null,
    destination: args.destination,
    method: args.method,
    payloadSummary: redactEgressSummary({ method: args.method }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
  return undefined;
}
