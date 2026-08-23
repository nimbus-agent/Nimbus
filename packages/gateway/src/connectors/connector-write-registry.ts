// packages/gateway/src/connectors/connector-write-registry.ts
import type { ConnectorWrite } from "./connector-write.ts";
import { MIGRATED_WRITE_TOOL_IDS } from "./connector-write-tool-ids.ts";
import {
  GITOPS_ML_WRITES,
  gitopsMlWriteByActionType,
  isGitopsMlWriteToolId,
} from "./gitops-ml-write-tools.ts";
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

/** I26: true for any connector write tool id — the federated peer invoke gate rejects these
 *  fail-closed; they execute only behind the local owner's executor I2 HITL gate. */
export function isConnectorWriteToolId(toolId: string): boolean {
  return (
    isWarehouseWriteToolId(toolId) ||
    isGitopsMlWriteToolId(toolId) ||
    // Migrated connector write tools. They have no dispatch row, but a federated peer must be
    // rejected for naming one just the same — the predicate is about write-ness, not routability.
    MIGRATED_WRITE_TOOL_IDS.has(toolId)
  );
}

export function connectorWriteByActionType(actionType: string): ConnectorWrite | undefined {
  return warehouseWriteByActionType(actionType) ?? gitopsMlWriteByActionType(actionType);
}
