// packages/gateway/src/connectors/connector-writes/warehouse-bi.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const WAREHOUSE_BI_ROWS: readonly ConnectorWriteRow[] = [
  row("snowflake_tag_set", "snowflake.tag.set", "write", 4),
  row("snowflake_comment_set", "snowflake.comment.set", "write", 4),
  row("tableau_datasource_refresh", "tableau.datasource.refresh", "write", 4),
  row("tableau_workbook_refresh", "tableau.workbook.refresh", "write", 4),
  row("looker_datagroup_trigger", "looker.datagroup.trigger", "write", 4),
  row("looker_schedule_run_once", "looker.schedule.run_once", "write", 4),
  row("powerbi_dataset_refresh", "powerbi.dataset.refresh", "write", 4),
  row("powerbi_dataflow_refresh", "powerbi.dataflow.refresh", "write", 4),
  row("montecarlo_incident_acknowledge", "montecarlo.incident.acknowledge", "write", 4),
  row("montecarlo_incident_resolve", "montecarlo.incident.resolve", "write", 4),
  row("bigeye_issue_acknowledge", "bigeye.issue.acknowledge", "write", 4),
  row("bigeye_issue_resolve", "bigeye.issue.resolve", "write", 4),
];
