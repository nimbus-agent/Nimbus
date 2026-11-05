// Phase 9.7 B1: the typed previews of the 12 message/comment posts (plan R2). Each row's template
// keys are exactly its tool's input-schema keys in `@nimbus-dev/connectors` 0.4.0
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
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const B1_ROWS = [
  "slack_message_post",
  "slack_message_post_dm",
  "teams_message_post",
  "teams_message_post_chat",
  "discord_message_post",
  "github_issue_comment_create",
  "gitlab_issue_note_create",
  "gitlab_mr_note_create",
  "jira_comment_add",
  "linear_comment_create",
  "notion_comment_create",
  "confluence_comment_add",
] as const;
type B1Row = (typeof B1_ROWS)[number];

/** The 0.4.0 input-schema keys of each row, spelled out from the connector source. */
const SCHEMA_KEYS: Readonly<Record<B1Row, readonly string[]>> = {
  slack_message_post: ["channel", "text", "thread_ts"],
  slack_message_post_dm: ["text", "user_ids"],
  teams_message_post: ["body", "channelId", "contentType", "teamId"],
  teams_message_post_chat: ["body", "chatId", "contentType"],
  discord_message_post: ["channelId", "content"],
  github_issue_comment_create: ["body", "issueNumber", "owner", "repo"],
  gitlab_issue_note_create: ["body", "issueIid", "projectPath"],
  gitlab_mr_note_create: ["body", "mergeRequestIid", "projectPath"],
  jira_comment_add: ["body", "issueKey"],
  linear_comment_create: ["body", "issueId"],
  notion_comment_create: ["pageId", "text"],
  confluence_comment_add: ["pageId", "storageHtml"],
};

/** Well-formed input naming every schema key. */
const CLEAN: Readonly<Record<B1Row, Record<string, unknown>>> = {
  slack_message_post: { channel: "C0123ABCD", text: "hi", thread_ts: "1700000000.000100" },
  slack_message_post_dm: { user_ids: "U0123ABCD,U0999ZZZZ", text: "hi" },
  teams_message_post: {
    teamId: "team-1",
    channelId: "19:abc@thread.tacv2",
    body: "<b>hi</b>",
    contentType: "html",
  },
  teams_message_post_chat: { chatId: "19:chat@thread.v2", body: "hi", contentType: "text" },
  discord_message_post: { channelId: "123456789012345678", content: "hi @everyone" },
  github_issue_comment_create: {
    owner: "nimbus-agent",
    repo: "Nimbus",
    issueNumber: 42,
    body: "LGTM",
  },
  gitlab_issue_note_create: { projectPath: "group/repo", issueIid: 7, body: "note" },
  gitlab_mr_note_create: { projectPath: "group/repo", mergeRequestIid: 9, body: "note" },
  jira_comment_add: { issueKey: "NIM-1", body: "comment" },
  linear_comment_create: { issueId: "8f2b0a1c-0000-4000-8000-000000000001", body: "comment" },
  notion_comment_create: { pageId: "1a2b3c4d5e6f7a8b9c0d112233445566", text: "comment" },
  confluence_comment_add: { pageId: "123", storageHtml: "<p>comment</p>" },
};

const GOLDEN: Readonly<Record<B1Row, readonly string[]>> = {
  slack_message_post: [
    "Service: slack",
    "Credential: personal",
    "Target:  C0123ABCD",
    "Post a Slack message to C0123ABCD",
    "",
    '  Message: "hi"',
    '  Thread: "1700000000.000100"',
  ],
  slack_message_post_dm: [
    "Service: slack",
    "Credential: personal",
    "Target:  U0123ABCD,U0999ZZZZ",
    "Send a Slack direct message to U0123ABCD,U0999ZZZZ",
    "",
    '  Message: "hi"',
  ],
  teams_message_post: [
    "Service: teams",
    "Credential: personal",
    "Target:  team-1/19:abc@thread.tacv2",
    "Post a Teams channel message to 19:abc@thread.tacv2",
    "",
    '  Message: "<b>hi</b>"',
    '  Format: "html"',
  ],
  teams_message_post_chat: [
    "Service: teams",
    "Credential: personal",
    "Target:  19:chat@thread.v2",
    "Post a Teams chat message to 19:chat@thread.v2",
    "",
    '  Message: "hi"',
    '  Format: "text"',
  ],
  discord_message_post: [
    "Service: discord",
    "Credential: personal",
    "Target:  123456789012345678",
    "Post to Discord channel 123456789012345678 as the bot, not as you; only user mentions notify",
    "",
    '  Message: "hi @everyone"',
  ],
  github_issue_comment_create: [
    "Service: github",
    "Credential: personal",
    "Target:  nimbus-agent/Nimbus#42",
    "Comment on GitHub issue or pull request nimbus-agent/Nimbus#42",
    "",
    '  Comment: "LGTM"',
  ],
  gitlab_issue_note_create: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo#7",
    "Comment on GitLab issue group/repo#7",
    "",
    '  Comment: "note"',
  ],
  gitlab_mr_note_create: [
    "Service: gitlab",
    "Credential: personal",
    "Target:  group/repo!9",
    "Comment on GitLab merge request group/repo!9",
    "",
    '  Comment: "note"',
  ],
  jira_comment_add: [
    "Service: jira",
    "Credential: personal",
    "Target:  NIM-1",
    "Comment on Jira issue NIM-1",
    "",
    '  Comment (sent as plain text): "comment"',
  ],
  linear_comment_create: [
    "Service: linear",
    "Credential: personal",
    "Target:  8f2b0a1c-0000-4000-8000-000000000001",
    "Comment on Linear issue 8f2b0a1c-0000-4000-8000-000000000001",
    "",
    '  Comment: "comment"',
  ],
  notion_comment_create: [
    "Service: notion",
    "Credential: personal",
    "Target:  1a2b3c4d5e6f7a8b9c0d112233445566",
    "Start a comment thread on Notion page 1a2b3c4d5e6f7a8b9c0d112233445566",
    "",
    '  Comment (Notion keeps only the first 2,000 characters): "comment"',
  ],
  confluence_comment_add: [
    "Service: confluence",
    "Credential: personal",
    "Target:  123",
    "Add a footer comment to Confluence page 123",
    "",
    '  Comment (Confluence storage HTML, sent as is): "<p>comment</p>"',
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(toolId: B1Row, input: Record<string, unknown>): ConnectorWritePreview {
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

describe("B1 typed previews (plan R2)", () => {
  test("the B1 rows are exactly the message/comment posts: mesh, wave 2, templated, offerable", () => {
    expect(B1_ROWS).toHaveLength(12);
    for (const id of B1_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(2);
      expect(r.preview, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
  });

  for (const id of B1_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("unset optional fields show their real default", () => {
    const slack = previewOf("slack_message_post", { channel: "C0123ABCD", text: "hi" });
    expect(slack.fields.find((f) => f.label === "Thread")?.value).toBe(
      "(not set: a new message, not a thread reply)",
    );
    for (const id of ["teams_message_post", "teams_message_post_chat"] as const) {
      const input = { ...CLEAN[id] };
      delete input["contentType"];
      expect(previewOf(id, input).fields.find((f) => f.label === "Format")?.value, id).toBe("text");
    }
  });

  test("a key the model adds beyond the schema is still shown under Other fields", () => {
    const p = previewOf("github_issue_comment_create", {
      ...CLEAN.github_issue_comment_create,
      mentions: ["@org/team"],
    });
    expect(p.otherFields).toEqual([{ key: "mentions", value: '["@org/team"]' }]);
  });

  test("no body field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of B1_ROWS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });

  test("the drift keys equal the 0.4.0 schema keys", () => {
    for (const id of B1_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...SCHEMA_KEYS[id]]);
    }
  });
});
