// packages/gateway/src/connectors/connector-write.ts

/** One dispatchable connector write: its HITL action.type, its MCP tool id, and its service id.
 *  Derived from the `write`-transport rows of `connector-writes/`. */
export interface ConnectorWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}
