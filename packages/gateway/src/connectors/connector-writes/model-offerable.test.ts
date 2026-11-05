import { describe, expect, test } from "bun:test";
import { offerableWritesEnabledBy, writesEnabledBy } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import type { BeforeStateReader, ConnectorWriteRow } from "./types.ts";

const template = { target: "t", summary: "s", fields: [] };
const reader: BeforeStateReader = {
  tool: "x_get",
  argKeys: ["id"],
  args: (input) => ({ id: input["id"] }),
  select: () => [],
};
const row = (over: Partial<ConnectorWriteRow>): ConnectorWriteRow => ({
  toolId: "x_y",
  actionType: "x.y",
  transport: "write",
  wave: 2,
  ...over,
});

describe("isModelOfferableRow (M1)", () => {
  test("needs a preview template", () => {
    expect(isModelOfferableRow(row({ wave: 2 }))).toBe(false);
    expect(isModelOfferableRow(row({ wave: 2, preview: template }))).toBe(true);
    expect(isModelOfferableRow(row({ wave: 3, preview: template }))).toBe(true);
  });
  test("wave 4 needs a before reader as well", () => {
    expect(isModelOfferableRow(row({ wave: 4, preview: template }))).toBe(false);
    expect(isModelOfferableRow(row({ wave: 4, preview: template, before: reader }))).toBe(true);
    expect(isModelOfferableRow(row({ wave: 4, before: reader }))).toBe(false);
  });
  test("exactly the 37 B1-B4a rows (posts, comments, issue writes, drafts, pages, calendar events, Drive files) are offerable", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        "apple_calendar_event_create",
        "apple_mail_draft_create",
        "confluence_comment_add",
        "confluence_page_append",
        "confluence_page_create",
        "confluence_page_update",
        "discord_message_post",
        "gdrive_file_create",
        "github_issue_assignees_add",
        "github_issue_comment_create",
        "github_issue_create",
        "github_issue_labels_add",
        "github_issue_state_set",
        "gitlab_issue_assignees_add",
        "gitlab_issue_create",
        "gitlab_issue_labels_add",
        "gitlab_issue_note_create",
        "gitlab_issue_state_set",
        "gitlab_mr_note_create",
        "gmail_draft_create",
        "jira_comment_add",
        "jira_issue_create",
        "jira_issue_transition",
        "jira_issue_update",
        "linear_comment_create",
        "linear_issue_create",
        "linear_issue_update",
        "notion_block_append",
        "notion_comment_create",
        "notion_page_create",
        "notion_page_update",
        "outlook_calendar_create",
        "outlook_draft_create",
        "slack_message_post",
        "slack_message_post_dm",
        "teams_message_post",
        "teams_message_post_chat",
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)).toHaveLength(37);
    // Wave 4 still needs a before reader: argocd's templated wave-4 rows stay out.
    expect(offerableWritesEnabledBy("argocd", 4)).toEqual([]);
    expect(writesEnabledBy("argocd", 4)).toHaveLength(2);
    expect(offerableWritesEnabledBy("slack", 2)).toHaveLength(2);
    expect(offerableWritesEnabledBy("github", 2)).toHaveLength(5);
    expect(offerableWritesEnabledBy("gitlab", 2)).toHaveLength(6);
    expect(offerableWritesEnabledBy("jira", 2)).toHaveLength(4);
    expect(offerableWritesEnabledBy("linear", 2)).toHaveLength(3);
    expect(offerableWritesEnabledBy("notion", 2)).toHaveLength(4);
    expect(offerableWritesEnabledBy("confluence", 2)).toHaveLength(4);
    expect(offerableWritesEnabledBy("gmail", 2)).toHaveLength(1);
    expect(offerableWritesEnabledBy("outlook", 2)).toHaveLength(2);
    expect(offerableWritesEnabledBy("apple", 2)).toHaveLength(2);
    expect(offerableWritesEnabledBy("google_drive", 2)).toHaveLength(1);
    expect(offerableWritesEnabledBy("obsidian", 2)).toEqual([]);
  });
});
