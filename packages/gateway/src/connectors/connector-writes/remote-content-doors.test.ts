/**
 * B3r (plan Task 5) and B3w (plan Task 3): the remote-content refusal on both doors, through the
 * shared check. Every
 * structural bypass form of both adversarial reviews (`testing/remote-content-fixtures.ts`), in the
 * scanned field of a real row, is refused identically by `messagingDestinationRefusal`, the model
 * door's `modelWriteRefusal` and the act door's `actDoorRefusal`; each allowed form passes all
 * three. Plus the row-level rules (which field, which format, OPTIONAL Drive content, the
 * contentType and Drive type/name cases), the order pin, fail-closed throws, the completeness
 * tripwire and a source pin on the call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { PROPOSABLE_WRITE_TOOLS } from "../proposable-actions.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import {
  REMOTE_CONTENT_ALLOWED_CASES,
  REMOTE_CONTENT_REFUSED_CASES,
} from "../testing/remote-content-fixtures.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  actDoorRefusal,
  BROADCAST_MENTION_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  driveMarkupFormats,
  GITLAB_QUICK_ACTION_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  remoteContentScannedRows,
  type TribalKbConfig,
} from "./model-write-refusals.ts";

/** ChatOps readable and binding nothing, so only the remote-content rule can refuse a Teams post. */
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const ACT = { chatops: NO_CHATOPS, kb: undefined, kbUnreadable: false } as const;

/** The same result through all three entry points (the rule is in the shared check). */
function onAllDoors(toolId: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const messaging = messagingDestinationRefusal(toolId, input, { chatops: NO_CHATOPS });
  expect(modelWriteRefusal(toolId, input, { chatops: NO_CHATOPS, kb: undefined })).toBe(messaging);
  expect(actDoorRefusal(toolId, input, ACT)).toBe(messaging);
  return messaging;
}

describe("B3r and B3w: every bypass form of the reviews is refused on both doors (real rows)", () => {
  test("the fixture table covers every scanned row, refused and allowed", () => {
    const rows = new Set(REMOTE_CONTENT_REFUSED_CASES.map((c) => c.toolId));
    const allowed = new Set(REMOTE_CONTENT_ALLOWED_CASES.map((c) => c.toolId));
    for (const id of remoteContentScannedRows()) {
      expect(rows.has(id), id).toBe(true);
      expect(allowed.has(id), id).toBe(true);
    }
  });

  test.each(REMOTE_CONTENT_REFUSED_CASES.map((c) => [c.label, c] as const))(
    "refused: %s",
    (_label, c) => {
      expect(onAllDoors(c.toolId, c.input)).toBe(REMOTE_CONTENT_REFUSAL);
    },
  );

  test.each(REMOTE_CONTENT_ALLOWED_CASES.map((c) => [c.label, c] as const))(
    "allowed: %s",
    (_label, c) => {
      expect(onAllDoors(c.toolId, c.input)).toBeUndefined();
    },
  );
});

describe("B3r: the row rules (plan R1, R10, R11 and the coordinator's rulings)", () => {
  const PIXEL = "<img src=//h>";

  test("the refusal text is fixed and echoes nothing", () => {
    expect(REMOTE_CONTENT_REFUSAL).toBe(
      "the model cannot write a message, email, comment, draft, page, note or file that loads remote content (an external image, embed, frame or stylesheet) when it is opened; use a plain link instead",
    );
  });

  test("a required scanned key absent or not a string is refused", () => {
    for (const [toolId, key] of [
      ["outlook_draft_create", "body"],
      ["confluence_page_append", "storageHtml"],
      ["notion_block_append", "childrenJson"],
      ["notion_page_update", "propertiesJson"],
      ["obsidian_append_to_daily_note", "content"],
    ] as const) {
      const base: Record<string, unknown> =
        toolId === "outlook_draft_create" ? { contentType: "html" } : {};
      expect(onAllDoors(toolId, base), toolId).toBe(REMOTE_CONTENT_REFUSAL);
      expect(onAllDoors(toolId, { ...base, [key]: 7 }), toolId).toBe(REMOTE_CONTENT_REFUSAL);
      expect(onAllDoors(toolId, { ...base, [key]: null }), toolId).toBe(REMOTE_CONTENT_REFUSAL);
    }
  });

  test('Outlook: contentType absent or exactly "text" is not scanned; any other present value is', () => {
    const draft = (over: Record<string, unknown>) => ({
      to: "a@x.com",
      subject: "S",
      body: PIXEL,
      ...over,
    });
    expect(onAllDoors("outlook_draft_create", draft({}))).toBeUndefined();
    expect(onAllDoors("outlook_draft_create", draft({ contentType: "text" }))).toBeUndefined();
    for (const contentType of ["html", "HTML", null, 1, "Text", " text"]) {
      expect(onAllDoors("outlook_draft_create", draft({ contentType })), String(contentType)).toBe(
        REMOTE_CONTENT_REFUSAL,
      );
    }
  });

  test("Drive: content is OPTIONAL; the type OR the name decides the format", () => {
    const file = (over: Record<string, unknown>) => ({ name: "x", ...over });
    expect(
      onAllDoors(
        "gdrive_file_create",
        file({ mimeType: "text/html; charset=utf-8", content: PIXEL }),
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
    expect(
      onAllDoors("gdrive_file_create", file({ mimeType: "text/plain", content: PIXEL })),
    ).toBeUndefined();
    expect(onAllDoors("gdrive_file_create", file({ mimeType: "text/html" }))).toBeUndefined();
    expect(
      onAllDoors("gdrive_file_create", file({ mimeType: "text/html", content: "" })),
    ).toBeUndefined();
    // A null content is the null-field text (that check runs after remote content).
    expect(onAllDoors("gdrive_file_create", file({ mimeType: "text/html", content: null }))).toBe(
      nullOptionalFieldRefusal("content"),
    );
    // A null type scans (fail closed); clean content then falls to the null-field text.
    expect(onAllDoors("gdrive_file_create", file({ mimeType: null, content: "plain" }))).toBe(
      nullOptionalFieldRefusal("mimeType"),
    );
    expect(onAllDoors("gdrive_file_create", file({ mimeType: null, content: PIXEL }))).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    // The name rule: `.svg` with no type scans; `.md` scans as Markdown.
    expect(onAllDoors("gdrive_file_create", { name: "logo.SVG", content: PIXEL })).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    expect(onAllDoors("gdrive_file_create", { name: "a.md", content: "![x](y)" })).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    expect(onAllDoors("gdrive_file_create", { name: "a.txt", content: "![x](y)" })).toBeUndefined();
    expect(driveMarkupFormats({ name: "a.md" })).toEqual(["obsidian-markdown"]);
    expect(driveMarkupFormats({ mimeType: "image/svg+xml", name: "a.md" })).toEqual([
      "drive-markup",
      "obsidian-markdown",
    ]);
    expect(driveMarkupFormats({})).toEqual([]);
    // Final review item 4: a markup type does not hide a Markdown name.
    expect(
      onAllDoors("gdrive_file_create", {
        mimeType: "text/html",
        name: "notes.md",
        content: "![](https://h/p.gif)",
      }),
    ).toBe(REMOTE_CONTENT_REFUSAL);
  });

  test("order (R10): remote content is reported before the KB-target text on the model door", () => {
    const kb: TribalKbConfig = { confluence: { spaceKey: "KB", parentPageId: "4242" } };
    const embed = {
      pageId: "4242",
      storageHtml: '<ac:image><ri:url ri:value="https://h/x.png"/></ac:image>',
    };
    expect(modelWriteRefusal("confluence_comment_add", embed, { chatops: undefined, kb })).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    expect(actDoorRefusal("confluence_comment_add", embed, { ...ACT, kb })).toBe(
      REMOTE_CONTENT_REFUSAL,
    );
    const clean = { pageId: "4242", storageHtml: "<p>x</p>" };
    expect(modelWriteRefusal("confluence_comment_add", clean, { chatops: undefined, kb })).toBe(
      KNOWLEDGE_BASE_REFUSAL,
    );
  });

  test("a throw inside the rule refuses on both doors (an enumerable getter that throws)", () => {
    for (const [toolId, key] of [
      ["confluence_page_append", "storageHtml"],
      ["gdrive_file_create", "mimeType"],
      ["outlook_draft_create", "contentType"],
    ] as const) {
      const input: Record<string, unknown> = { pageId: "1", name: "x" };
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          throw new Error("x");
        },
      });
      expect(actDoorRefusal(toolId, input, ACT), toolId).toBe(REMOTE_CONTENT_REFUSAL);
      expect(modelWriteRefusal(toolId, input, { chatops: NO_CHATOPS, kb: undefined }), toolId).toBe(
        REMOTE_CONTENT_REFUSAL,
      );
    }
  });
});

/** The B3w rows, with a clean input each (the scanned key is added per case). */
const B3W_ROWS: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
  ["outlook_mail_send", "body", { to: "a@x.com", subject: "S", contentType: "html" }],
  [
    "teams_message_post",
    "body",
    { teamId: "t", channelId: "19:other@thread.tacv2", contentType: "html" },
  ],
  ["teams_message_post_chat", "body", { chatId: "19:chat@thread.v2", contentType: "html" }],
  ["github_issue_comment_create", "body", { owner: "o", repo: "r", issueNumber: 1 }],
  ["github_issue_create", "body", { owner: "o", repo: "r", title: "T" }],
  ["gitlab_issue_note_create", "body", { projectPath: "g/r", issueIid: 7 }],
  ["gitlab_mr_note_create", "body", { projectPath: "g/r", mergeRequestIid: 9 }],
  ["gitlab_issue_create", "description", { projectPath: "g/r", title: "T" }],
  ["linear_comment_create", "body", { issueId: "i" }],
  ["linear_issue_create", "description", { teamId: "t", title: "T" }],
  ["linear_issue_update", "description", { issueId: "i" }],
];
const OPTIONAL_B3W = new Set([
  "github_issue_create",
  "gitlab_issue_create",
  "linear_issue_create",
  "linear_issue_update",
]);

describe("B3w: the row rules (plan W2-W4, W11, Review Focus 1 and 5)", () => {
  const PIXEL = "<img src=//h>";

  test("every B3w row refuses an image and allows a plain link", () => {
    for (const [toolId, key, rest] of B3W_ROWS) {
      const image =
        toolId.startsWith("outlook") || toolId.startsWith("teams") ? PIXEL : "![](https://h/p.gif)";
      expect(onAllDoors(toolId, { ...rest, [key]: image }), toolId).toBe(REMOTE_CONTENT_REFUSAL);
      expect(
        onAllDoors(toolId, { ...rest, [key]: "see [the doc](https://h)" }),
        toolId,
      ).toBeUndefined();
    }
  });

  test('W4: rows 10-12 scan unless contentType is absent or exactly "text"', () => {
    for (const [toolId, key, rest] of B3W_ROWS.slice(0, 3)) {
      const { contentType: _ct, ...base } = rest;
      expect(onAllDoors(toolId, { ...base, [key]: PIXEL }), toolId).toBeUndefined();
      expect(
        onAllDoors(toolId, { ...base, [key]: PIXEL, contentType: "text" }),
        toolId,
      ).toBeUndefined();
      for (const contentType of ["html", "HTML", null, 42, ""]) {
        expect(
          onAllDoors(toolId, { ...base, [key]: PIXEL, contentType }),
          `${toolId} ${String(contentType)}`,
        ).toBe(REMOTE_CONTENT_REFUSAL);
      }
    }
  });

  test("Review Focus 1: the Outlook draft and send give the same verdict on every Outlook fixture", () => {
    const drafts = [...REMOTE_CONTENT_REFUSED_CASES, ...REMOTE_CONTENT_ALLOWED_CASES].filter(
      (c) => c.toolId === "outlook_draft_create",
    );
    expect(drafts.length).toBeGreaterThan(50);
    for (const c of drafts) {
      expect(onAllDoors("outlook_mail_send", c.input), c.label).toBe(
        onAllDoors("outlook_draft_create", c.input),
      );
    }
  });

  test("Review Focus 5: an optional key unset, empty or null is not scanned; a non-string is refused", () => {
    for (const [toolId, key, rest] of B3W_ROWS) {
      if (!OPTIONAL_B3W.has(toolId)) {
        // A required body absent is refused (by the broadcast scan first on the Teams, GitHub and
        // GitLab rows, which read the same key earlier in the chain).
        expect(onAllDoors(toolId, rest), `${toolId} required`).toBeDefined();
        continue;
      }
      expect(onAllDoors(toolId, rest), toolId).toBeUndefined();
      expect(onAllDoors(toolId, { ...rest, [key]: "" }), toolId).toBeUndefined();
      expect(onAllDoors(toolId, { ...rest, [key]: null }), toolId).toBeUndefined();
      // A present non-string is refused: by the broadcast scan first on GitHub and GitLab, which
      // reads the same optional key earlier in the chain, and by this rule on Linear.
      const nonString = onAllDoors(toolId, { ...rest, [key]: 42 });
      if (toolId.startsWith("linear")) expect(nonString, toolId).toBe(REMOTE_CONTENT_REFUSAL);
      else expect(nonString, toolId).toBe(BROADCAST_MENTION_REFUSAL);
    }
  });

  test("a throwing enumerable getter on each B3w row's body: the rule refuses where it reads first", () => {
    // The broadcast (B1) and quick-action (B2) scans read the Teams, GitHub and GitLab bodies
    // earlier in the shared chain and do not catch; there the throw propagates out of
    // actDoorRefusal and the act door's verdict (capture-act.ts actionDestinationVerdict) refuses
    // it with its fixed text. MCP input is JSON, so a getter is only reachable in-process.
    const READ_EARLIER = new Set([
      "teams_message_post",
      "teams_message_post_chat",
      "github_issue_comment_create",
      "github_issue_create",
      "gitlab_issue_note_create",
      "gitlab_mr_note_create",
      "gitlab_issue_create",
    ]);
    for (const [toolId, key, rest] of B3W_ROWS) {
      const input: Record<string, unknown> = { ...rest };
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          throw new Error("x");
        },
      });
      if (READ_EARLIER.has(toolId)) {
        expect(() => actDoorRefusal(toolId, input, ACT), toolId).toThrow();
      } else {
        expect(actDoorRefusal(toolId, input, ACT), toolId).toBe(REMOTE_CONTENT_REFUSAL);
      }
    }
  });

  test("W11: combined cases report the earlier check", () => {
    expect(
      onAllDoors("gitlab_issue_note_create", {
        projectPath: "g/r",
        issueIid: 7,
        body: "/close\n![](https://h)",
      }),
    ).toBe(GITLAB_QUICK_ACTION_REFUSAL);
    expect(
      onAllDoors("github_issue_comment_create", {
        owner: "o",
        repo: "r",
        issueNumber: 1,
        body: "@org/team ![](https://h)",
      }),
    ).toBe(BROADCAST_MENTION_REFUSAL);
    const bound: ChatopsPolicy = {
      channels: new Map([
        ["19:abc@thread.tacv2", { namespace: "ns", unmapped: "refuse", notify: [] }],
      ]),
      ownership: new Map(),
    } as unknown as ChatopsPolicy;
    const teams = {
      teamId: "t",
      channelId: "19:abc@thread.tacv2",
      contentType: "html",
      body: PIXEL,
    };
    expect(messagingDestinationRefusal("teams_message_post", teams, { chatops: bound })).toBe(
      CHATOPS_CHANNEL_REFUSAL,
    );
    // A Linear update that sets assigneeId and carries an image: messaging runs first.
    expect(
      actDoorRefusal(
        "linear_issue_update",
        { issueId: "i", assigneeId: "u", description: "![](https://h)" },
        ACT,
      ),
    ).toBe(REMOTE_CONTENT_REFUSAL);
  });
});

// ---------------------------------------------------------------------------------------------
// Completeness tripwire (plan Task 5): a new body-carrying row cannot be offered or proposed
// without being scanned or named here with its reason.
// ---------------------------------------------------------------------------------------------

/** Offerable or proposable rows with a body/text/description/content field that are NOT scanned. */
const NOT_SCANNED_REMOTE: Readonly<Record<string, string>> = {
  slack_message_post:
    "connector sends `text` only, no blocks; mrkdwn has no inline image (pinned (j))",
  slack_message_post_dm:
    "connector sends `text` only, no blocks; mrkdwn has no inline image (pinned (j))",
  discord_message_post:
    "`content` only, no embeds (pinned (j)); an auto-embed is Discord's own fetch",
  jira_issue_create: "one plain ADF text node, pinned (j)",
  jira_issue_update: "one plain ADF text node, pinned (j)",
  jira_comment_add: "one plain ADF text node, pinned (j)",
  notion_comment_create: "plain rich text",
  gmail_draft_create: "sent as text/plain",
  apple_mail_draft_create: "sent as text/plain",
  outlook_calendar_create: "the connector always sends contentType Text (B4 R4)",
  apple_calendar_event_create: "iCalendar DESCRIPTION text (B4 R4)",
};

/** Untemplated proposable send rows (no preview fields to read): each sends plain text. */
const UNTEMPLATED_SENDS: Readonly<Record<string, string>> = {
  gmail_draft_send: "takes a draftId only; sends an existing draft (no model-written body)",
  gmail_message_send: "`rawMessage` writes Content-Type: text/plain (pinned (k))",
  fastmail_mail_send: "JMAP bodyStructure type text/plain (pinned (k))",
  imap_mail_send: "imapflow-adapter gives nodemailer `text: input.body` only (pinned (k))",
  protonmail_mail_send: "imapflow-adapter gives nodemailer `text: input.body` only (pinned (k))",
  apple_mail_send: "Content-Type: text/plain (pinned (k))",
};

/** The free-text keys of a proposable tool's installed 0.5.0 zod schema, found by registration. */
function schemaTextKeys(toolId: string): readonly string[] {
  const out = new Set<string>();
  for (const r of SCAN.registrations.filter((x) => x.id === toolId)) {
    const file = stripComments(SOURCES.find((src) => src.rel === r.file)?.text ?? "");
    let text = file.slice(r.span[0], r.span[1] + 1);
    // The schema named in the call (`const <name> = z...`), when it is defined in the same file.
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const at = file.indexOf(`const ${m[1] ?? ""} = z`);
      if (at !== -1) text += file.slice(at, file.indexOf("});", at) + 3);
    }
    for (const m of text.matchAll(
      /\b(body|text|description|content|message)\s*:\s*z\s*\.\s*string/g,
    )) {
      out.add(m[1] ?? "");
    }
  }
  return [...out];
}

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

const BODY_KEYS = new Set(["body", "text", "description", "content"]);
const MARKUP_KEYS = new Set(["storageHtml", "childrenJson", "propertiesJson"]);

describe("B3r and B3w completeness tripwire", () => {
  const proposable = new Set(Object.values(PROPOSABLE_WRITE_TOOLS));
  const doorRows = CONNECTOR_WRITE_ROWS.filter(
    (r) => isModelOfferableRow(r) || proposable.has(r.toolId),
  );

  test("the scanned rows are exactly the twenty, with exactly the field column", () => {
    expect([...remoteContentScannedRows()].sort((a, b) => a.localeCompare(b))).toEqual([
      "confluence_comment_add",
      "confluence_page_append",
      "confluence_page_create",
      "confluence_page_update",
      "gdrive_file_create",
      "github_issue_comment_create",
      "github_issue_create",
      "gitlab_issue_create",
      "gitlab_issue_note_create",
      "gitlab_mr_note_create",
      "linear_comment_create",
      "linear_issue_create",
      "linear_issue_update",
      "notion_block_append",
      "notion_page_update",
      "obsidian_append_to_daily_note",
      "outlook_draft_create",
      "outlook_mail_send",
      "teams_message_post",
      "teams_message_post_chat",
    ]);
    const fields = Object.fromEntries(
      remoteContentScannedRows().map((id) => [id, remoteContentScannedKeys(id)]),
    );
    expect(fields).toEqual({
      outlook_draft_create: ["body"],
      confluence_page_create: ["storageHtml"],
      confluence_page_update: ["storageHtml"],
      confluence_page_append: ["storageHtml"],
      confluence_comment_add: ["storageHtml"],
      notion_block_append: ["childrenJson"],
      notion_page_update: ["propertiesJson"],
      obsidian_append_to_daily_note: ["content"],
      gdrive_file_create: ["content"],
      outlook_mail_send: ["body"],
      teams_message_post: ["body"],
      teams_message_post_chat: ["body"],
      github_issue_comment_create: ["body"],
      github_issue_create: ["body"],
      gitlab_issue_note_create: ["body"],
      gitlab_mr_note_create: ["body"],
      gitlab_issue_create: ["description"],
      linear_comment_create: ["body"],
      linear_issue_create: ["description"],
      linear_issue_update: ["description"],
    });
    expect(remoteContentScannedKeys("gmail_draft_create")).toEqual([]);
  });

  test("every row with a markup field (by key or by an HTML / block JSON label) is scanned", () => {
    for (const r of doorRows) {
      for (const f of r.preview?.fields ?? []) {
        const markup = MARKUP_KEYS.has(f.key) || /HTML|block JSON/.test(f.label);
        if (markup)
          expect(remoteContentScannedKeys(r.toolId), `${r.toolId}.${f.key}`).toContain(f.key);
      }
    }
  });

  test("outlook_draft_create's template carries contentType (the format rule reads it)", () => {
    const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "outlook_draft_create");
    expect(r?.preview?.fields.map((f) => f.key)).toContain("contentType");
  });

  test("every other body-carrying door row is named, with its reason", () => {
    const unexplained: string[] = [];
    for (const r of doorRows) {
      if (r.preview === undefined) {
        // B3w review fix 3: an untemplated row is scanned OR a named plain-text send, never neither
        // and never both.
        const scannedRow = remoteContentScannedKeys(r.toolId).length > 0;
        const named = Object.hasOwn(UNTEMPLATED_SENDS, r.toolId);
        if (!scannedRow && !named) unexplained.push(`${r.toolId} (untemplated)`);
        if (scannedRow && named) unexplained.push(`${r.toolId} (untemplated, both)`);
        continue;
      }
      const hasBody = r.preview.fields.some((f) => BODY_KEYS.has(f.key) || MARKUP_KEYS.has(f.key));
      if (!hasBody) continue;
      const scanned = remoteContentScannedKeys(r.toolId).length > 0;
      if (!scanned && !Object.hasOwn(NOT_SCANNED_REMOTE, r.toolId)) unexplained.push(r.toolId);
      if (scanned && Object.hasOwn(NOT_SCANNED_REMOTE, r.toolId))
        unexplained.push(`${r.toolId} (both)`);
    }
    expect(unexplained).toEqual([]);
    // No stale entries: each named row still exists on a door.
    const ids = new Set(doorRows.map((r) => r.toolId));
    for (const id of [...Object.keys(NOT_SCANNED_REMOTE), ...Object.keys(UNTEMPLATED_SENDS)]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  test("every proposable tool whose 0.5.0 schema has a free-text key is classified", () => {
    const unexplained: string[] = [];
    let withKeys = 0;
    for (const toolId of new Set(Object.values(PROPOSABLE_WRITE_TOOLS))) {
      if (schemaTextKeys(toolId).length === 0) continue;
      withKeys++;
      const classified =
        remoteContentScannedKeys(toolId).length > 0 ||
        Object.hasOwn(NOT_SCANNED_REMOTE, toolId) ||
        Object.hasOwn(UNTEMPLATED_SENDS, toolId);
      if (!classified) unexplained.push(toolId);
    }
    expect(unexplained).toEqual([]);
    // The reader sees real schemas (a broken reader would see none and pass vacuously).
    expect(withKeys).toBeGreaterThan(15);
    expect(schemaTextKeys("outlook_mail_send")).toContain("body");
  });
});

// ---------------------------------------------------------------------------------------------
// Source pin (coordinator ruling on concern 1): the production call passes exactly two arguments,
// so the `{ tripwire: false }` test seam can never be reached from a door.
// ---------------------------------------------------------------------------------------------

/** Every `remoteContentIn(` call's argument count in comment-free source (top-level commas). */
function remoteContentInArgCounts(code: string): number[] {
  const out: number[] = [];
  for (
    let at = code.indexOf("remoteContentIn(");
    at !== -1;
    at = code.indexOf("remoteContentIn(", at + 1)
  ) {
    let depth = 0;
    let args = 1;
    let i = at + "remoteContentIn(".length;
    let empty = true;
    for (; i < code.length; i++) {
      const ch = code.charAt(i);
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) args++;
      if (ch.trim() !== "") empty = false;
    }
    // A trailing comma (`f(a, b,)`) adds no argument.
    const trailing = code.slice(at, i).trimEnd().endsWith(",");
    out.push(empty ? 0 : args - (trailing ? 1 : 0));
  }
  return out;
}

describe("source pin: the door calls remoteContentIn with exactly two arguments", () => {
  const src = stripComments(readFileSync(join(import.meta.dir, "model-write-refusals.ts"), "utf8"));

  test("model-write-refusals.ts calls it once, with two arguments", () => {
    expect(remoteContentInArgCounts(src)).toEqual([2]);
  });

  test("guard: the counter sees a third argument", () => {
    expect(remoteContentInArgCounts("remoteContentIn(format, text, { tripwire: false })")).toEqual([
      3,
    ]);
    expect(remoteContentInArgCounts("remoteContentIn(f(a, b), g[1, 2])")).toEqual([2]);
    expect(remoteContentInArgCounts("remoteContentIn(a, b,)")).toEqual([2]);
  });
});
