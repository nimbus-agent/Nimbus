// packages/gateway/src/connectors/connector-writes/warehouse-bi.ts
import { type ConnectorWriteRow, fieldlessWrite, row, textField, withPreview } from "./types.ts";

export const WAREHOUSE_BI_ROWS: readonly ConnectorWriteRow[] = [
  withPreview(row("snowflake_tag_set", "snowflake.tag.set", "write", 4), {
    target: "{object}",
    summary: "Set or remove tag {tag} on {object}",
    // The upstream handler runs UNSET TAG when `value` is omitted.
    fields: [textField("tag"), textField("value", undefined, "(not set: the tag is REMOVED)")],
  }),
  withPreview(row("snowflake_comment_set", "snowflake.comment.set", "write", 4), {
    target: "{object}",
    summary: "Set the comment on {object}",
    fields: [textField("comment", "Comment")],
  }),
  fieldlessWrite(
    "tableau_datasource_refresh",
    "tableau.datasource.refresh",
    "{id}",
    "Refresh Tableau data source {id}",
  ),
  fieldlessWrite(
    "tableau_workbook_refresh",
    "tableau.workbook.refresh",
    "{id}",
    "Refresh Tableau workbook {id}",
  ),
  fieldlessWrite(
    "looker_datagroup_trigger",
    "looker.datagroup.trigger",
    "{datagroupId}",
    "Trigger Looker datagroup {datagroupId}",
  ),
  fieldlessWrite(
    "looker_schedule_run_once",
    "looker.schedule.run_once",
    "{scheduledPlanId}",
    "Run Looker scheduled plan {scheduledPlanId} once",
  ),
  withPreview(row("powerbi_dataset_refresh", "powerbi.dataset.refresh", "write", 4), {
    target: "{datasetId}",
    summary: "Refresh Power BI dataset {datasetId}",
    // The upstream handler refreshes the caller's My Workspace when `groupId` is omitted.
    fields: [textField("groupId", "Workspace", "(not set: My Workspace)")],
  }),
  withPreview(row("powerbi_dataflow_refresh", "powerbi.dataflow.refresh", "write", 4), {
    target: "{dataflowId}",
    summary: "Refresh Power BI dataflow {dataflowId}",
    fields: [textField("groupId", "Workspace")],
  }),
  fieldlessWrite(
    "montecarlo_incident_acknowledge",
    "montecarlo.incident.acknowledge",
    "{incidentId}",
    "Acknowledge Monte Carlo incident {incidentId}",
  ),
  fieldlessWrite(
    "montecarlo_incident_resolve",
    "montecarlo.incident.resolve",
    "{incidentId}",
    "Resolve Monte Carlo incident {incidentId}",
  ),
  fieldlessWrite(
    "bigeye_issue_acknowledge",
    "bigeye.issue.acknowledge",
    "{issueId}",
    "Acknowledge Bigeye issue {issueId}",
  ),
  fieldlessWrite(
    "bigeye_issue_resolve",
    "bigeye.issue.resolve",
    "{issueId}",
    "Resolve Bigeye issue {issueId}",
  ),
];
