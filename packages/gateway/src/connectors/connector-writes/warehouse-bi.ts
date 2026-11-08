// packages/gateway/src/connectors/connector-writes/warehouse-bi.ts
import {
  selectSnowflakeComment,
  selectSnowflakeTag,
  snowflakeMetadataReadArgs,
} from "./gitops-readers.ts";
import {
  type ConnectorWriteRow,
  fieldlessWrite,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

export const WAREHOUSE_BI_ROWS: readonly ConnectorWriteRow[] = [
  // Spec § 15, owner ruling OR-W34-3 (2026-11-06): the refreshes and the data-quality
  // acknowledge/resolve rows are wave 3 (low blast radius); the two Snowflake writes stay wave 4.
  // D1: both read the table's metadata first (the read returns direct AND inherited tags). `value`
  // and `comment` are shown in full and not scanned (see the free-text table in d1-templates.test.ts).
  withConfirm(
    withBefore(
      withPreview(row("snowflake_tag_set", "snowflake.tag.set", "write", 4), {
        target: "{object}",
        summary: "Set or remove tag {tag} on {object}",
        // The upstream handler runs UNSET TAG when `value` is omitted.
        fields: [textField("tag"), textField("value", undefined, "(not set: the tag is REMOVED)")],
      }),
      {
        tool: "snowflake_object_metadata_get",
        argKeys: ["object", "tag"],
        args: snowflakeMetadataReadArgs,
        select: selectSnowflakeTag,
      },
    ),
    {
      template: "set tag {object}/{tag}",
      // No `value`: the connector runs UNSET TAG, so the owner types a removal, not a "set".
      whenUnset: { field: "value", template: "remove tag {object}/{tag}" },
    },
  ),
  withConfirm(
    withBefore(
      withPreview(row("snowflake_comment_set", "snowflake.comment.set", "write", 4), {
        target: "{object}",
        summary: "Set the comment on {object}",
        fields: [textField("comment", "Comment")],
      }),
      {
        tool: "snowflake_object_metadata_get",
        argKeys: ["object"],
        args: snowflakeMetadataReadArgs,
        select: selectSnowflakeComment,
      },
    ),
    { template: "set comment {object}" },
  ),
  fieldlessWrite(
    "tableau_datasource_refresh",
    "tableau.datasource.refresh",
    3,
    "{id}",
    "Refresh Tableau data source {id}",
  ),
  fieldlessWrite(
    "tableau_workbook_refresh",
    "tableau.workbook.refresh",
    3,
    "{id}",
    "Refresh Tableau workbook {id}",
  ),
  fieldlessWrite(
    "looker_datagroup_trigger",
    "looker.datagroup.trigger",
    3,
    "{datagroupId}",
    "Trigger Looker datagroup {datagroupId}",
  ),
  fieldlessWrite(
    "looker_schedule_run_once",
    "looker.schedule.run_once",
    3,
    "{scheduledPlanId}",
    "Run Looker scheduled plan {scheduledPlanId} once",
  ),
  withPreview(row("powerbi_dataset_refresh", "powerbi.dataset.refresh", "write", 3), {
    target: "{datasetId}",
    summary: "Refresh Power BI dataset {datasetId}",
    // The upstream handler refreshes the caller's My Workspace when `groupId` is omitted.
    fields: [textField("groupId", "Workspace", "(not set: My Workspace)")],
  }),
  withPreview(row("powerbi_dataflow_refresh", "powerbi.dataflow.refresh", "write", 3), {
    target: "{dataflowId}",
    summary: "Refresh Power BI dataflow {dataflowId}",
    fields: [textField("groupId", "Workspace")],
  }),
  fieldlessWrite(
    "montecarlo_incident_acknowledge",
    "montecarlo.incident.acknowledge",
    3,
    "{incidentId}",
    "Acknowledge Monte Carlo incident {incidentId}",
  ),
  fieldlessWrite(
    "montecarlo_incident_resolve",
    "montecarlo.incident.resolve",
    3,
    "{incidentId}",
    "Resolve Monte Carlo incident {incidentId}",
  ),
  fieldlessWrite(
    "bigeye_issue_acknowledge",
    "bigeye.issue.acknowledge",
    3,
    "{issueId}",
    "Acknowledge Bigeye issue {issueId}",
  ),
  fieldlessWrite(
    "bigeye_issue_resolve",
    "bigeye.issue.resolve",
    3,
    "{issueId}",
    "Resolve Bigeye issue {issueId}",
  ),
];
