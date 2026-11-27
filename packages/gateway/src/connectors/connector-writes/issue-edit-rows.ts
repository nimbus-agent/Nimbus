// packages/gateway/src/connectors/connector-writes/issue-edit-rows.ts
// The nine Wave 2 issue writes of `@nimbus-dev/connectors` 0.19.0: the GitHub and GitLab label and
// assignee removes and issue edits, the Jira assign and the Linear label add and remove. B2
// siblings of the `tickets.ts` rows (the same readers), kept out of that file so it stays under
// the `audit:file-size` limit. Spread into the one row table by `index.ts`.
import { beforeReplyJson, presentFields, stringAt } from "./before-select.ts";
import {
  GITHUB_ISSUE_STATE_READER,
  GITLAB_ISSUE_STATE_READER,
  selectGithubIssueIdentity,
  selectGitlabIssueIdentity,
  selectJiraIssueIdentity,
  selectLinearIssueIdentity,
} from "./tickets.ts";
import {
  type BeforeStateField,
  type BeforeStateGuard,
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";
import { emptyUpdateGuard } from "./vcs-ci.ts";

/** The Jira assignee's display name, `(none)` for an own `null`; absent when the reply cannot say. */
function jiraAssigneeName(j: unknown): string | undefined {
  const fields =
    typeof j === "object" && j !== null && Object.hasOwn(j, "fields")
      ? (j as Record<string, unknown>)["fields"]
      : undefined;
  if (typeof fields !== "object" || fields === null || !Object.hasOwn(fields, "assignee")) {
    return undefined;
  }
  if ((fields as Record<string, unknown>)["assignee"] === null) return "(none)";
  return (
    stringAt(fields, ["assignee", "displayName"]) ?? stringAt(fields, ["assignee", "accountId"])
  );
}

/** Jira `jira_issue_get`, for an assignment: identity, status, type and the current assignee. */
export function selectJiraIssueAssignee(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [...selectJiraIssueIdentity(j), ...presentFields([["Assignee", jiraAssigneeName(j)]])];
}

/**
 * `jira_issue_assign` takes `accountId` as REQUIRED and nullable: an id assigns, `null` unassigns.
 * The preview shows an absent key and a `null` one alike (the unassign line), so an absent key is
 * refused before the prompt; the connector would refuse it after approval.
 */
export const JIRA_ASSIGN_ACCOUNT_GUARD: BeforeStateGuard = {
  reason: "jira_issue_assign needs accountId: a Jira account id, or null to unassign",
  appliesTo: (picked) => picked["accountId"] === undefined,
  allows: () => false,
};

/**
 * `gitlab_issue_assignees_remove` sends `projectPath` to GraphQL, which takes a full path only; the
 * connector refuses a numeric id. Refused here before the prompt, where the read would succeed.
 */
export const GITLAB_GRAPHQL_PATH_GUARD: BeforeStateGuard = {
  reason:
    "projectPath must be the project's full path (group/project); this write takes no numeric id",
  appliesTo: (picked) =>
    typeof picked["projectPath"] === "string" && /^\d+$/.test(picked["projectPath"]),
  allows: () => false,
};

/** One read of `linear_issue_get` for a label change: the issue's identity and state. */
const LINEAR_ISSUE_IDENTITY_READER: BeforeStateReader = {
  tool: "linear_issue_get",
  argKeys: ["issueId"],
  args: (input) => ({ issueId: input["issueId"] }),
  select: selectLinearIssueIdentity,
};

// The removes take away only what they name (pinned by `issue-edit-rows.test.ts` against the
// installed connector); the edits change title and text only, never state, labels or assignees.
// The before reads show identity and state, never a body or description (the tickets.ts rule).
export const ISSUE_EDIT_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("github_issue_labels_remove", "github.issue.labels.remove", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary:
        "Remove labels from GitHub issue or pull request {owner}/{repo}#{issueNumber} (removes only; adds none)",
      fields: [
        textField(
          "labels",
          "Labels to remove (one request each, in order; it stops at the first one GitHub refuses, such as a label not on the issue)",
        ),
      ],
    }),
    GITHUB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("github_issue_assignees_remove", "github.issue.assignees.remove", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary:
        "Remove assignees from GitHub issue or pull request {owner}/{repo}#{issueNumber} (removes only; adds none)",
      fields: [
        textField(
          "assignees",
          "Assignees to remove (GitHub usernames; one not assigned is ignored)",
        ),
      ],
    }),
    GITHUB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("github_issue_update", "github.issue.update", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary:
        "Edit GitHub issue or pull request {owner}/{repo}#{issueNumber} (title and body only)",
      fields: [
        textField("title", "New title", "(not set: unchanged)"),
        textField(
          "body",
          "New body (replaces the whole body, which is not shown)",
          "(not set: unchanged)",
        ),
      ],
    }),
    {
      ...GITHUB_ISSUE_STATE_READER,
      // `title` and `body` are declared for the guard, never sent to the read.
      argKeys: ["owner", "repo", "issueNumber", "title", "body"],
      select: selectGithubIssueIdentity,
      guard: emptyUpdateGuard(["title", "body"], "set at least one of title, body"),
    },
  ),
  withBefore(
    withPreview(row("gitlab_issue_labels_remove", "gitlab.issue.labels.remove", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Remove labels from GitLab issue {projectPath}#{issueIid} (removes only; adds none)",
      fields: [textField("labels", "Labels to remove (one not on the issue is ignored)")],
    }),
    GITLAB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("gitlab_issue_assignees_remove", "gitlab.issue.assignees.remove", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary:
        "Remove assignees from GitLab issue {projectPath}#{issueIid} (removes only; adds none)",
      fields: [textField("assigneeUsernames", "Assignees to remove (GitLab usernames)")],
    }),
    { ...GITLAB_ISSUE_STATE_READER, guard: GITLAB_GRAPHQL_PATH_GUARD },
  ),
  withBefore(
    withPreview(row("gitlab_issue_update", "gitlab.issue.update", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Edit GitLab issue {projectPath}#{issueIid} (title and description only)",
      fields: [
        textField("title", "New title", "(not set: unchanged)"),
        textField(
          "description",
          "New description (replaces the whole description, which is not shown)",
          "(not set: unchanged)",
        ),
      ],
    }),
    {
      ...GITLAB_ISSUE_STATE_READER,
      // `title` and `description` are declared for the guard, never sent to the read.
      argKeys: ["projectPath", "issueIid", "title", "description"],
      select: selectGitlabIssueIdentity,
      guard: emptyUpdateGuard(["title", "description"], "set at least one of title, description"),
    },
  ),
  // `accountId` is required and nullable: an account id assigns, `null` unassigns (so it is not in
  // NULL_REFUSED_OPTIONAL_KEYS); the unset line is the unassign line, and an absent key is refused.
  withBefore(
    withPreview(row("jira_issue_assign", "jira.issue.assign", "mesh", 2), {
      target: "{issueKey}",
      summary: "Set the assignee of Jira issue {issueKey} (replaces the current assignee)",
      fields: [
        textField(
          "accountId",
          "New assignee (Jira account id; notifies that account)",
          "(null: UNASSIGN the issue, nobody is assigned)",
        ),
      ],
    }),
    {
      tool: "jira_issue_get",
      // `accountId` is declared for the guard, never sent to the read.
      argKeys: ["issueKey", "accountId"],
      args: (input) => ({ issueKey: input["issueKey"] }),
      select: selectJiraIssueAssignee,
      guard: JIRA_ASSIGN_ACCOUNT_GUARD,
    },
  ),
  // One `issueUpdate` with `addedLabelIds` or `removedLabelIds` only, never `labelIds` (which
  // would replace the whole set).
  withBefore(
    withPreview(row("linear_issue_labels_add", "linear.issue.labels.add", "mesh", 2), {
      target: "{issueId}",
      summary: "Add labels to Linear issue {issueId} (adds only; removes none)",
      fields: [textField("labelIds", "Label ids to add")],
    }),
    LINEAR_ISSUE_IDENTITY_READER,
  ),
  withBefore(
    withPreview(row("linear_issue_labels_remove", "linear.issue.labels.remove", "mesh", 2), {
      target: "{issueId}",
      summary: "Remove labels from Linear issue {issueId} (removes only; adds none)",
      fields: [textField("labelIds", "Label ids to remove")],
    }),
    LINEAR_ISSUE_IDENTITY_READER,
  ),
];
