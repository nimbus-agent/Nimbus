// packages/gateway/src/egress/egress-source-type.ts

/**
 * The FROZEN `egress_ledger.source_type` union.
 *
 * `source_type` IS one of the fields `computeEgressRowHash` hashes, but widening this union later
 * is NOT a chain break: `verifyEgressChain` recomputes each row's hash from that row's OWN STORED
 * column values (`sourceType: r.source_type`, `egress-verify.ts`), never from the current union
 * definition, so adding a TypeScript member changes no stored row and no hash input — every
 * existing row still verifies exactly as before. (What WOULD be a chain break: changing
 * `computeEgressRowHash`'s input set, or rewriting a stored row's values.)
 *
 * The union is frozen anyway, for two real reasons: (1) a `source_type` value written today is
 * permanent IN THE DATA — every row ever appended keeps whatever string it was given, forever, so
 * the vocabulary must be chosen deliberately rather than casually extended; (2) `isMarkerSourceType`
 * (below) depends on the set of source types being known and closed — an unreviewed new member could
 * silently land outside `MARKER_SOURCE_TYPES` and get miscounted as outbound egress, or inside it and
 * get miscounted as bookkeeping. The union therefore lands COMPLETE, including members whose
 * appenders do not exist yet (`boot`, `degraded` arrive with the boot marker; `sync` and `model`
 * have since landed their appenders — `egress/sync-egress.ts` for `sync`; for `model`,
 * `egress/model-egress.ts` (route-table generates), `egress/mastra-model-egress.ts` (the Mastra
 * engine agent), and `egress/embedding-egress.ts` (remote embeddings) — and their
 * `THIS_BINARY_COVERAGE` entries are raised accordingly; `peer` and `session` remain pending,
 * arriving in later phases).
 *
 * The union was frozen at eight members in #1038. `mcp` was added deliberately in the
 * agents-as-MCP-tools work as the ninth and, per `docs/ecosystem-roadmap.md` § "Cross-cutting
 * decisions to make once", as the taxonomy decision that closes the union. The freeze's own
 * prescription — reuse `session` with a reserved `method` — was rejected because `session` must go
 * on claiming `none` coverage until its real appenders (telemetry, updater, JWKS) land, which would
 * have recorded MCP briefs and disclaimed them in the same breath. A further class still needs an
 * explicit decision recorded here; it is not a casual append.
 *
 * `http` is that further class, and this is its decision. It arrived when agent briefs became
 * invocable over the local HTTP API, and it is named for the VERIFIABLE TRANSPORT rather than for a
 * caller-declared client kind. Folding those rows into `mcp` was the obvious shortcut and the wrong
 * one: over stdio, `mcp` is ultimately a client's self-declaration at handshake, whereas an HTTP
 * caller's transport is a fact the gateway observed and whose identity it verified against the
 * token map. One string for two different attribution strengths would be permanent in every row and
 * unrecoverable afterwards. Reusing `session` was rejected again, for the same reason it was
 * rejected for `mcp`.
 *
 * Like `mcp`, the class covers LESS than its name suggests: it is agent briefs served over HTTP,
 * NOT "everything on the HTTP API". The narrowing is recorded machine-readably in
 * `THIS_BINARY_COVERAGE` (egress-coverage.ts), which is what a consumer actually reads.
 *
 * `outcome` is the eleventh member, and the FIRST admitted as a MARKER rather than an egress class.
 * It records how a targeted fetch ended. The authorising row structurally cannot say: `targetedFetch`
 * appends it BEFORE calling the connector — fail-closed, no row means no fetch — so its
 * `result_status` records the authorisation decision, and a fetch that 404s or times out still
 * reads `authorized`.
 *
 * Marker, not egress class, IS the decision. The row is bookkeeping about an outbound call this
 * ledger has already counted; counting it again would double every targeted fetch and inflate the
 * exact number I29 exists to state honestly. Because it joins `MARKER_SOURCE_TYPES` it claims no
 * coverage granularity, `COVERAGE_CLASSES` is untouched, and the existing
 * "COVERAGE_CLASSES is exactly the non-marker source types" invariant proves the two lists stayed
 * in step — the silent mismatch this header warns about.
 *
 * The freeze's own prescription — reuse an existing member with a reserved `method` — was rejected
 * for the third time, and here for a new reason: the natural candidate is `sync`, which is NOT a
 * marker, so every outcome row would count as outbound unless the counting predicate grew a
 * method-level special case. That would reintroduce by hand the miscount `MARKER_SOURCE_TYPES`
 * exists to make structural.
 */
export const EGRESS_SOURCE_TYPES = [
  "task", // gated connector action
  "prune", // retention tombstone
  "session", // gateway housekeeping egress (telemetry, updater, JWKS, …)
  "sync", // connector sync run
  "model", // inference + embeddings, local or remote
  "peer", // federated send
  "mcp", // agent brief served to an MCP-connected client
  "boot", // per-process marker carrying the coverage vector
  "degraded", // lost-append recovery marker
  "http", // agent brief served over the local HTTP API
  "outcome", // how a targeted fetch ended — a marker, never counted as egress
] as const;

export type EgressSourceType = (typeof EGRESS_SOURCE_TYPES)[number];

/**
 * Rows that record bookkeeping rather than egress. Never counted as outbound events.
 *
 * Exclusion is explicit rather than implied by `result_status`, because markers legitimately carry
 * `result_status='authorized'` — `pruneEgress` already does, which is why prune tombstones were
 * being miscounted before this landed (see Task 2).
 */
export const MARKER_SOURCE_TYPES: ReadonlySet<EgressSourceType> = new Set<EgressSourceType>([
  "prune",
  "boot",
  "degraded",
  "outcome",
]);

/** Marker test over a raw DB string. Unknown values are NOT markers — an unknown row counts. */
export function isMarkerSourceType(sourceType: string): boolean {
  return (MARKER_SOURCE_TYPES as ReadonlySet<string>).has(sourceType);
}
