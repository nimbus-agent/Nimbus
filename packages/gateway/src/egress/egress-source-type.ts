// packages/gateway/src/egress/egress-source-type.ts

/**
 * The FROZEN `egress_ledger.source_type` union.
 *
 * `source_type` is an input to `computeEgressRowHash`, so every value here is permanent: adding a
 * member later cannot be a refactor, it is a chain break. The union therefore lands COMPLETE,
 * including members whose appenders do not exist yet (`boot`, `degraded` arrive with the boot
 * marker; `sync`, `model`, `peer` arrive in later phases).
 *
 * If a ninth class is ever wanted, the answer is NOT to extend this union — it is to reuse
 * `session` with a reserved `method` value, accepting the weaker string-match exclusion.
 */
export const EGRESS_SOURCE_TYPES = [
  "task", // gated connector action (the only appender today)
  "prune", // retention tombstone
  "session", // gateway housekeeping egress (telemetry, updater, JWKS, …)
  "sync", // connector sync run
  "model", // inference + embeddings, local or remote
  "peer", // federated send
  "boot", // per-process marker carrying the coverage vector
  "degraded", // lost-append recovery marker
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
]);

/** Marker test over a raw DB string. Unknown values are NOT markers — an unknown row counts. */
export function isMarkerSourceType(sourceType: string): boolean {
  return (MARKER_SOURCE_TYPES as ReadonlySet<string>).has(sourceType);
}
