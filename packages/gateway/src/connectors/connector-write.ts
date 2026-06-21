// packages/gateway/src/connectors/connector-write.ts

/** One connector write action: its HITL action.type, its MCP tool id, and its service id.
 *  Shared single-row descriptor consumed by every connector-write SSoT module (warehouse, gitops-ml). */
export interface ConnectorWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

/** Compact single-line builder so each SSoT entry is one row, not a cloned multi-line literal. */
export const w = (actionType: string, toolId: string, service: string): ConnectorWrite => ({
  actionType,
  toolId,
  service,
});
