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
  test("exactly the 12 B1 message/comment rows are offerable", () => {
    expect(
      CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        "confluence_comment_add",
        "discord_message_post",
        "github_issue_comment_create",
        "gitlab_issue_note_create",
        "gitlab_mr_note_create",
        "jira_comment_add",
        "linear_comment_create",
        "notion_comment_create",
        "slack_message_post",
        "slack_message_post_dm",
        "teams_message_post",
        "teams_message_post_chat",
      ].sort((a, b) => a.localeCompare(b)),
    );
    // Wave 4 still needs a before reader: argocd's templated wave-4 rows stay out.
    expect(offerableWritesEnabledBy("argocd", 4)).toEqual([]);
    expect(writesEnabledBy("argocd", 4)).toHaveLength(2);
    expect(offerableWritesEnabledBy("slack", 2)).toHaveLength(2);
    expect(offerableWritesEnabledBy("github", 2)).toHaveLength(1);
    expect(offerableWritesEnabledBy("gitlab", 2)).toHaveLength(2);
  });
});
