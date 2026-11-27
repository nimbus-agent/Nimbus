// The nine Wave 2 issue writes of `@nimbus-dev/connectors` 0.19.0 (`issue-edit-rows.ts`): each
// row's typed preview, its drift keys against the installed connector's schema, its offer (Wave 2,
// like the shipped `_add` siblings), its before-state reader and guard, its reversibility (none:
// unknown). The door refusals are in `issue-edit-refusals.test.ts`; the removes' "removes only"
// claim is pinned against the installed requests in `add-only.sync.test.ts`.
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { beforeReaderProblems } from "./before-reader.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  installedRegistration,
  installedToolsSource,
  objectKeysAt,
} from "./installed-schema-keys.test-helpers.ts";
import { CLEAN, IDS, type Id, LINEAR_ISSUE, ROWS, rowOf } from "./issue-edit-rows.test-helpers.ts";
import {
  GITLAB_GRAPHQL_PATH_GUARD,
  ISSUE_EDIT_ROWS,
  JIRA_ASSIGN_ACCOUNT_GUARD,
  selectJiraIssueAssignee,
} from "./issue-edit-rows.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { REVERSIBILITY_TABLE } from "./reversibility.ts";
import {
  GITHUB_ISSUE_STATE_READER,
  GITLAB_ISSUE_STATE_READER,
  selectGithubIssueIdentity,
  selectGitlabIssueIdentity,
  selectLinearIssueIdentity,
} from "./tickets.ts";
import { previewTemplateKeys } from "./types.ts";

const GOLDEN: Readonly<Record<Id, readonly string[]>> = {
  github_issue_labels_remove: [
    "Service: github",
    "Credential: personal",
    "Target:  o/r#7",
    "Remove labels from GitHub issue or pull request o/r#7 (removes only; adds none)",
    "",
    '  Labels to remove (one request each, in order; it stops at the first one GitHub refuses, such as a label not on the issue): ["bug","p1"]',
  ],
  github_issue_assignees_remove: [
    "Service: github",
    "Credential: personal",
    "Target:  o/r#7",
    "Remove assignees from GitHub issue or pull request o/r#7 (removes only; adds none)",
    "",
    '  Assignees to remove (GitHub usernames; one not assigned is ignored): ["ann"]',
  ],
  github_issue_update: [
    "Service: github",
    "Credential: personal",
    "Target:  o/r#7",
    "Edit GitHub issue or pull request o/r#7 (title and body only)",
    "",
    '  New title: "Login fails on Safari"',
    "  New body (replaces the whole body, which is not shown): (not set: unchanged)",
  ],
  gitlab_issue_labels_remove: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  g/r#3",
    "Remove labels from GitLab issue g/r#3 (removes only; adds none)",
    "",
    '  Labels to remove (one not on the issue is ignored): ["bug"]',
  ],
  gitlab_issue_assignees_remove: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  g/r#3",
    "Remove assignees from GitLab issue g/r#3 (removes only; adds none)",
    "",
    '  Assignees to remove (GitLab usernames): ["bo"]',
  ],
  gitlab_issue_update: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  g/r#3",
    "Edit GitLab issue g/r#3 (title and description only)",
    "",
    "  New title: (not set: unchanged)",
    '  New description (replaces the whole description, which is not shown): "Steps: open the page"',
  ],
  jira_issue_assign: [
    "Service: jira",
    "Credential: personal",
    "Target:  NIM-7",
    "Set the assignee of Jira issue NIM-7 (replaces the current assignee)",
    "",
    '  New assignee (Jira account id; notifies that account): "5b10a2844c20165700ede21g"',
  ],
  linear_issue_labels_add: [
    "Service: linear",
    "Credential: personal",
    `Target:  ${LINEAR_ISSUE}`,
    `Add labels to Linear issue ${LINEAR_ISSUE} (adds only; removes none)`,
    "",
    '  Label ids to add: ["lbl-1"]',
  ],
  linear_issue_labels_remove: [
    "Service: linear",
    "Credential: personal",
    `Target:  ${LINEAR_ISSUE}`,
    `Remove labels from Linear issue ${LINEAR_ISSUE} (removes only; adds none)`,
    "",
    '  Label ids to remove: ["lbl-1","lbl-2"]',
  ],
};

function previewOf(id: string, input: Readonly<Record<string, unknown>>): ConnectorWritePreview {
  const r = rowOf(id);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), id), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${id}`);
  return p;
}

describe("connectors 0.19.0 issue writes: the rows", () => {
  test("exactly the nine, in the table, as Wave 2 mesh rows under their own frozen HITL types", () => {
    expect(ISSUE_EDIT_ROWS.map((r) => r.toolId)).toEqual(IDS);
    for (const id of IDS) {
      const r = rowOf(id);
      expect(r.actionType, id).toBe(ROWS[id].type);
      expect(serviceOf(r.actionType), id).toBe(id.split("_")[0] ?? "");
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(2);
      expect(HITL_REQUIRED.has(r.actionType), id).toBe(true);
      expect(r.confirm, id).toBeUndefined();
      expect(r.bound, id).toBeUndefined();
    }
  });

  test("offered to the model behind the typed preview (owner ruling), never on the never-offered list", () => {
    for (const id of IDS) {
      expect(isModelOfferableRow(rowOf(id)), id).toBe(true);
      expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(id), id).toBe(false);
    }
  });

  test("no reversibility entry (unknown, like the shipped _add siblings; owner ruling)", () => {
    for (const id of IDS) {
      expect(Object.hasOwn(REVERSIBILITY_TABLE, id), id).toBe(false);
      expect(rowOf(id).reversibility, id).toBeUndefined();
    }
  });

  test("the drift keys are exactly the installed connector's schema keys", () => {
    for (const id of IDS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...ROWS[id].keys]);
    }
    const gh = installedToolsSource("github");
    const ghBase = [
      ...objectKeysAt(gh, "const repoSlugArgs = z.object("),
      ...objectKeysAt(gh, "const githubIssueNumberSchema = repoSlugArgs.extend("),
    ];
    expect(ghBase).toEqual(["owner", "repo", "issueNumber"]);
    const ghKeys = (id: string, anchor: string): string[] =>
      [...ghBase, ...objectKeysAt(installedRegistration(id, "github"), anchor)].sort();
    expect(ghKeys("github_issue_labels_remove", "githubIssueNumberSchema.extend(")).toEqual([
      ...ROWS.github_issue_labels_remove.keys,
    ]);
    expect(ghKeys("github_issue_assignees_remove", "githubIssueNumberSchema.extend(")).toEqual([
      ...ROWS.github_issue_assignees_remove.keys,
    ]);
    expect(installedRegistration("github_issue_update", "github")).toContain(
      "githubIssueUpdateSchema,",
    );
    expect(
      [
        ...ghBase,
        ...objectKeysAt(gh, "const githubIssueUpdateSchema = githubIssueNumberSchema.extend("),
      ].sort(),
    ).toEqual([...ROWS.github_issue_update.keys]);

    const gl = installedToolsSource("gitlab");
    const glBase = [
      ...objectKeysAt(gl, "const projectPathArg = z.object("),
      ...objectKeysAt(gl, "const gitlabIssueGetSchema = projectPathArg.extend("),
    ];
    expect(glBase).toEqual(["projectPath", "issueIid"]);
    for (const id of [
      "gitlab_issue_labels_remove",
      "gitlab_issue_assignees_remove",
      "gitlab_issue_update",
    ] as const) {
      const ext = objectKeysAt(installedRegistration(id, "gitlab"), "gitlabIssueGetSchema.extend(");
      expect([...new Set([...glBase, ...ext])].sort(), id).toEqual([...ROWS[id].keys]);
    }

    expect(
      [
        ...objectKeysAt(
          installedRegistration("jira_issue_assign", "jira"),
          "z.object({ issueKey: issueKeyInPathSchema",
        ),
      ].sort(),
    ).toEqual([...ROWS.jira_issue_assign.keys]);
    const linear = installedToolsSource("linear");
    expect([...objectKeysAt(linear, "const linearIssueLabelsSchema = z.object(")].sort()).toEqual([
      ...ROWS.linear_issue_labels_add.keys,
    ]);
    for (const id of ["linear_issue_labels_add", "linear_issue_labels_remove"]) {
      expect(installedRegistration(id, "linear"), id).toContain("linearIssueLabelsSchema,");
    }
  });
});

describe("connectors 0.19.0 issue writes: the typed previews", () => {
  for (const id of IDS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of IDS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });

  test("a null accountId reads as the unassign it is", () => {
    const p = previewOf("jira_issue_assign", { issueKey: "NIM-7", accountId: null });
    expect(p.fields.map((f) => [f.label, f.value])).toEqual([
      [
        "New assignee (Jira account id; notifies that account)",
        "(null: UNASSIGN the issue, nobody is assigned)",
      ],
    ]);
  });
});

describe("connectors 0.19.0 issue writes: the before-state readers", () => {
  const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

  test("every reader passes the structural checks", () => {
    for (const id of IDS) expect(beforeReaderProblems(rowOf(id)), id).toEqual([]);
  });

  test("the removes read the issue's labels and assignees with the shipped _add siblings' reader", () => {
    expect(rowOf("github_issue_labels_remove").before).toEqual(GITHUB_ISSUE_STATE_READER);
    expect(rowOf("github_issue_assignees_remove").before).toEqual(GITHUB_ISSUE_STATE_READER);
    expect(rowOf("gitlab_issue_labels_remove").before).toEqual(GITLAB_ISSUE_STATE_READER);
    const glAssignees = rowOf("gitlab_issue_assignees_remove").before;
    expect(glAssignees?.select).toBe(GITLAB_ISSUE_STATE_READER.select);
    expect(glAssignees?.guard).toBe(GITLAB_GRAPHQL_PATH_GUARD);
  });

  test("the edits read identity and state, never the body or description, and refuse an empty edit", () => {
    const gh = rowOf("github_issue_update").before;
    expect(gh?.tool).toBe("github_issue_get");
    expect(gh?.select).toBe(selectGithubIssueIdentity);
    expect(gh?.args({ ...CLEAN.github_issue_update, body: "x" })).toEqual({
      owner: "o",
      repo: "r",
      issueNumber: 7,
    });
    const gl = rowOf("gitlab_issue_update").before;
    expect(gl?.tool).toBe("gitlab_issue_get");
    expect(gl?.select).toBe(selectGitlabIssueIdentity);
    expect(gl?.args(CLEAN.gitlab_issue_update)).toEqual({ projectPath: "g/r", issueIid: 3 });
    for (const [r, keys] of [
      [gh, ["title", "body"]],
      [gl, ["title", "description"]],
    ] as const) {
      const guard = r?.guard;
      if (guard === undefined) throw new Error("no guard");
      expect(guard.reason).toBe(`set at least one of ${keys.join(", ")}`);
      expect(guard.appliesTo({}, undefined)).toBe(true);
      expect(guard.appliesTo({ [keys[0]]: "t" }, undefined)).toBe(false);
      expect(guard.appliesTo({ [keys[1]]: "" }, undefined)).toBe(false);
      expect(guard.allows(undefined, {}, undefined, undefined)).toBe(false);
    }
    const fields = selectGithubIssueIdentity(mcp({ title: "T", state: "open", body: "SECRET" }));
    expect(JSON.stringify(fields)).not.toContain("SECRET");
  });

  test("the GitLab assignee remove refuses a numeric project id before the prompt", () => {
    const g = GITLAB_GRAPHQL_PATH_GUARD;
    expect(g.appliesTo({ projectPath: "123" }, undefined)).toBe(true);
    expect(g.appliesTo({ projectPath: "g/r" }, undefined)).toBe(false);
    expect(g.appliesTo({ projectPath: "g/123" }, undefined)).toBe(false);
    expect(g.appliesTo({}, undefined)).toBe(false);
    expect(g.allows(undefined, { projectPath: "123" }, undefined, undefined)).toBe(false);
  });

  test("the Jira assign shows summary, status, type and the current assignee; refuses an absent accountId", () => {
    const r = rowOf("jira_issue_assign").before;
    expect(r?.tool).toBe("jira_issue_get");
    expect(r?.args(CLEAN.jira_issue_assign)).toEqual({ issueKey: "NIM-7" });
    expect(r?.select).toBe(selectJiraIssueAssignee);
    expect(r?.guard).toBe(JIRA_ASSIGN_ACCOUNT_GUARD);
    const issue = (assignee: unknown) =>
      mcp({
        key: "NIM-7",
        fields: {
          summary: "Login fails",
          status: { name: "In Progress" },
          issuetype: { name: "Bug" },
          description: "DESCRIPTION-MUST-NOT-SHOW",
          assignee,
        },
      });
    const fields = selectJiraIssueAssignee(
      issue({ accountId: "5b10a2844c20165700ede21g", displayName: "Ann Lee" }),
    );
    expect(fields).toEqual([
      { label: "Summary", value: "Login fails" },
      { label: "Status", value: "In Progress" },
      { label: "Type", value: "Bug" },
      { label: "Assignee", value: "Ann Lee" },
    ]);
    expect(JSON.stringify(fields)).not.toContain("DESCRIPTION-MUST-NOT-SHOW");
    expect(selectJiraIssueAssignee(issue(null)).at(-1)).toEqual({
      label: "Assignee",
      value: "(none)",
    });
    expect(selectJiraIssueAssignee(issue({ accountId: "a1" })).at(-1)).toEqual({
      label: "Assignee",
      value: "a1",
    });
    expect(() => selectJiraIssueAssignee(mcp({ fields: {} }))).toThrow();
    const g = JIRA_ASSIGN_ACCOUNT_GUARD;
    expect(g.appliesTo({ issueKey: "NIM-7" }, undefined)).toBe(true);
    expect(g.appliesTo({ issueKey: "NIM-7", accountId: null }, undefined)).toBe(false);
    expect(g.appliesTo({ issueKey: "NIM-7", accountId: "a1" }, undefined)).toBe(false);
  });

  test("the Linear label writes read the issue's identity", () => {
    for (const id of ["linear_issue_labels_add", "linear_issue_labels_remove"]) {
      const r = rowOf(id).before;
      expect(r?.tool, id).toBe("linear_issue_get");
      expect(r?.select, id).toBe(selectLinearIssueIdentity);
      expect(r?.args(CLEAN.linear_issue_labels_add), id).toEqual({ issueId: LINEAR_ISSUE });
    }
  });
});
