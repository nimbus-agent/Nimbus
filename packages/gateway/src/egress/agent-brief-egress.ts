// packages/gateway/src/egress/agent-brief-egress.ts

import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import type { EgressSourceType } from "./egress-source-type.ts";

/**
 * Agents that answer by querying paired peers rather than purely from the local index. Their rows
 * must stay distinguishable from purely local briefs — collapsing them into one undifferentiated
 * destination would hide outbound peer traffic inside a local-looking record.
 */
const FEDERATION_TOUCHING: ReadonlySet<string> = new Set(["agents.ghost", "agents.huddle"]);

/**
 * The transports whose agent briefs are ledgered.
 *
 * Narrowed from `EgressSourceType` rather than accepting the whole union: a brief filed as `task`
 * or `sync` would inflate a coverage claim a different appender is responsible for, and the
 * `source_type` written today is permanent in the data.
 */
export type AgentBriefSourceType = Extract<EgressSourceType, "mcp" | "http">;

/**
 * The sole append site for agent briefs served to an external client (I29, D22(c)).
 *
 * Called BEFORE the brief is returned to the caller. It throws on failure by design: the caller
 * must fail closed and emit no brief, mirroring the executor's append-before-dispatch discipline.
 * A ledger that can be outrun by the thing it records is decorative.
 *
 * `sourceType` is the TRANSPORT, supplied by the dispatcher from a server-derived caller kind —
 * never from RPC params or a request body. `destination` derives from it, so the
 * federation-touching distinction survives on every transport rather than only on the first one
 * this function was written for.
 */
export function recordAgentBriefEgress(
  db: Database,
  args: {
    readonly sourceType: AgentBriefSourceType;
    readonly method: string;
    readonly params: unknown;
    readonly clientId: string;
    readonly now: number;
  },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: args.sourceType,
    sourceId: args.clientId,
    destination: FEDERATION_TOUCHING.has(args.method)
      ? `${args.sourceType}+federation`
      : args.sourceType,
    method: args.method,
    payloadSummary: redactEgressSummary(args.params),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
