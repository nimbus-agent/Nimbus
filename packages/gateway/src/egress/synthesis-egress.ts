// packages/gateway/src/egress/synthesis-egress.ts

import type { Database } from "bun:sqlite";
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
 * `remote` is a REQUIRED argument, and a `false` call appends nothing. A local
 * generate makes no outbound request, so ledgering it would over-claim egress the
 * same way an unfiltered `LOCAL_ONLY_SYNC_SERVICES` did before it was excluded.
 * The check is enforced HERE, inside the appender, rather than left to the caller
 * — `sync-egress.ts`'s `recordSyncEgress` makes the same choice for the same
 * reason (its doc comment: "checked HERE rather than at either call site, so BOTH
 * appenders ... enforce the rule identically instead of each needing its own copy
 * of the exclusion list"). A caller-enforced rule is one wiring mistake away from
 * fabricating `model` rows for local synthesis; an appender-enforced one cannot be
 * bypassed by a future second caller forgetting the guard.
 */
export function recordSynthesisEgress(
  db: Database,
  args: {
    readonly briefKind: string;
    readonly model: string;
    readonly now: number;
    readonly remote: boolean;
  },
): void {
  if (!args.remote) {
    return;
  }
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
