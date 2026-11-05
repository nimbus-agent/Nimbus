// packages/gateway/src/connectors/connector-writes/tickets.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const TICKETS_ROWS: readonly ConnectorWriteRow[] = [
  row("jira_issue_create", "jira.issue.create", "mesh", 2),
  row("jira_issue_update", "jira.issue.update", "mesh", 2),
  row("jira_comment_add", "jira.comment.add", "mesh", 2),
  row("jira_issue_transition", "jira.issue.transition", "mesh", 2),
  row("linear_issue_create", "linear.issue.create", "mesh", 2),
  row("linear_issue_update", "linear.issue.update", "mesh", 2),
  row("linear_comment_create", "linear.comment.create", "mesh", 2),
  row("github_issue_create", "github.issue.create", "mesh", 2),
  row("github_issue_comment_create", "github.issue.comment.create", "mesh", 2),
  row("github_issue_labels_add", "github.issue.labels.add", "mesh", 2),
  row("github_issue_assignees_add", "github.issue.assignees.add", "mesh", 2),
  row("github_issue_state_set", "github.issue.state.set", "mesh", 2),
  row("gitlab_issue_create", "gitlab.issue.create", "mesh", 2),
  row("gitlab_issue_note_create", "gitlab.issue.note.create", "mesh", 2),
  row("gitlab_issue_labels_add", "gitlab.issue.labels.add", "mesh", 2),
  row("gitlab_issue_assignees_add", "gitlab.issue.assignees.add", "mesh", 2),
  row("gitlab_issue_state_set", "gitlab.issue.state.set", "mesh", 2),
];
