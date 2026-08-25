import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * How a targeted fetch ended, for the three arms reachable AFTER the egress append.
 *
 * The other three `TargetedFetchOutcome` arms — `unsupported_url`, `no_targeted_fetch` and
 * `not_configured` — are refused BEFORE any row is written, so no outcome row can ever describe
 * them: there would be nothing for one to name, and nothing left the machine to report on.
 */
export type FetchOutcomeStatus = "indexed" | "not_found" | "rate_limited";

/**
 * Append ONE `outcome` marker describing a completed targeted fetch.
 *
 * A MARKER, never an egress class. This is bookkeeping about an outbound call the ledger has
 * ALREADY counted — the authorising row `targetedFetch` appends before calling the connector.
 * Counting it again would double every targeted fetch and inflate the exact number I29 exists to
 * state honestly; `MARKER_SOURCE_TYPES` makes that structural rather than a rule to remember.
 *
 * `authorizingRowHash` goes in `source_id` — the column prune tombstones already use to carry an
 * attested hash. It is the value the chain commits to, so a correlation key built on it cannot
 * drift from the row it points at, and every consumer of `GET /v1/egress` already receives it as
 * `rowHash`, so the join needs no new field on the wire.
 *
 * Throws on append failure rather than swallowing. The swallow belongs at the call site, which has
 * the context to say what was lost — see `appendBootMarkerOrWarn` for the shape.
 */
export function recordFetchOutcomeEgress(
  db: Database,
  args: {
    readonly destination: string;
    readonly authorizingRowHash: string;
    readonly status: FetchOutcomeStatus;
    readonly itemId?: string | undefined;
    readonly reason?: string | undefined;
    readonly now: number;
  },
): undefined {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "outcome",
    sourceId: args.authorizingRowHash,
    destination: args.destination,
    method: "items.fetch.outcome",
    payloadSummary: redactEgressSummary({
      status: args.status,
      ...(args.itemId === undefined ? {} : { itemId: args.itemId }),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    }),
    hitlStatus: "not_required",
    // "was this action allowed", not "did it succeed". Markers legitimately carry `authorized`, and
    // reusing this column to mean "the fetch worked" would give it two meanings across row classes.
    // The fetch's result lives in `payload_summary.status`, which has three values.
    resultStatus: "authorized",
  });
  return undefined;
}
