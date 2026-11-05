// Phase 9.7 B2: the typed previews of the 13 issue writes (plan R2). Each row's template keys are
// exactly its tool's input-schema keys in `@nimbus-dev/connectors` 0.4.0
// (`connectors/<c>/src/tools.ts`), so the § 13 drift check offers it and, for well-formed input,
// `Other fields` is empty.
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { TICKETS_ROWS } from "./tickets.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const B2_ROWS = [
  "github_issue_create",
  "github_issue_labels_add",
  "github_issue_assignees_add",
  "github_issue_state_set",
  "gitlab_issue_create",
  "gitlab_issue_labels_add",
  "gitlab_issue_assignees_add",
  "gitlab_issue_state_set",
  "jira_issue_create",
  "jira_issue_update",
  "jira_issue_transition",
  "linear_issue_create",
  "linear_issue_update",
] as const;
type B2Row = (typeof B2_ROWS)[number];

/** The four B1 comment rows in `tickets.ts`. */
const B1_TICKET_ROWS = [
  "jira_comment_add",
  "linear_comment_create",
  "github_issue_comment_create",
  "gitlab_issue_note_create",
] as const;

/** The 0.4.0 input-schema keys of each row, spelled out from the connector source (sorted). */
const SCHEMA_KEYS: Readonly<Record<B2Row, readonly string[]>> = {
  github_issue_create: ["body", "owner", "repo", "title"],
  github_issue_labels_add: ["issueNumber", "labels", "owner", "repo"],
  github_issue_assignees_add: ["assignees", "issueNumber", "owner", "repo"],
  github_issue_state_set: ["issueNumber", "owner", "repo", "state"],
  gitlab_issue_create: ["assigneeIds", "description", "labels", "projectPath", "title"],
  gitlab_issue_labels_add: ["issueIid", "labels", "projectPath"],
  gitlab_issue_assignees_add: ["assigneeUsernames", "issueIid", "projectPath"],
  gitlab_issue_state_set: ["issueIid", "projectPath", "stateEvent"],
  jira_issue_create: ["description", "issueTypeName", "projectKey", "summary"],
  jira_issue_update: ["description", "issueKey", "summary"],
  jira_issue_transition: ["issueKey", "transitionId"],
  linear_issue_create: ["assigneeId", "description", "priority", "stateId", "teamId", "title"],
  linear_issue_update: ["assigneeId", "description", "issueId", "priority", "stateId", "title"],
};

const LINEAR_ISSUE = "8f2b0a1c-0000-4000-8000-000000000001";
const LINEAR_TEAM = "8f2b0a1c-0000-4000-8000-0000000000aa";

/** Well-formed input naming every schema key. */
const CLEAN: Readonly<Record<B2Row, Record<string, unknown>>> = {
  github_issue_create: { owner: "nimbus-agent", repo: "Nimbus", title: "Bug", body: "Steps" },
  github_issue_labels_add: {
    owner: "nimbus-agent",
    repo: "Nimbus",
    issueNumber: 42,
    labels: ["bug", "ui"],
  },
  github_issue_assignees_add: {
    owner: "nimbus-agent",
    repo: "Nimbus",
    issueNumber: 42,
    assignees: ["alice"],
  },
  github_issue_state_set: {
    owner: "nimbus-agent",
    repo: "Nimbus",
    issueNumber: 42,
    state: "closed",
  },
  gitlab_issue_create: {
    projectPath: "group/repo",
    title: "Bug",
    description: "Steps",
    labels: ["bug", "ui"],
    assigneeIds: [12, 34],
  },
  gitlab_issue_labels_add: { projectPath: "group/repo", issueIid: 7, labels: ["bug"] },
  gitlab_issue_assignees_add: {
    projectPath: "group/repo",
    issueIid: 7,
    assigneeUsernames: ["alice", "bob"],
  },
  gitlab_issue_state_set: { projectPath: "group/repo", issueIid: 7, stateEvent: "close" },
  jira_issue_create: {
    projectKey: "NIM",
    summary: "Bug",
    description: "Steps",
    issueTypeName: "Bug",
  },
  jira_issue_update: { issueKey: "NIM-1", summary: "New", description: "Steps" },
  jira_issue_transition: { issueKey: "NIM-1", transitionId: "31" },
  linear_issue_create: {
    teamId: LINEAR_TEAM,
    title: "Bug",
    description: "Steps",
    priority: 2,
    stateId: "state-1",
    assigneeId: "user-1",
  },
  linear_issue_update: {
    issueId: LINEAR_ISSUE,
    title: "New",
    description: "Steps",
    stateId: "state-2",
    priority: 3,
    assigneeId: "user-1",
  },
};

const GOLDEN: Readonly<Record<B2Row, readonly string[]>> = {
  github_issue_create: [
    "Service: github",
    "Credential: personal",
    "Target:  nimbus-agent/Nimbus",
    "Create a GitHub issue in nimbus-agent/Nimbus",
    "",
    '  Title: "Bug"',
    '  Body: "Steps"',
  ],
  github_issue_labels_add: [
    "Service: github",
    "Credential: personal",
    "Target:  nimbus-agent/Nimbus#42",
    "Add labels to GitHub issue or pull request nimbus-agent/Nimbus#42 (adds only; removes none)",
    "",
    '  Labels to add (a label that does not exist is created in the repository): ["bug","ui"]',
  ],
  github_issue_assignees_add: [
    "Service: github",
    "Credential: personal",
    "Target:  nimbus-agent/Nimbus#42",
    "Add assignees to GitHub issue or pull request nimbus-agent/Nimbus#42 (adds only; removes none)",
    "",
    '  Assignees to add (GitHub usernames; each is notified): ["alice"]',
  ],
  github_issue_state_set: [
    "Service: github",
    "Credential: personal",
    "Target:  nimbus-agent/Nimbus#42",
    "Set GitHub issue or pull request nimbus-agent/Nimbus#42 to closed",
    "",
    '  New state: "closed"',
  ],
  gitlab_issue_create: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo",
    "Create a GitLab issue in group/repo",
    "",
    '  Title: "Bug"',
    '  Description: "Steps"',
    '  Labels: ["bug","ui"]',
    "  Assignees (GitLab user ids; each is notified): [12,34]",
  ],
  gitlab_issue_labels_add: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo#7",
    "Add labels to GitLab issue group/repo#7 (adds only; removes none)",
    "",
    '  Labels to add: ["bug"]',
  ],
  gitlab_issue_assignees_add: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo#7",
    "Add assignees to GitLab issue group/repo#7 (adds only; removes none)",
    "",
    '  Assignees to add (GitLab usernames; each is notified): ["alice","bob"]',
  ],
  gitlab_issue_state_set: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo#7",
    "Apply close to GitLab issue group/repo#7",
    "",
    '  State change: "close"',
  ],
  jira_issue_create: [
    "Service: jira",
    "Credential: personal",
    "Target:  NIM",
    "Create a Jira issue in project NIM",
    "",
    '  Summary: "Bug"',
    '  Description (sent as plain text): "Steps"',
    '  Type: "Bug"',
  ],
  jira_issue_update: [
    "Service: jira",
    "Credential: personal",
    "Target:  NIM-1",
    "Update Jira issue NIM-1",
    "",
    '  New summary: "New"',
    '  New description (replaces the whole description; sent as plain text): "Steps"',
  ],
  jira_issue_transition: [
    "Service: jira",
    "Credential: personal",
    "Target:  NIM-1",
    "Move Jira issue NIM-1 through workflow transition 31; workflows can be one-way",
    "",
    '  Transition id: "31"',
  ],
  linear_issue_create: [
    "Service: linear",
    "Credential: personal",
    `Target:  ${LINEAR_TEAM}`,
    `Create a Linear issue in team ${LINEAR_TEAM}`,
    "",
    '  Title: "Bug"',
    '  Description: "Steps"',
    "  Priority (0 none, 1 urgent, 2 high, 3 medium, 4 low): 2",
    '  State id: "state-1"',
    '  Assignee (Linear user id; notifies that user): "user-1"',
  ],
  linear_issue_update: [
    "Service: linear",
    "Credential: personal",
    `Target:  ${LINEAR_ISSUE}`,
    `Update Linear issue ${LINEAR_ISSUE}`,
    "",
    '  New title: "New"',
    '  New description (replaces the whole description): "Steps"',
    '  New state id: "state-2"',
    "  New priority (0 none, 1 urgent, 2 high, 3 medium, 4 low): 3",
    '  New assignee (Linear user id; replaces the current assignee): "user-1"',
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(toolId: B2Row, input: Record<string, unknown>): ConnectorWritePreview {
  const r = rowOf(toolId);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), toolId), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${toolId}`);
  return p;
}

function fieldValue(p: ConnectorWritePreview, label: string): string | undefined {
  return p.fields.find((f) => f.label === label)?.value;
}

describe("B2 typed previews (plan R2)", () => {
  test("the B2 rows are exactly the issue writes: mesh, wave 2, templated, offerable", () => {
    expect(B2_ROWS).toHaveLength(13);
    for (const id of B2_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(2);
      expect(r.preview, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
    // Together with the four B1 comment rows they are every row of the tickets table.
    expect(TICKETS_ROWS.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual(
      [...B2_ROWS, ...B1_TICKET_ROWS].sort((a, b) => a.localeCompare(b)),
    );
  });

  for (const id of B2_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("unset optional fields show their real default or say they are unchanged", () => {
    const jiraCreate = previewOf("jira_issue_create", { projectKey: "NIM", summary: "Bug" });
    expect(fieldValue(jiraCreate, "Type")).toBe("Task");
    expect(fieldValue(jiraCreate, "Description (sent as plain text)")).toBe(
      "(not set: no description)",
    );

    const jiraUpdate = previewOf("jira_issue_update", { issueKey: "NIM-1", summary: "New" });
    expect(
      fieldValue(
        jiraUpdate,
        "New description (replaces the whole description; sent as plain text)",
      ),
    ).toBe("(not set: unchanged)");

    const linearUpdate = previewOf("linear_issue_update", {
      issueId: LINEAR_ISSUE,
      stateId: "state-2",
    });
    const unchanged = linearUpdate.fields.filter((f) => f.value === "(not set: unchanged)");
    expect(unchanged.map((f) => f.label)).toEqual([
      "New title",
      "New description (replaces the whole description)",
      "New priority (0 none, 1 urgent, 2 high, 3 medium, 4 low)",
      "New assignee (Linear user id; replaces the current assignee)",
    ]);

    const gitlabCreate = previewOf("gitlab_issue_create", {
      projectPath: "group/repo",
      title: "Bug",
    });
    expect(fieldValue(gitlabCreate, "Labels")).toBe("(not set: none)");
    expect(fieldValue(gitlabCreate, "Assignees (GitLab user ids; each is notified)")).toBe(
      "(not set: none)",
    );
    expect(fieldValue(gitlabCreate, "Description")).toBe("(not set: no description)");

    const githubCreate = previewOf("github_issue_create", {
      owner: "nimbus-agent",
      repo: "Nimbus",
      title: "Bug",
    });
    expect(fieldValue(githubCreate, "Body")).toBe("(not set: no body)");
  });

  test("a key the model adds beyond the schema is still shown under Other fields", () => {
    const p = previewOf("jira_issue_transition", {
      ...CLEAN.jira_issue_transition,
      transitionName: "Backlog",
    });
    expect(p.otherFields).toEqual([{ key: "transitionName", value: '"Backlog"' }]);
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of B2_ROWS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });

  test("the drift keys equal the 0.4.0 schema keys", () => {
    for (const id of B2_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...SCHEMA_KEYS[id]]);
    }
  });
});
