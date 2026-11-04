// packages/gateway/src/connectors/connector-writes/tickets.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const TICKETS_ROWS: readonly ConnectorWriteRow[] = [
  row("jira_issue_create", "jira.issue.create", "mesh", 2),
  row("jira_issue_update", "jira.issue.update", "mesh", 2),
  row("jira_comment_add", "jira.comment.add", "mesh", 2),
  row("linear_issue_create", "linear.issue.create", "mesh", 2),
  row("linear_issue_update", "linear.issue.update", "mesh", 2),
  row("linear_comment_create", "linear.comment.create", "mesh", 2),
  row("github_issue_create", "github.issue.create", "mesh", 2),
];
