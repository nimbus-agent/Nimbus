// packages/gateway/src/egress/synthesis-egress.ts

import type { Database } from "bun:sqlite";
import type { ProviderId } from "../llm/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * The `model` class appender. `"model"` was already a FROZEN `EGRESS_SOURCE_TYPES`
 * member reserved for exactly this ("inference + embeddings, local or remote");
 * W6-A0 is the "later phase" its docstring anticipated. Do not add a source type.
 *
 * The appender's only caller is the synthesis wiring (`agents/_lib/synthesis-llm.ts`,
 * `[agents] synthesis = "local"` or `"allow-remote"`), reached in production from
 * `ipc/server/dispatchers.ts` and `agent-runs/agent-http-invoke.ts` (Task 6's
 * `buildAgentSynthesisRunner`).
 *
 * The caller passes the RESOLVED PROVIDER, not a pre-computed `remote` boolean, and
 * the local-vs-remote decision is derived HERE from `provider.isLocal`. A local
 * generate makes no outbound request, so ledgering it would over-claim egress the
 * same way an unfiltered `LOCAL_ONLY_SYNC_SERVICES` did before it was excluded.
 * `sync-egress.ts`'s `recordSyncEgress` makes the same choice for the same reason
 * (its doc comment: "checked HERE rather than at either call site, so BOTH
 * appenders ... enforce the rule identically instead of each needing its own copy
 * of the exclusion list") — and, like that one, it decides from data it can check
 * itself rather than from a verdict handed in by the caller.
 *
 * That distinction is the whole point, and it is why this signature does NOT take a
 * boolean. A caller-supplied `remote` is unverifiable here: passing `false` for a
 * remote provider suppresses the row and puts a FALSE ZERO in the ledger `nimbus
 * prove` reports on, and passing `true` for a local one fabricates `model` rows.
 * Deriving from `isLocal` makes both unrepresentable, so the guarantee holds for a
 * future second caller that never read this comment.
 */
export function recordSynthesisEgress(
  db: Database,
  args: {
    readonly briefKind: string;
    readonly provider: {
      readonly providerId: ProviderId;
      readonly modelName: string;
      readonly isLocal: boolean;
    };
    readonly now: number;
  },
): void {
  if (args.provider.isLocal) {
    return;
  }
  const model = args.provider.modelName;
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "model",
    sourceId: model,
    destination: args.provider.providerId,
    method: `agents.${args.briefKind}.synthesis`,
    payloadSummary: redactEgressSummary({ briefKind: args.briefKind, model }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
