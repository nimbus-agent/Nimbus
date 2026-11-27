// packages/gateway/src/connectors/connector-writes/issue-edit-rows.test-helpers.ts
// Shared fixtures of the connectors 0.19.0 issue-write tests (`issue-edit-rows.test.ts`,
// `issue-edit-refusals.test.ts`): the nine rows, their action types and installed schema keys, a
// clean input each, and the two-door check.
import { expect } from "bun:test";

import type { ChatopsPolicy } from "../../policy/types.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { messagingDestinationRefusal, modelWriteRefusal } from "./model-write-refusals.ts";
import type { ConnectorWriteRow } from "./types.ts";

export const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
export const LINEAR_ISSUE = "8f2c1a9e-0b1d-4c3e-9a7f-2d5e6f708192";

/** Each row: its action type and its installed schema's keys (sorted). */
export const ROWS = {
  github_issue_labels_remove: {
    type: "github.issue.labels.remove",
    keys: ["issueNumber", "labels", "owner", "repo"],
  },
  github_issue_assignees_remove: {
    type: "github.issue.assignees.remove",
    keys: ["assignees", "issueNumber", "owner", "repo"],
  },
  github_issue_update: {
    type: "github.issue.update",
    keys: ["body", "issueNumber", "owner", "repo", "title"],
  },
  gitlab_issue_labels_remove: {
    type: "gitlab.issue.labels.remove",
    keys: ["issueIid", "labels", "projectPath"],
  },
  gitlab_issue_assignees_remove: {
    type: "gitlab.issue.assignees.remove",
    keys: ["assigneeUsernames", "issueIid", "projectPath"],
  },
  gitlab_issue_update: {
    type: "gitlab.issue.update",
    keys: ["description", "issueIid", "projectPath", "title"],
  },
  jira_issue_assign: { type: "jira.issue.assign", keys: ["accountId", "issueKey"] },
  linear_issue_labels_add: { type: "linear.issue.labels.add", keys: ["issueId", "labelIds"] },
  linear_issue_labels_remove: {
    type: "linear.issue.labels.remove",
    keys: ["issueId", "labelIds"],
  },
} as const;
export type Id = keyof typeof ROWS;
export const IDS = Object.keys(ROWS) as Id[];

export const CLEAN: Readonly<Record<Id, Readonly<Record<string, unknown>>>> = {
  github_issue_labels_remove: { owner: "o", repo: "r", issueNumber: 7, labels: ["bug", "p1"] },
  github_issue_assignees_remove: { owner: "o", repo: "r", issueNumber: 7, assignees: ["ann"] },
  github_issue_update: { owner: "o", repo: "r", issueNumber: 7, title: "Login fails on Safari" },
  gitlab_issue_labels_remove: { projectPath: "g/r", issueIid: 3, labels: ["bug"] },
  gitlab_issue_assignees_remove: { projectPath: "g/r", issueIid: 3, assigneeUsernames: ["bo"] },
  gitlab_issue_update: { projectPath: "g/r", issueIid: 3, description: "Steps: open the page" },
  jira_issue_assign: { issueKey: "NIM-7", accountId: "5b10a2844c20165700ede21g" },
  linear_issue_labels_add: { issueId: LINEAR_ISSUE, labelIds: ["lbl-1"] },
  linear_issue_labels_remove: { issueId: LINEAR_ISSUE, labelIds: ["lbl-1", "lbl-2"] },
};

export function rowOf(id: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

/** Both door entry points give the same answer (the rule is in the shared check). */
export function onBothDoors(
  id: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const messaging = messagingDestinationRefusal(id, input, { chatops: NO_CHATOPS });
  expect(modelWriteRefusal(id, input, { chatops: NO_CHATOPS, kb: undefined }), id).toBe(messaging);
  return messaging;
}
