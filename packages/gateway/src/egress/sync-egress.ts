// packages/gateway/src/egress/sync-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * Syncables registered on the SAME `SyncScheduler` as every cloud connector that make NO outbound
 * network request at all — they index local machine state (the filesystem, git blame, a local
 * OpenAPI spec file, a local Obsidian vault) and never call `fetch`.
 * `sync/scheduler.ts`'s `appendSyncEgress` fires unconditionally for every registered syncable's
 * run, so without this exclusion a machine with ZERO cloud connectors configured would still see a
 * `sync` egress row every ~10 minutes per local indexer — hundreds of fabricated
 * "outbound egress" events a day on a genuinely local-first install. That is the same honesty
 * failure I29 exists to prevent, pointed the other way: over-claiming egress that provably never
 * left the machine, instead of under-claiming egress that did.
 *
 * Mirrors the `NULL_EGRESS_SINK` precedent (`egress-ledger.ts`): a syncable that performs a LOCAL
 * mutation, not egress, must not be ledgered as egress. Frozen and exported so a rename of one of
 * these `serviceId`s, or a future fifth local-only indexer, is a deliberate edit here — pinned by
 * `sync-egress.test.ts`, which asserts both this exact set AND that each real syncable's
 * `serviceId` constant is a member — rather than a silent resumption of the over-count.
 *
 * Service ids, not `Syncable` references: `recordSyncEgress` only ever sees the `destination`
 * string a caller already resolved (`job.serviceId` from the scheduler, a `FetchableService` from
 * `targetedFetch` — never a member of this set, since none of the four local indexers are
 * fetch-host-boundary services), so a string-keyed set is the natural check at this chokepoint.
 */
export const LOCAL_ONLY_SYNC_SERVICES: ReadonlySet<string> = new Set([
  "filesystem", // connectors/filesystem-v2-sync.ts
  "blame", // connectors/blame-index-sync.ts (git blame)
  "openapi", // connectors/openapi-indexer-sync.ts (a local API-spec FILE, not an HTTP call)
  "obsidian", // connectors/obsidian-sync.ts (a local vault)
]);

/**
 * The sole append site for `sync` egress rows (I29, D22(b)) — shared by FOUR of that class's
 * appenders: `sync/scheduler.ts`'s per-RUN `appendSyncEgress` (one row before `connector.sync(...)`
 * in `runJob`), `sync/targeted-fetch.ts`'s per-CALL `appendEgress` (one row before `fetchOne`),
 * `multimodal/cloud-url-resolver.ts`'s `resolveCloudByteUrl` (one row before the CREDENTIALED
 * round-trip that asks Google Photos or OneDrive where an artifact's bytes live — `method` is
 * `media.resolveByteUrl`; the Google Drive arm constructs its URL with no round-trip at all and
 * appends nothing there), and `multimodal/cloud-bytes.ts`'s `fetchCloudBytes` (one row per FETCH
 * ATTEMPT, `method` `media.fetchBytes`, before each cloud byte-fetch of a Drive/Photos/OneDrive
 * artifact — a retried request appends again, since a retry really does dispatch a fresh outbound
 * request). The last two are the reason a single Photos/OneDrive candidate produces TWO rows: it
 * makes two real outbound requests, and one row covering both would have meant a candidate that
 * failed at RESOLVE left no row at all for a request that had already gone out.
 * `packages/gateway/src/platform/assemble.ts` is the only production caller of the first two
 * seams; it injects a thin closure around this function into `new SyncScheduler(...)` and into
 * `TargetedFetchDeps`. The last two seams are wired together by
 * `multimodal/build-media-pass-deps.ts`'s `buildCloudBytesDeps`, whose single
 * `MediaCloudDeps.appendEgress` closure reaches both (`media-pass.ts` hands it to the resolver and
 * to the byte fetch alike). None of the four callers imports the raw
 * `appendEgressEntry` (D22(b) confines that identifier to this directory).
 *
 * `per-run` is the honest coverage granularity for the `sync` class as a whole (see the `sync`
 * paragraph on `THIS_BINARY_COVERAGE` in `egress-coverage.ts`): a scheduled sync is a paginated run
 * that can make many upstream calls and appends exactly ONE row for the whole run, a targeted
 * fetch appends one row for its one call, and each cloud resolve/byte-fetch appends one row per
 * request — the weakest of the four shapes is what the coverage vector must claim, and `per-run`
 * is that shape.
 *
 * A `destination` in `LOCAL_ONLY_SYNC_SERVICES` is a no-op — deliberately, and checked HERE rather
 * than at any call site, so all four appenders (and any future one) enforce the rule identically
 * instead of each needing its own copy of the exclusion list. Returns `undefined` in that case too,
 * so a caller cannot distinguish "skipped" from "appended" and is never tempted to branch on it.
 *
 * Called BEFORE the outbound call by all four callers; throwing here aborts the caller's
 * run/fetch before any connector call is made — fail-closed, no row means no dispatch. Returns
 * `undefined`, never `void`: the callers' own seam types (`sync/targeted-fetch.ts`'s `appendEgress`
 * especially) are typed to return `undefined` so that an `async` implementation assigned there is a
 * compile error — see that file's doc comment for why an async append would break the fail-closed
 * property. Matching that return type here, rather than `void`, keeps this function assignable to
 * any of the four seams without a wrapping arrow function hiding an accidental async leak.
 */
export function recordSyncEgress(
  db: Database,
  args: {
    readonly destination: string;
    readonly method: string;
    readonly now: number;
    /**
     * The label of the client that ASKED for this outbound call, when one did.
     *
     * Absent for the scheduler, which runs on its own timer — so `sourceId: null`
     * on a `sync` row means "not caller-initiated" rather than "unknown", and a
     * reader can separate a fetch someone asked for from a background sync
     * nobody did without inferring it from `method`.
     *
     * Server-derived at every call site (the verified token label), never taken
     * from a request body: a caller-supplied label would let one client file its
     * egress under another's name.
     */
    readonly sourceId?: string | undefined;
  },
): { rowHash: string } | undefined {
  if (LOCAL_ONLY_SYNC_SERVICES.has(args.destination)) {
    return undefined;
  }
  return appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "sync",
    // Empty collapses to null: an empty string would read as "attributed to a
    // client whose label is blank", a claim the gateway cannot support.
    sourceId: args.sourceId === undefined || args.sourceId === "" ? null : args.sourceId,
    destination: args.destination,
    method: args.method,
    payloadSummary: redactEgressSummary({ method: args.method }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
