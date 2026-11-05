// packages/gateway/src/connectors/connector-writes/tickets.ts
import {
  beforeReplyJson,
  listAt,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import { LINEAR_ASSIGNEE_REFUSAL } from "./model-write-refusals.ts";
import {
  type BeforeStateField,
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

// Before-state selects (spec 5.4): identity and state fields (title, state, status, kind, labels,
// assignees, priority, the transition), never a body, description or comment list. The identity
// field is required: without it `select` throws and the prompt reads `Before: unavailable
// (failed)` rather than an empty block. A list (labels, assignees) shows at most 50 entries and
// counts the rest (`listAt`); an empty one reads `(none)`.

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

/** GitHub `github_issue_get`, for a label, assignee or state change: identity plus that state. */
export function selectGithubIssueState(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    ...selectGithubIssueIdentity(j),
    ...presentFields([
      ["Labels", listAt(j, ["labels"], "name")],
      ["Assignees", listAt(j, ["assignees"], "login")],
    ]),
  ];
}

/** GitLab `gitlab_issue_get`, for a label, assignee or state change (labels are strings). */
export function selectGitlabIssueState(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    ...selectGitlabIssueIdentity(j),
    ...presentFields([
      ["Labels", listAt(j, ["labels"])],
      ["Assignees", listAt(j, ["assignees"], "username")],
    ]),
  ];
}

/** The reply's own `issue` object, or `undefined` (absent, null, an array, inherited). */
function linearIssueOf(j: unknown): Record<string, unknown> | undefined {
  if (typeof j !== "object" || j === null || !Object.hasOwn(j, "issue")) return undefined;
  const issue = (j as Record<string, unknown>)["issue"];
  if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return undefined;
  return issue as Record<string, unknown>;
}

/** The current Linear assignee's name, `(none)` for an own `null`; absent when it cannot say. */
function linearAssigneeName(j: unknown): string | undefined {
  const issue = linearIssueOf(j);
  if (issue === undefined || !Object.hasOwn(issue, "assignee")) return undefined;
  if (issue["assignee"] === null) return "(none)";
  return stringAt(issue, ["assignee", "displayName"]) ?? stringAt(issue, ["assignee", "name"]);
}

/** Linear `linear_issue_get`, for an update: identity, state, priority and the one assignee. */
export function selectLinearIssueState(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  return [
    ...selectLinearIssueIdentity(j),
    ...presentFields([
      ["Priority", stringAt(j, ["issue", "priority"])],
      ["Assignee", linearAssigneeName(j)],
    ]),
  ];
}

/**
 * The `linear_issue_update` guard's `allows` (OR-B2-3): true ONLY when the reply's own
 * `issue.assignee` is present and exactly `null`. An assignee, a missing or inherited key,
 * `issue: null`, an unparseable or error reply: false (the write is refused before the prompt).
 */
export function linearAssigneeProvenNull(reply: unknown): boolean {
  let j: unknown;
  try {
    j = beforeReplyJson(reply);
  } catch {
    return false;
  }
  const issue = linearIssueOf(j);
  return issue !== undefined && Object.hasOwn(issue, "assignee") && issue["assignee"] === null;
}

/** The text shown as the target status when the issue does not offer the transition now. */
export const JIRA_TRANSITION_NOT_AVAILABLE = "not available for this issue now";

/** The text shown for an offered transition whose name or target status the reply omits. */
export const JIRA_TRANSITION_UNKNOWN = "(unknown)";

/**
 * Jira transition (OR-B2-1): `alsoReply` is `jira_issue_get` (its status is the identity and the
 * From); `reply` is `jira_issue_transitions_list`, whose `transitions` array is required; the entry
 * whose `id` equals the write's `transitionId` gives the Transition name and the To status (each
 * {@link JIRA_TRANSITION_UNKNOWN} when the entry omits it, so the To line is never dropped). No
 * such entry: To reads {@link JIRA_TRANSITION_NOT_AVAILABLE} (the write would fail upstream).
 */
export function selectJiraTransition(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
  alsoReply: unknown,
): readonly BeforeStateField[] {
  const issue = beforeReplyJson(alsoReply);
  const from = requiredStringAt(issue, ["fields", "status", "name"]);
  const list = beforeReplyJson(reply);
  const transitions =
    typeof list === "object" && list !== null && Object.hasOwn(list, "transitions")
      ? (list as Record<string, unknown>)["transitions"]
      : undefined;
  if (!Array.isArray(transitions)) throw new Error("before reply: no transitions");
  const raw = picked["transitionId"];
  const wanted = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  const entry =
    wanted === undefined
      ? undefined
      : (transitions as unknown[]).find((t) => stringAt(t, ["id"]) === wanted);
  if (entry === undefined) {
    return [
      { label: "From", value: from },
      { label: "To", value: JIRA_TRANSITION_NOT_AVAILABLE },
    ];
  }
  return [
    { label: "From", value: from },
    { label: "Transition", value: stringAt(entry, ["name"]) ?? JIRA_TRANSITION_UNKNOWN },
    { label: "To", value: stringAt(entry, ["to", "name"]) ?? JIRA_TRANSITION_UNKNOWN },
  ];
}

/** One read of `github_issue_get` for a change to issue `#issueNumber`. */
const GITHUB_ISSUE_STATE_READER: BeforeStateReader = {
  tool: "github_issue_get",
  argKeys: ["owner", "repo", "issueNumber"],
  args: (input) => ({
    owner: input["owner"],
    repo: input["repo"],
    issueNumber: input["issueNumber"],
  }),
  select: selectGithubIssueState,
};

/** One read of `gitlab_issue_get` for a change to issue `#issueIid`. */
const GITLAB_ISSUE_STATE_READER: BeforeStateReader = {
  tool: "gitlab_issue_get",
  argKeys: ["projectPath", "issueIid"],
  args: (input) => ({ projectPath: input["projectPath"], issueIid: input["issueIid"] }),
  select: selectGitlabIssueState,
};

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
  // The connector sends only the keys given; a description replaces the whole description. The
  // before shows summary, status and type; the current description (ADF, unbounded) is not shown,
  // and the field label says so.
  withBefore(
    withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
      target: "{issueKey}",
      summary: "Update Jira issue {issueKey}",
      fields: [
        textField("summary", "New summary", "(not set: unchanged)"),
        textField(
          "description",
          "New description (replaces the current one, which is not shown; sent as plain text)",
          "(not set: unchanged)",
        ),
      ],
    }),
    {
      tool: "jira_issue_get",
      argKeys: ["issueKey"],
      args: (input) => ({ issueKey: input["issueKey"] }),
      select: selectJiraIssueIdentity,
    },
  ),
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
  // OR-B2-1: the before reads the transitions the issue offers now, then the issue itself, so the
  // prompt shows From (its current status), the Transition and To. Two `jira.before.read` actions
  // under one 5 s budget, all or nothing.
  withBefore(
    withPreview(row("jira_issue_transition", "jira.issue.transition", "mesh", 2), {
      target: "{issueKey}",
      summary:
        "Move Jira issue {issueKey} through workflow transition {transitionId}; workflows can be one-way",
      fields: [textField("transitionId", "Transition id")],
    }),
    {
      tool: "jira_issue_transitions_list",
      // `transitionId` is read by the selection (which entry), never sent to the read.
      argKeys: ["issueKey", "transitionId"],
      args: (input) => ({ issueKey: input["issueKey"] }),
      also: {
        tool: "jira_issue_get",
        argKeys: ["issueKey"],
        args: (input) => ({ issueKey: input["issueKey"] }),
      },
      select: selectJiraTransition,
    },
  ),
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
  // OR-B2-3: an `assigneeId` is allowed only while the issue is unassigned, proven by the before
  // read at call time (the guard); anything but an own `assignee: null` refuses before the prompt.
  // Bound: someone can assign the issue between the read and the write.
  withBefore(
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
    {
      tool: "linear_issue_get",
      // `assigneeId` is declared for the guard, never sent to the read.
      argKeys: ["issueId", "assigneeId"],
      args: (input) => ({ issueId: input["issueId"] }),
      select: selectLinearIssueState,
      guard: {
        reason: LINEAR_ASSIGNEE_REFUSAL,
        // An explicit null also applies: it would UNASSIGN an assigned issue (CodeRabbit, #1901).
        appliesTo: (picked) => picked["assigneeId"] !== undefined,
        allows: (reply) => linearAssigneeProvenNull(reply),
      },
    },
  ),
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
  withBefore(
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
    GITHUB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("github_issue_assignees_add", "github.issue.assignees.add", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary:
        "Add assignees to GitHub issue or pull request {owner}/{repo}#{issueNumber} (adds only; removes none)",
      fields: [textField("assignees", "Assignees to add (GitHub usernames; each is notified)")],
    }),
    GITHUB_ISSUE_STATE_READER,
  ),
  // Given a pull request number, this closes or reopens the pull request.
  withBefore(
    withPreview(row("github_issue_state_set", "github.issue.state.set", "mesh", 2), {
      target: "{owner}/{repo}#{issueNumber}",
      summary: "Set GitHub issue or pull request {owner}/{repo}#{issueNumber} to {state}",
      fields: [textField("state", "New state")],
    }),
    GITHUB_ISSUE_STATE_READER,
  ),
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
  withBefore(
    withPreview(row("gitlab_issue_labels_add", "gitlab.issue.labels.add", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Add labels to GitLab issue {projectPath}#{issueIid} (adds only; removes none)",
      fields: [textField("labels", "Labels to add")],
    }),
    GITLAB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("gitlab_issue_assignees_add", "gitlab.issue.assignees.add", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Add assignees to GitLab issue {projectPath}#{issueIid} (adds only; removes none)",
      fields: [
        textField("assigneeUsernames", "Assignees to add (GitLab usernames; each is notified)"),
      ],
    }),
    GITLAB_ISSUE_STATE_READER,
  ),
  withBefore(
    withPreview(row("gitlab_issue_state_set", "gitlab.issue.state.set", "mesh", 2), {
      target: "{projectPath}#{issueIid}",
      summary: "Apply {stateEvent} to GitLab issue {projectPath}#{issueIid}",
      fields: [textField("stateEvent", "State change")],
    }),
    GITLAB_ISSUE_STATE_READER,
  ),
];
