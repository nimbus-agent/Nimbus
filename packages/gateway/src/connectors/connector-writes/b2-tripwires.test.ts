// B2 tripwires (plan R6): every offerable GitHub/GitLab text and label field is scanned. Moved out
// of `model-write-refusals.test.ts` (whose size is locked by `audit:file-size`), unchanged except
// for the connectors 0.19.0 rows.
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  LINEAR_ASSIGNEE_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  quickActionTextKeys,
  scannedTextKeys,
  scopedLabelKeys,
  type TribalKbConfig,
} from "./model-write-refusals.ts";
import { previewTemplateKeys } from "./types.ts";

const KB: TribalKbConfig = {
  notion: { databaseId: "1A2B3C4D-5E6F-7a8b-9c0d-112233445566" },
  confluence: { spaceKey: "KB", parentPageId: "98765" },
};

describe("B2 tripwires: every offerable GitHub/GitLab text and label field is scanned (plan R6)", () => {
  const offerable = CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow);
  const ofSvc = (svcs: readonly string[]) =>
    offerable
      .filter((r) => svcs.includes(serviceOf(r.actionType)))
      .map((r) => r.toolId)
      .sort((a, b) => a.localeCompare(b));

  /** The broadcast-scanned keys of every offerable GitHub/GitLab row, spelled out. */
  const BROADCAST_KEYS: Readonly<Record<string, readonly string[]>> = {
    github_issue_comment_create: ["body"],
    github_issue_create: ["title", "body"],
    github_issue_labels_add: [],
    github_issue_assignees_add: [],
    github_issue_state_set: [],
    github_pr_close: [],
    github_branch_create: [],
    github_pr_create: ["title", "body"],
    github_pr_update: ["title", "body"],
    gitlab_branch_create: [],
    gitlab_mr_create: ["title", "description"],
    gitlab_mr_update: ["title", "description"],
    gitlab_issue_note_create: ["body"],
    gitlab_mr_note_create: ["body"],
    gitlab_issue_create: ["title", "description"],
    gitlab_issue_labels_add: [],
    gitlab_issue_assignees_add: [],
    gitlab_issue_state_set: [],
    // Connectors 0.19.0: the issue edits and the review (its inline comments' bodies too, through
    // `nested-text-refusals.ts`, pinned in `github-pr-review-rows.test.ts`); the removes carry no text.
    github_issue_labels_remove: [],
    github_issue_assignees_remove: [],
    github_issue_update: ["title", "body"],
    github_pr_review_create: ["body"],
    gitlab_issue_labels_remove: [],
    gitlab_issue_assignees_remove: [],
    gitlab_issue_update: ["title", "description"],
    // D1 Wave 4 rows: their free text (commitTitle, mergeCommitMessage) is shown in full and not
    // scanned (the free-text table in d1-templates.test.ts gives the reason for each).
    github_pr_merge: [],
    github_branch_delete: [],
    github_tag_create: [],
    gitlab_mr_merge: [],
    gitlab_pipeline_retry: [],
    gitlab_pipeline_cancel: [],
    // D1c: the multi-file commits. `message` and `files[].content` are shown in full and not
    // scanned (a nested file text is code, spec § 15.3; the commit message's notification behaviour
    // is not verified live, plan open question 6). The named test of that decision lands with the
    // model-door refusals.
    github_file_commit: [],
    gitlab_commit_create: [],
  };

  /** The quick-action keys of every offerable GitLab row (never a title: ruling R-QA). */
  const QUICK_ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
    gitlab_issue_note_create: ["body"],
    gitlab_mr_note_create: ["body"],
    gitlab_issue_create: ["description"],
    gitlab_issue_labels_add: [],
    gitlab_issue_assignees_add: [],
    gitlab_issue_state_set: [],
    // Connectors 0.19.0 (the edit's description; GitLab does not parse a title).
    gitlab_issue_labels_remove: [],
    gitlab_issue_assignees_remove: [],
    gitlab_issue_update: ["description"],
    gitlab_branch_create: [],
    gitlab_mr_create: ["description"],
    gitlab_mr_update: ["description"],
    gitlab_mr_merge: [],
    gitlab_pipeline_retry: [],
    gitlab_pipeline_cancel: [],
    gitlab_commit_create: [],
  };

  test("the broadcast map names exactly the offerable GitHub/GitLab rows, and each row scans those keys", () => {
    expect(ofSvc(["github", "gitlab"])).toEqual(
      Object.keys(BROADCAST_KEYS).sort((a, b) => a.localeCompare(b)),
    );
    for (const [toolId, keys] of Object.entries(BROADCAST_KEYS)) {
      expect(scannedTextKeys(toolId), toolId).toEqual(keys);
    }
  });

  test("the quick-action map names exactly the offerable GitLab rows, and each row scans those keys", () => {
    expect(ofSvc(["gitlab"])).toEqual(
      Object.keys(QUICK_ACTION_KEYS).sort((a, b) => a.localeCompare(b)),
    );
    for (const [toolId, keys] of Object.entries(QUICK_ACTION_KEYS)) {
      expect(quickActionTextKeys(toolId), toolId).toEqual(keys);
    }
  });

  test("every offerable GitLab row whose schema has labels is checked by the scoped-label rule", () => {
    // Except the 0.19.0 remove: removing `key::value` removes that one label and no other, so the
    // rule's reason (an add that drops the same key's label) does not arise.
    const REMOVES = ["gitlab_issue_labels_remove"];
    for (const id of REMOVES) expect(scopedLabelKeys(id), id).toEqual([]);
    const withLabels = offerable.filter(
      (r) =>
        serviceOf(r.actionType) === "gitlab" &&
        r.preview !== undefined &&
        previewTemplateKeys(r.preview).has("labels") &&
        !REMOVES.includes(r.toolId),
    );
    expect(withLabels.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual([
      "gitlab_issue_create",
      "gitlab_issue_labels_add",
    ]);
    for (const r of withLabels) expect(scopedLabelKeys(r.toolId), r.toolId).toEqual(["labels"]);
    // And only those: no other row's input is read as a GitLab label list.
    for (const r of CONNECTOR_WRITE_ROWS) {
      if (!withLabels.includes(r)) expect(scopedLabelKeys(r.toolId), r.toolId).toEqual([]);
    }
  });

  test("Jira and Linear issue text is not scanned (stated scope): @all is allowed there", () => {
    for (const [toolId, input] of [
      ["jira_issue_create", { projectKey: "NIM", summary: "@all", description: "@all /close" }],
      ["jira_issue_update", { issueKey: "NIM-1", description: "@here" }],
      ["linear_issue_create", { teamId: "t", title: "@all", description: "@all" }],
      ["linear_issue_update", { issueId: "i", description: "@all" }],
    ] as const) {
      expect(scannedTextKeys(toolId), toolId).toEqual([]);
      expect(messagingDestinationRefusal(toolId, input, { chatops: undefined }), toolId).toBe(
        undefined,
      );
    }
  });

  test("the model door never applies the act-door Linear rule: the guard decides there", () => {
    for (const assigneeId of ["user-1", "", null, undefined]) {
      expect(
        modelWriteRefusal(
          "linear_issue_update",
          { issueId: "i", assigneeId },
          { chatops: undefined, kb: KB },
        ),
        String(assigneeId),
      ).toBeUndefined();
    }
    expect(LINEAR_ASSIGNEE_REFUSAL).toBe(
      "the model can assign a Linear issue only while it is unassigned; ask the owner to reassign it",
    );
  });
});
