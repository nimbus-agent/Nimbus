import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * Agents that answer by querying paired peers rather than purely from the local index. Their rows
 * must stay distinguishable from purely local briefs — collapsing them into one undifferentiated
 * "mcp" destination would hide outbound peer traffic inside a local-looking record.
 */
const FEDERATION_TOUCHING: ReadonlySet<string> = new Set(["agents.ghost", "agents.huddle"]);

/**
 * The sole append site for MCP-originated agent briefs (I29, D22(c)).
 *
 * Called BEFORE the brief is returned to the caller. It throws on failure by design: the caller
 * must fail closed and emit no brief, mirroring the executor's append-before-dispatch discipline.
 * A ledger that can be outrun by the thing it records is decorative.
 */
export function recordMcpBriefEgress(
  db: Database,
  args: {
    readonly method: string;
    readonly params: unknown;
    readonly clientId: string;
    readonly now: number;
  },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "mcp",
    sourceId: args.clientId,
    destination: FEDERATION_TOUCHING.has(args.method) ? "mcp+federation" : "mcp",
    method: args.method,
    payloadSummary: redactEgressSummary(args.params),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
