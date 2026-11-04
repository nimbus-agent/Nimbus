// packages/gateway/src/connectors/connector-write-registry.ts
import { CHATOPS_POST_TOOL_IDS } from "../chatops/transport/connector-post.ts";
import { serviceOf } from "../engine/service-of.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../tribal/tribal-write-gate.ts";
import type { ConnectorWrite } from "./connector-write.ts";
import { CONNECTOR_WRITE_ROWS } from "./connector-writes/index.ts";
import type { ConnectorWriteRow } from "./connector-writes/types.ts";
import { matchesBareOrNamespacedToolId } from "./namespaced-tool-id.ts";

/** The rows with a dispatch path (`transport === "write"`). Drives the credential-aware dispatch
 *  routing; the I26 predicate below spans every row, dispatchable or not. */
export const CONNECTOR_WRITES: readonly ConnectorWrite[] = CONNECTOR_WRITE_ROWS.filter(
  (r) => r.transport === "write",
).map((r) => ({ actionType: r.actionType, toolId: r.toolId, service: serviceOf(r.actionType) }));

const ROW_BY_TOOL_ID: ReadonlyMap<string, ConnectorWriteRow> = new Map(
  CONNECTOR_WRITE_ROWS.map((r) => [r.toolId, r]),
);

const WRITE_BY_ACTION_TYPE: ReadonlyMap<string, ConnectorWrite> = new Map(
  CONNECTOR_WRITES.map((w) => [w.actionType, w]),
);

/**
 * The writes whose literals static rules confine to their own gates, so no row may name them:
 * the KB appends (D19, `tribal/tribal-write-gate.ts`) and the ChatOps operational posts (D17,
 * `chatops/transport/connector-post.ts`). Those gates pin the DESTINATION when the gateway itself
 * calls the tool (I25 / I23); a federated invoke carries the peer's own arguments, destination
 * included, so it must be refused like any other write.
 */
const GATE_CONFINED_WRITE_TOOL_IDS: readonly ReadonlySet<string>[] = [
  TRIBAL_KB_WRITE_TOOL_IDS,
  CHATOPS_POST_TOOL_IDS,
];

function isWriteToolIdExactly(toolId: string): boolean {
  // Every row, dispatchable or not: a federated peer must be rejected for naming a write just the
  // same — the predicate is about write-ness, not routability.
  return ROW_BY_TOOL_ID.has(toolId) || GATE_CONFINED_WRITE_TOOL_IDS.some((ids) => ids.has(toolId));
}

/** The longest write tool id: no suffix longer than this can name a write. */
const LONGEST_WRITE_TOOL_ID = Math.max(
  ...CONNECTOR_WRITE_ROWS.map((r) => r.toolId.length),
  ...GATE_CONFINED_WRITE_TOOL_IDS.flatMap((ids) => [...ids].map((id) => id.length)),
);

/**
 * I26: true for any connector write tool id — the federated peer invoke gate rejects these
 * fail-closed; they execute only behind the local owner's executor I2 HITL gate.
 *
 * Matches a write however the federated runner ADDRESSES it, not only by its bare id. A
 * team-credentialed session lists its tools through `@mastra/mcp`'s `MCPClient.listTools()`, which
 * keys every tool `<server>_<tool>` (`aws_aws_ec2_instance_stop`), and `withConnectorSession` looks
 * the requested id up in that map verbatim — so the namespaced key is the form that EXECUTES there,
 * and the bare id is not found. Matching bare ids alone refused exactly the ids that cannot run and
 * passed the ones that can. Any `_`-delimited suffix that is a write id therefore names that write,
 * whatever server key precedes it (`github_actions_gha_run_trigger` included).
 *
 * Only a suffix no longer than the longest write id can match, so the scan starts there: its cost
 * is bounded by that length, never by the caller-supplied id's. The scan is
 * `matchesBareOrNamespacedToolId`, shared with the code-execution refusal
 * (`connector-code-execution-tool-ids.ts`) so the two cannot match by different rules.
 */
export function isConnectorWriteToolId(toolId: string): boolean {
  return matchesBareOrNamespacedToolId(toolId, isWriteToolIdExactly, LONGEST_WRITE_TOOL_ID);
}

/** The dispatchable (`write`-transport) write for an action type. */
export function connectorWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return WRITE_BY_ACTION_TYPE.get(actionType);
}

/** The row for a BARE tool id, whatever its transport. */
export function connectorWriteRowByToolId(toolId: string): ConnectorWriteRow | undefined {
  return ROW_BY_TOOL_ID.get(toolId);
}
