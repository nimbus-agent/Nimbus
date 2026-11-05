// packages/gateway/src/connectors/connector-writes/tickets.ts
import { beforeReplyJson, presentFields, requiredStringAt, stringAt } from "./before-select.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

// Before-state selects (spec 5.4): identity fields only (title, state, kind), never a body,
// description or comment list. The identity field is required: without it `select` throws and the
// prompt reads `Before: unavailable (failed)` rather than an empty block.

/** GitHub `github_issue_get`: what `#N` is, and whether it is a pull request. */
export function selectGithubIssueIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  // GitHub sets `pull_request` (an object) only on a pull request.
  const pr =
    typeof j === "object" && j !== null && Object.hasOwn(j, "pull_request")
      ? (j as Record<string, unknown>)["pull_request"]
      : undefined;
  return [
    { label: "Title", value: title },
    ...presentFields([["State", stringAt(j, ["state"])]]),
    { label: "Kind", value: pr === undefined || pr === null ? "issue" : "pull request" },
  ];
}

/** GitLab `gitlab_issue_get`: title and state. */
export function selectGitlabIssueIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    { label: "Title", value: requiredStringAt(j, ["title"]) },
    ...presentFields([["State", stringAt(j, ["state"])]]),
  ];
}

/** Jira `jira_issue_get`: summary, status, type (the reply's description and comments are ignored). */
export function selectJiraIssueIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    { label: "Summary", value: requiredStringAt(j, ["fields", "summary"]) },
    ...presentFields([
      ["Status", stringAt(j, ["fields", "status", "name"])],
      ["Type", stringAt(j, ["fields", "issuetype", "name"])],
    ]),
  ];
}

/** Linear `linear_issue_get` (`{ issue: {...} }`): the target is an opaque UUID, so name it. */
export function selectLinearIssueIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["issue", "title"]);
  return [
    ...presentFields([["Issue", stringAt(j, ["issue", "identifier"])]]),
    { label: "Title", value: title },
    ...presentFields([["State", stringAt(j, ["issue", "state", "name"])]]),
  ];
}

export const TICKETS_ROWS: readonly ConnectorWriteRow[] = [
  // The connector sends the description as one plain-text ADF paragraph, and defaults the type to
  // "Task" when none is given.
  withPreview(row("jira_issue_create", "jira.issue.create", "mesh", 2), {
    target: "{projectKey}",
    summary: "Create a Jira issue in project {projectKey}",
    fields: [
      textField("summary", "Summary"),
      textField("description", "Description (sent as plain text)", "(not set: no description)"),
      textField("issueTypeName", "Type", "Task"),
    ],
  }),
  // The connector sends only the keys given; a description replaces the whole description.
  withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
    target: "{issueKey}",
    summary: "Update Jira issue {issueKey}",
    fields: [
      textField("summary", "New summary", "(not set: unchanged)"),
      textField(
        "description",
        "New description (replaces the whole description; sent as plain text)",
        "(not set: unchanged)",
      ),
    ],
  }),
  // The connector sends the body as one plain-text ADF paragraph (`plainToAdf`).
  withBefore(
    withPreview(row("jira_comment_add", "jira.comment.add", "mesh", 2), {
      target: "{issueKey}",
      summary: "Comment on Jira issue {issueKey}",
      fields: [textField("body", "Comment (sent as plain text)")],
    }),
    {
      tool: "jira_issue_get",
      argKeys: ["issueKey"],
      args: (input) => ({ issueKey: input["issueKey"] }),
      select: selectJiraIssueIdentity,
    },
  ),
  withPreview(row("jira_issue_transition", "jira.issue.transition", "mesh", 2), {
    target: "{issueKey}",
    summary:
      "Move Jira issue {issueKey} through workflow transition {transitionId}; workflows can be one-way",
    fields: [textField("transitionId", "Transition id")],
  }),
  withPreview(row("linear_issue_create", "linear.issue.create", "mesh", 2), {
    target: "{teamId}",
    summary: "Create a Linear issue in team {teamId}",
    fields: [
      textField("title", "Title"),
      textField("description", "Description"),
      textField("priority", "Priority (0 none, 1 urgent, 2 high, 3 medium, 4 low)"),
      textField("stateId", "State id"),
      textField("assigneeId", "Assignee (Linear user id; notifies that user)"),
    ],
  }),
  // Linear has ONE assignee: `assigneeId` replaces it. The connector sends only the keys given.
  withPreview(row("linear_issue_update", "linear.issue.update", "mesh", 2), {
    target: "{issueId}",
    summary: "Update Linear issue {issueId}",
    fields: [
      textField("title", "New title", "(not set: unchanged)"),
      textField(
        "description",
        "New description (replaces the whole description)",
        "(not set: unchanged)",
      ),
      textField("stateId", "New state id", "(not set: unchanged)"),
      textField(
        "priority",
        "New priority (0 none, 1 urgent, 2 high, 3 medium, 4 low)",
        "(not set: unchanged)",
      ),
      textField(
        "assigneeId",
        "New assignee (Linear user id; replaces the current assignee)",
        "(not set: unchanged)",
      ),
    ],
  }),
  withBefore(
    withPreview(row("linear_comment_create", "linear.comment.create", "mesh", 2), {
      target: "{issueId}",
      summary: "Comment on Linear issue {issueId}",
      fields: [textField("body", "Comment")],
    }),
    {
      tool: "linear_issue_get",
      argKeys: ["issueId"],
      args: (input) => ({ issueId: input["issueId"] }),
      select: selectLinearIssueIdentity,
    },
  ),
  withPreview(row("github_issue_create", "github.issue.create", "mesh", 2), {
    target: "{owner}/{repo}",
    summary: "Create a GitHub issue in {owner}/{repo}",
    fields: [textField("title", "Title"), textField("body", "Body", "(not set: no body)")],
  }),
  // GitHub treats a pull request as an issue: the same tool comments on a PR's conversation.
  withBefore(
    withPreview(row("github_issue_comment_create", "github.issue.comment.create", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary: "Comment on GitHub issue or pull request {owner}/{repo}#{issueNumber}",
      fields: [textField("body", "Comment")],
    }),
    {
      tool: "github_issue_get",
      argKeys: ["owner", "repo", "issueNumber"],
      args: (input) => ({
        owner: input["owner"],
        repo: input["repo"],
        issueNumber: input["issueNumber"],
      }),
      select: selectGithubIssueIdentity,
    },
  ),
  // The label and assignee writes only add (pinned by add-only.sync.test.ts).
  withPreview(row("github_issue_labels_add", "github.issue.labels.add", "mesh", 2), {
    target: "{owner}/{repo}#{issueNumber}",
    summary:
      "Add labels to GitHub issue or pull request {owner}/{repo}#{issueNumber} (adds only; removes none)",
    fields: [
      textField(
        "labels",
        "Labels to add (a label that does not exist is created in the repository)",
      ),
    ],
  }),
  withPreview(row("github_issue_assignees_add", "github.issue.assignees.add", "mesh", 2), {
    target: "{owner}/{repo}#{issueNumber}",
    summary:
      "Add assignees to GitHub issue or pull request {owner}/{repo}#{issueNumber} (adds only; removes none)",
    fields: [textField("assignees", "Assignees to add (GitHub usernames; each is notified)")],
  }),
  // Given a pull request number, this closes or reopens the pull request.
  withPreview(row("github_issue_state_set", "github.issue.state.set", "mesh", 2), {
    target: "{owner}/{repo}#{issueNumber}",
    summary: "Set GitHub issue or pull request {owner}/{repo}#{issueNumber} to {state}",
    fields: [textField("state", "New state")],
  }),
  withPreview(row("gitlab_issue_create", "gitlab.issue.create", "mesh", 2), {
    target: "{projectPath}",
    summary: "Create a GitLab issue in {projectPath}",
    fields: [
      textField("title", "Title"),
      textField("description", "Description", "(not set: no description)"),
      textField("labels", "Labels", "(not set: none)"),
      textField("assigneeIds", "Assignees (GitLab user ids; each is notified)", "(not set: none)"),
    ],
  }),
  withBefore(
    withPreview(row("gitlab_issue_note_create", "gitlab.issue.note.create", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Comment on GitLab issue {projectPath}#{issueIid}",
      fields: [textField("body", "Comment")],
    }),
    {
      tool: "gitlab_issue_get",
      argKeys: ["projectPath", "issueIid"],
      args: (input) => ({ projectPath: input["projectPath"], issueIid: input["issueIid"] }),
      select: selectGitlabIssueIdentity,
    },
  ),
  withPreview(row("gitlab_issue_labels_add", "gitlab.issue.labels.add", "mesh", 2), {
    target: "{projectPath}#{issueIid}",
    summary: "Add labels to GitLab issue {projectPath}#{issueIid} (adds only; removes none)",
    fields: [textField("labels", "Labels to add")],
  }),
  withPreview(row("gitlab_issue_assignees_add", "gitlab.issue.assignees.add", "mesh", 2), {
    target: "{projectPath}#{issueIid}",
    summary: "Add assignees to GitLab issue {projectPath}#{issueIid} (adds only; removes none)",
    fields: [
      textField("assigneeUsernames", "Assignees to add (GitLab usernames; each is notified)"),
    ],
  }),
  withPreview(row("gitlab_issue_state_set", "gitlab.issue.state.set", "mesh", 2), {
    target: "{projectPath}#{issueIid}",
    summary: "Apply {stateEvent} to GitLab issue {projectPath}#{issueIid}",
    fields: [textField("stateEvent", "State change")],
  }),
];
