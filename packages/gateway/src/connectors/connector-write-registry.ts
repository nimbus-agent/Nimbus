// packages/gateway/src/connectors/connector-write-registry.ts
import { CHATOPS_POST_TOOL_IDS } from "../chatops/transport/connector-post.ts";
import { TRIBAL_KB_WRITE_TOOL_IDS } from "../tribal/tribal-write-gate.ts";
import type { ConnectorWrite } from "./connector-write.ts";
import { MIGRATED_WRITE_TOOL_IDS } from "./connector-write-tool-ids.ts";
import {
  GITOPS_ML_WRITES,
  gitopsMlWriteByActionType,
  isGitopsMlWriteToolId,
} from "./gitops-ml-write-tools.ts";
import { matchesBareOrNamespacedToolId } from "./namespaced-tool-id.ts";
import {
  isWarehouseWriteToolId,
  WAREHOUSE_BI_WRITES,
  warehouseWriteByActionType,
} from "./warehouse-write-tools.ts";

/** The union of every connector write action across all groups. Drives the generalized I26 predicate
 *  (federated peer fail-closed rejection) and the credential-aware dispatch routing. */
export { MIGRATED_WRITE_TOOL_IDS };

export const CONNECTOR_WRITES: readonly ConnectorWrite[] = [
  ...WAREHOUSE_BI_WRITES,
  ...GITOPS_ML_WRITES,
];

/**
 * The writes whose literals static rules confine to their own gates, so no set here may name them:
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
  return (
    isWarehouseWriteToolId(toolId) ||
    isGitopsMlWriteToolId(toolId) ||
    // Migrated connector write tools. They have no dispatch row, but a federated peer must be
    // rejected for naming one just the same — the predicate is about write-ness, not routability.
    MIGRATED_WRITE_TOOL_IDS.has(toolId) ||
    GATE_CONFINED_WRITE_TOOL_IDS.some((ids) => ids.has(toolId))
  );
}

/** The longest write tool id: no suffix longer than this can name a write. */
const LONGEST_WRITE_TOOL_ID = Math.max(
  ...CONNECTOR_WRITES.map((w) => w.toolId.length),
  ...[MIGRATED_WRITE_TOOL_IDS, ...GATE_CONFINED_WRITE_TOOL_IDS].flatMap((ids) =>
    [...ids].map((id) => id.length),
  ),
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

export function connectorWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return warehouseWriteByActionType(actionType) ?? gitopsMlWriteByActionType(actionType);
}
