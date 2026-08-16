// packages/gateway/src/egress/synthesis-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * The `model` class appender. `"model"` was already a FROZEN `EGRESS_SOURCE_TYPES`
 * member reserved for exactly this ("inference + embeddings, local or remote");
 * W6-A0 is the "later phase" its docstring anticipated. Do not add a source type.
 *
 * Called ONLY for a non-local provider. A local generate makes no outbound
 * request, so ledgering it would over-claim egress the same way an unfiltered
 * `LOCAL_ONLY_SYNC_SERVICES` did before it was excluded.
 */
export function recordSynthesisEgress(
  db: Database,
  args: { readonly briefKind: string; readonly model: string; readonly now: number },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "model",
    sourceId: args.model,
    destination: "model",
    method: `agents.${args.briefKind}.synthesis`,
    payloadSummary: redactEgressSummary({ briefKind: args.briefKind, model: args.model }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
