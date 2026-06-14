// packages/gateway/src/connectors/warehouse-write-tools.ts

/** One warehouse/BI write action: its HITL action.type, its MCP tool id, and its service id.
 *  Single source of truth consumed by the HITL drift test, the dispatch decorator, and the I26
 *  confinement predicate (later tasks). */
export interface WarehouseWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

export const WAREHOUSE_BI_WRITES: readonly WarehouseWrite[] = [
  { actionType: "snowflake.tag.set", toolId: "snowflake_tag_set", service: "snowflake" },
  { actionType: "snowflake.comment.set", toolId: "snowflake_comment_set", service: "snowflake" },
  {
    actionType: "tableau.datasource.refresh",
    toolId: "tableau_datasource_refresh",
    service: "tableau",
  },
  {
    actionType: "tableau.workbook.refresh",
    toolId: "tableau_workbook_refresh",
    service: "tableau",
  },
  {
    actionType: "looker.datagroup.trigger",
    toolId: "looker_datagroup_trigger",
    service: "looker",
  },
  {
    actionType: "looker.schedule.run_once",
    toolId: "looker_schedule_run_once",
    service: "looker",
  },
  {
    actionType: "powerbi.dataset.refresh",
    toolId: "powerbi_dataset_refresh",
    service: "powerbi",
  },
  {
    actionType: "powerbi.dataflow.refresh",
    toolId: "powerbi_dataflow_refresh",
    service: "powerbi",
  },
  {
    actionType: "montecarlo.incident.acknowledge",
    toolId: "montecarlo_incident_acknowledge",
    service: "montecarlo",
  },
  {
    actionType: "montecarlo.incident.resolve",
    toolId: "montecarlo_incident_resolve",
    service: "montecarlo",
  },
  {
    actionType: "bigeye.issue.acknowledge",
    toolId: "bigeye_issue_acknowledge",
    service: "bigeye",
  },
  { actionType: "bigeye.issue.resolve", toolId: "bigeye_issue_resolve", service: "bigeye" },
] as const;

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
