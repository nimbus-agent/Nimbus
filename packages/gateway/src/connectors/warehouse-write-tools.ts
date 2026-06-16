// packages/gateway/src/connectors/warehouse-write-tools.ts

/** One warehouse/BI write action: its HITL action.type, its MCP tool id, and its service id.
 *  Single source of truth consumed by the HITL drift test, the dispatch decorator, and the I26
 *  confinement predicate (later tasks). */
export interface WarehouseWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

/** Compact single-line builder so each entry below is one row, not a cloned multi-line literal. */
const w = (actionType: string, toolId: string, service: string): WarehouseWrite => ({
  actionType,
  toolId,
  service,
});

export const WAREHOUSE_BI_WRITES: readonly WarehouseWrite[] = [
  w("snowflake.tag.set", "snowflake_tag_set", "snowflake"),
  w("snowflake.comment.set", "snowflake_comment_set", "snowflake"),
  w("tableau.datasource.refresh", "tableau_datasource_refresh", "tableau"),
  w("tableau.workbook.refresh", "tableau_workbook_refresh", "tableau"),
  w("looker.datagroup.trigger", "looker_datagroup_trigger", "looker"),
  w("looker.schedule.run_once", "looker_schedule_run_once", "looker"),
  w("powerbi.dataset.refresh", "powerbi_dataset_refresh", "powerbi"),
  w("powerbi.dataflow.refresh", "powerbi_dataflow_refresh", "powerbi"),
  w("montecarlo.incident.acknowledge", "montecarlo_incident_acknowledge", "montecarlo"),
  w("montecarlo.incident.resolve", "montecarlo_incident_resolve", "montecarlo"),
  w("bigeye.issue.acknowledge", "bigeye_issue_acknowledge", "bigeye"),
  w("bigeye.issue.resolve", "bigeye_issue_resolve", "bigeye"),
];

export const WAREHOUSE_BI_WRITE_TOOL_IDS: ReadonlySet<string> = new Set(
  WAREHOUSE_BI_WRITES.map((w) => w.toolId),
);

const BY_ACTION_TYPE: ReadonlyMap<string, WarehouseWrite> = new Map(
  WAREHOUSE_BI_WRITES.map((w) => [w.actionType, w]),
);

export function isWarehouseWriteToolId(toolId: string): boolean {
  return WAREHOUSE_BI_WRITE_TOOL_IDS.has(toolId);
}

export function warehouseWriteByActionType(actionType: string): WarehouseWrite | undefined {
  return BY_ACTION_TYPE.get(actionType);
}
