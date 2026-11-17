// packages/gateway/src/automation/workflow-write-info.ts
// What the signed-workflow import prompt says about a write step's tool: its migration wave and the
// action type the executor will gate it under. Read from the connector write table by TOOL ID, in this
// one small module so the import modules themselves import nothing from `connectors/` (static D50(e)).
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";

export type WriteToolInfo = { readonly wave: number; readonly actionType: string };

/** The wave and action type of a connector write tool, or `undefined` for an unknown id. */
export function writeToolInfo(toolId: string): WriteToolInfo | undefined {
  const row = connectorWriteRowByToolId(toolId);
  return row === undefined ? undefined : { wave: row.wave, actionType: row.actionType };
}
