/**
 * B3r (plan Task 5): the remote-content refusal on both doors, through the shared check. Every
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
import { PROPOSABLE_WRITE_TOOLS } from "../proposable-actions.ts";
import {
  REMOTE_CONTENT_ALLOWED_CASES,
  REMOTE_CONTENT_REFUSED_CASES,
} from "../testing/remote-content-fixtures.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  actDoorRefusal,
  driveMarkupFormat,
  KNOWLEDGE_BASE_REFUSAL,
  messagingDestinationRefusal,
  modelWriteRefusal,
  nullOptionalFieldRefusal,
  REMOTE_CONTENT_REFUSAL,
  remoteContentScannedKeys,
  remoteContentScannedRows,
  type TribalKbConfig,
} from "./model-write-refusals.ts";

const ACT = { chatops: undefined, kb: undefined, kbUnreadable: false } as const;

/** The same result through all three entry points (the rule is in the shared check). */
function onAllDoors(toolId: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const messaging = messagingDestinationRefusal(toolId, input, { chatops: undefined });
  expect(modelWriteRefusal(toolId, input, { chatops: undefined, kb: undefined })).toBe(messaging);
  expect(actDoorRefusal(toolId, input, ACT)).toBe(messaging);
  return messaging;
}

describe("B3r: every bypass form of both reviews is refused on both doors (real rows)", () => {
  test("the fixture table covers all nine scanned rows, refused and allowed", () => {
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
      "the model cannot write a draft, page, note or file that loads remote content (an external image, embed, frame or stylesheet) when it is opened; use a plain link instead",
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
    expect(driveMarkupFormat({ name: "a.md" })).toBe("obsidian-markdown");
    expect(driveMarkupFormat({ mimeType: "image/svg+xml", name: "a.md" })).toBe("drive-markup");
    expect(driveMarkupFormat({})).toBeUndefined();
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
      expect(modelWriteRefusal(toolId, input, { chatops: undefined, kb: undefined }), toolId).toBe(
        REMOTE_CONTENT_REFUSAL,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Completeness tripwire (plan Task 5): a new body-carrying row cannot be offered or proposed
// without being scanned or named here with its reason.
// ---------------------------------------------------------------------------------------------

/** Offerable or proposable rows with a body/text/description/content field that are NOT scanned. */
const NOT_SCANNED_REMOTE: Readonly<Record<string, string>> = {
  slack_message_post: "B1 message: mrkdwn has no inline image (B3w scope excludes Slack)",
  slack_message_post_dm: "B1 message: mrkdwn has no inline image",
  teams_message_post: "B1 message: Teams HTML is the follow-up B3w (OR-B3r-3)",
  teams_message_post_chat: "B1 message: Teams HTML is the follow-up B3w (OR-B3r-3)",
  discord_message_post: "B1 message: plain content, no inline image",
  jira_issue_create: "B2 issue: one plain ADF text node",
  jira_issue_update: "B2 issue: one plain ADF text node",
  jira_comment_add: "B1 comment: one plain ADF text node",
  linear_issue_create: "B2 issue: Linear Markdown is outside B3r (re-checked in B3w)",
  linear_issue_update: "B2 issue: Linear Markdown is outside B3r (re-checked in B3w)",
  linear_comment_create: "B1 comment: Linear Markdown is outside B3r (re-checked in B3w)",
  github_issue_create: "B2 issue: GitHub Markdown images are the follow-up B3w (OR-B3r-3)",
  github_issue_comment_create: "B1 comment: GitHub Markdown images are B3w (OR-B3r-3)",
  gitlab_issue_create: "B2 issue: GitLab Markdown images are B3w (OR-B3r-3)",
  gitlab_issue_note_create: "B1 note: GitLab Markdown images are B3w (OR-B3r-3)",
  gitlab_mr_note_create: "B1 note: GitLab Markdown images are B3w (OR-B3r-3)",
  notion_comment_create: "plain rich text",
  gmail_draft_create: "sent as text/plain",
  apple_mail_draft_create: "sent as text/plain",
  outlook_calendar_create: "the connector always sends contentType Text (B4 R4)",
  apple_calendar_event_create: "iCalendar DESCRIPTION text (B4 R4)",
};

/** Untemplated proposable send rows (no preview fields to read): plain text, or B3w. */
const UNTEMPLATED_SENDS: Readonly<Record<string, string>> = {
  gmail_draft_send: "sends an existing Gmail draft (text/plain)",
  gmail_message_send: "text/plain",
  outlook_mail_send: "the Outlook HTML send is the first step of B3w (OR-B3r-3)",
  fastmail_mail_send: "text/plain",
  imap_mail_send: "text/plain",
  protonmail_mail_send: "text/plain",
  apple_mail_send: "text/plain",
};

const BODY_KEYS = new Set(["body", "text", "description", "content"]);
const MARKUP_KEYS = new Set(["storageHtml", "childrenJson", "propertiesJson"]);

describe("B3r completeness tripwire", () => {
  const proposable = new Set(Object.values(PROPOSABLE_WRITE_TOOLS));
  const doorRows = CONNECTOR_WRITE_ROWS.filter(
    (r) => isModelOfferableRow(r) || proposable.has(r.toolId),
  );

  test("the scanned rows are exactly the nine, with exactly the field column", () => {
    expect([...remoteContentScannedRows()].sort((a, b) => a.localeCompare(b))).toEqual([
      "confluence_comment_add",
      "confluence_page_append",
      "confluence_page_create",
      "confluence_page_update",
      "gdrive_file_create",
      "notion_block_append",
      "notion_page_update",
      "obsidian_append_to_daily_note",
      "outlook_draft_create",
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
        if (!Object.hasOwn(UNTEMPLATED_SENDS, r.toolId))
          unexplained.push(`${r.toolId} (untemplated)`);
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
