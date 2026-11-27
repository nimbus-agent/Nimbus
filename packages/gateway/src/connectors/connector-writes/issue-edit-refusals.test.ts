// The door refusals of the nine connectors 0.19.0 issue writes (`issue-edit-rows.ts`): broadcast
// mentions and remote content in the edits' title and text, GitLab quick actions in a description,
// null optionals, and nothing scanned on the rows that carry no free text. Split from
// `issue-edit-rows.test.ts`, which holds the rows, previews and readers.
import { describe, expect, test } from "bun:test";

import { CLEAN, IDS, onBothDoors } from "./issue-edit-rows.test-helpers.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  GITLAB_QUICK_ACTION_REFUSAL,
  nullOptionalFieldRefusal,
  nullRefusedOptionalKeys,
  quickActionTextKeys,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  scannedTextKeys,
  scopedLabelKeys,
} from "./model-write-refusals.ts";

describe("connectors 0.19.0 issue writes: door refusals", () => {
  test("the clean inputs pass both doors", () => {
    for (const id of IDS) expect(onBothDoors(id, CLEAN[id]), id).toBeUndefined();
  });

  test("the edits scan title and text for broadcast mentions, and the text for remote content", () => {
    expect(scannedTextKeys("github_issue_update")).toEqual(["title", "body"]);
    expect(scannedTextKeys("gitlab_issue_update")).toEqual(["title", "description"]);
    expect(remoteContentScannedKeys("github_issue_update")).toEqual(["body"]);
    expect(remoteContentScannedKeys("gitlab_issue_update")).toEqual(["description"]);
    const gh = CLEAN.github_issue_update;
    expect(onBothDoors("github_issue_update", { ...gh, title: "cc @acme/everyone" })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(onBothDoors("github_issue_update", { ...gh, body: "ping @acme/core" })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(onBothDoors("github_issue_update", { ...gh, body: "![x](https://h/p.png)" })).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    expect(onBothDoors("github_issue_update", { ...gh, body: "see https://h/p" })).toBeUndefined();
    const gl = CLEAN.gitlab_issue_update;
    expect(onBothDoors("gitlab_issue_update", { ...gl, title: "@all look" })).toBe(
      BROADCAST_MENTION_REFUSAL,
    );
    expect(
      onBothDoors("gitlab_issue_update", { ...gl, description: "![x](https://h/p.png)" }),
    ).toBe(REMOTE_CONTENT_REFUSAL);
  });

  test("a GitLab quick action in the description is refused; a title starting with / is not", () => {
    expect(quickActionTextKeys("gitlab_issue_update")).toEqual(["description"]);
    const gl = CLEAN.gitlab_issue_update;
    expect(onBothDoors("gitlab_issue_update", { ...gl, description: "Done.\n/close" })).toBe(
      GITLAB_QUICK_ACTION_REFUSAL,
    );
    expect(onBothDoors("gitlab_issue_update", { ...gl, description: "```\n/close\n```" })).toBe(
      GITLAB_QUICK_ACTION_REFUSAL,
    );
    expect(onBothDoors("gitlab_issue_update", { ...gl, title: "/api is down" })).toBeUndefined();
    expect(onBothDoors("gitlab_issue_update", { ...gl, description: "and/or" })).toBeUndefined();
  });

  test("a null optional of an edit is refused, naming the key; jira accountId null is allowed", () => {
    expect(nullRefusedOptionalKeys("github_issue_update")).toEqual(["title", "body"]);
    expect(nullRefusedOptionalKeys("gitlab_issue_update")).toEqual(["title", "description"]);
    for (const [id, key] of [
      ["github_issue_update", "title"],
      ["github_issue_update", "body"],
      ["gitlab_issue_update", "title"],
      ["gitlab_issue_update", "description"],
    ] as const) {
      expect(onBothDoors(id, { ...CLEAN[id], [key]: null }), `${id}.${key}`).toBe(
        nullOptionalFieldRefusal(key),
      );
    }
    expect(nullRefusedOptionalKeys("jira_issue_assign")).toEqual([]);
    expect(
      onBothDoors("jira_issue_assign", { issueKey: "NIM-7", accountId: null }),
    ).toBeUndefined();
  });

  test("the label, assignee, Jira and Linear rows carry no free text: nothing scanned (stated)", () => {
    for (const id of IDS.filter((x) => !x.endsWith("_update"))) {
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
      expect(quickActionTextKeys(id), id).toEqual([]);
      expect(nullRefusedOptionalKeys(id), id).toEqual([]);
    }
    // A removed scoped label removes only itself: the scoped-label rule (an add) does not apply.
    expect(scopedLabelKeys("gitlab_issue_labels_remove")).toEqual([]);
    expect(
      onBothDoors("gitlab_issue_labels_remove", {
        ...CLEAN.gitlab_issue_labels_remove,
        labels: ["p::1"],
      }),
    ).toBeUndefined();
  });
});
