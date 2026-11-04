// packages/gateway/src/connectors/connector-writes/warehouse-bi.ts
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

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
  withPreview(row("tableau_datasource_refresh", "tableau.datasource.refresh", "write", 4), {
    target: "{id}",
    summary: "Refresh Tableau data source {id}",
    fields: [],
  }),
  withPreview(row("tableau_workbook_refresh", "tableau.workbook.refresh", "write", 4), {
    target: "{id}",
    summary: "Refresh Tableau workbook {id}",
    fields: [],
  }),
  withPreview(row("looker_datagroup_trigger", "looker.datagroup.trigger", "write", 4), {
    target: "{datagroupId}",
    summary: "Trigger Looker datagroup {datagroupId}",
    fields: [],
  }),
  withPreview(row("looker_schedule_run_once", "looker.schedule.run_once", "write", 4), {
    target: "{scheduledPlanId}",
    summary: "Run Looker scheduled plan {scheduledPlanId} once",
    fields: [],
  }),
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
  withPreview(
    row("montecarlo_incident_acknowledge", "montecarlo.incident.acknowledge", "write", 4),
    {
      target: "{incidentId}",
      summary: "Acknowledge Monte Carlo incident {incidentId}",
      fields: [],
    },
  ),
  withPreview(row("montecarlo_incident_resolve", "montecarlo.incident.resolve", "write", 4), {
    target: "{incidentId}",
    summary: "Resolve Monte Carlo incident {incidentId}",
    fields: [],
  }),
  withPreview(row("bigeye_issue_acknowledge", "bigeye.issue.acknowledge", "write", 4), {
    target: "{issueId}",
    summary: "Acknowledge Bigeye issue {issueId}",
    fields: [],
  }),
  withPreview(row("bigeye_issue_resolve", "bigeye.issue.resolve", "write", 4), {
    target: "{issueId}",
    summary: "Resolve Bigeye issue {issueId}",
    fields: [],
  }),
];
