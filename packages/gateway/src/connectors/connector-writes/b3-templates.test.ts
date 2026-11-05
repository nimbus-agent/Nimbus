// Phase 9.7 B3: the typed previews of the nine draft and page writes (plan R2). Each row's template
// keys are exactly its tool's input-schema keys in `@nimbus-dev/connectors` 0.4.0
// (`connectors/<c>/src/tools.ts`; the IMAP drafts use `shared/imap-tool-kit.ts` `sendArgs`), so the
// § 13 drift check offers it and, for well-formed input, `Other fields` is empty.
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

const B3_ROWS = [
  "gmail_draft_create",
  "apple_mail_draft_create",
  "outlook_draft_create",
  "notion_page_create",
  "notion_page_update",
  "notion_block_append",
  "confluence_page_create",
  "confluence_page_update",
  "confluence_page_append",
] as const;
type B3Row = (typeof B3_ROWS)[number];

/** The four wave-2 rows left for B4 (calendar, Drive, Obsidian; spec 14). */
const B4_ROWS = [
  "apple_calendar_event_create",
  "gdrive_file_create",
  "obsidian_append_to_daily_note",
  "outlook_calendar_create",
];

/** The 0.4.0 input-schema keys of each row, spelled out from the connector source (sorted). */
const SCHEMA_KEYS: Readonly<Record<B3Row, readonly string[]>> = {
  gmail_draft_create: ["bcc", "body", "cc", "subject", "to"],
  apple_mail_draft_create: ["bcc", "body", "cc", "subject", "to"],
  outlook_draft_create: ["bcc", "body", "cc", "contentType", "subject", "to"],
  notion_page_create: ["parentPageId", "title", "titlePropertyName"],
  notion_page_update: ["pageId", "propertiesJson"],
  notion_block_append: ["childrenJson", "parentBlockId"],
  confluence_page_create: ["parentPageId", "spaceKey", "storageHtml", "title"],
  confluence_page_update: ["pageId", "storageHtml", "title", "versionNumber"],
  confluence_page_append: ["pageId", "storageHtml"],
};

const DRAFT = {
  to: "alice@example.com",
  cc: "bob@example.com",
  bcc: "carol@example.com",
  subject: "Notes",
  body: "Hi",
};
const NOTION_PAGE = "0123abcd0123abcd0123abcd0123abcd";

/** Well-formed input naming every schema key. */
const CLEAN: Readonly<Record<B3Row, Record<string, unknown>>> = {
  gmail_draft_create: { ...DRAFT },
  apple_mail_draft_create: { ...DRAFT },
  outlook_draft_create: { ...DRAFT, contentType: "html" },
  notion_page_create: { parentPageId: NOTION_PAGE, title: "Runbook", titlePropertyName: "Name" },
  notion_page_update: {
    pageId: NOTION_PAGE,
    propertiesJson: '{"Status":{"select":{"name":"Done"}}}',
  },
  notion_block_append: {
    parentBlockId: NOTION_PAGE,
    childrenJson: '[{"type":"paragraph","paragraph":{"rich_text":[]}}]',
  },
  confluence_page_create: {
    spaceKey: "ENG",
    title: "Runbook",
    storageHtml: "<p>x</p>",
    parentPageId: "55",
  },
  confluence_page_update: {
    pageId: "123",
    versionNumber: 7,
    title: "Runbook v2",
    storageHtml: "<p>y</p>",
  },
  confluence_page_append: { pageId: "123", storageHtml: "<p>z</p>" },
};

const DRAFT_LINES = [
  '  To: "alice@example.com"',
  '  Cc: "bob@example.com"',
  '  Bcc (hidden from the other recipients): "carol@example.com"',
  '  Subject: "Notes"',
];

const GOLDEN: Readonly<Record<B3Row, readonly string[]>> = {
  gmail_draft_create: [
    "Service: gmail",
    "Credential: personal",
    "Target:  alice@example.com",
    "Save a Gmail draft addressed to alice@example.com; nothing is sent",
    "",
    ...DRAFT_LINES,
    '  Body (plain text): "Hi"',
  ],
  apple_mail_draft_create: [
    "Service: apple",
    "Credential: personal",
    "Target:  alice@example.com",
    "Save an iCloud Mail draft addressed to alice@example.com; nothing is sent",
    "",
    ...DRAFT_LINES,
    '  Body (plain text): "Hi"',
  ],
  outlook_draft_create: [
    "Service: outlook",
    "Credential: personal",
    "Target:  alice@example.com",
    "Save an Outlook draft addressed to alice@example.com; nothing is sent",
    "",
    ...DRAFT_LINES,
    '  Body (shown as text, never rendered): "Hi"',
    '  Format: "html"',
  ],
  notion_page_create: [
    "Service: notion",
    "Credential: personal",
    `Target:  ${NOTION_PAGE}`,
    `Create a Notion page under page ${NOTION_PAGE}`,
    "",
    '  Title: "Runbook"',
    '  Title property: "Name"',
  ],
  notion_page_update: [
    "Service: notion",
    "Credential: personal",
    `Target:  ${NOTION_PAGE}`,
    `Update properties of Notion page ${NOTION_PAGE}`,
    "",
    '  Properties to set (Notion property JSON, sent as is; each named property is replaced): "{\\"Status\\":{\\"select\\":{\\"name\\":\\"Done\\"}}}"',
  ],
  notion_block_append: [
    "Service: notion",
    "Credential: personal",
    `Target:  ${NOTION_PAGE}`,
    `Append blocks to the end of Notion page or block ${NOTION_PAGE}`,
    "",
    '  Blocks to append (Notion block JSON, sent as is): "[{\\"type\\":\\"paragraph\\",\\"paragraph\\":{\\"rich_text\\":[]}}]"',
  ],
  confluence_page_create: [
    "Service: confluence",
    "Credential: personal",
    "Target:  ENG",
    "Create a Confluence page in space ENG",
    "",
    '  Title: "Runbook"',
    '  Parent page: "55"',
    '  Body (Confluence storage HTML, sent as is): "<p>x</p>"',
  ],
  confluence_page_update: [
    "Service: confluence",
    "Credential: personal",
    "Target:  123",
    "Replace the title and the whole body of Confluence page 123",
    "",
    "  Expected current version (the write saves the next one): 7",
    '  New title: "Runbook v2"',
    '  New body (Confluence storage HTML, sent as is; replaces everything on the page): "<p>y</p>"',
  ],
  confluence_page_append: [
    "Service: confluence",
    "Credential: personal",
    "Target:  123",
    "Append to the end of Confluence page 123, keeping everything already on it",
    "",
    '  Appended content (Confluence storage HTML, sent as is): "<p>z</p>"',
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(toolId: B3Row, input: Record<string, unknown>): ConnectorWritePreview {
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

describe("B3 typed previews (plan R2)", () => {
  test("the B3 rows are exactly the drafts and page writes: mesh, wave 2, templated, offerable", () => {
    expect(B3_ROWS).toHaveLength(9);
    for (const id of B3_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(2);
      expect(r.preview, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
    // The wave-2 rows still without a template are then exactly the four B4 ones.
    expect(
      CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 2 && r.preview === undefined)
        .map((r) => r.toolId)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(B4_ROWS);
  });

  for (const id of B3_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("unset optional fields show their real default", () => {
    const gmail = previewOf("gmail_draft_create", { to: "a@x.com", subject: "S", body: "B" });
    expect(fieldValue(gmail, "Cc")).toBe("(not set: none)");
    expect(fieldValue(gmail, "Bcc (hidden from the other recipients)")).toBe("(not set: none)");

    const outlook = previewOf("outlook_draft_create", { to: "a@x.com", subject: "S", body: "B" });
    expect(fieldValue(outlook, "Format")).toBe("text");

    const notion = previewOf("notion_page_create", { parentPageId: NOTION_PAGE, title: "T" });
    expect(fieldValue(notion, "Title property")).toBe("title");

    const confluence = previewOf("confluence_page_create", {
      spaceKey: "ENG",
      title: "T",
      storageHtml: "<p>x</p>",
    });
    expect(fieldValue(confluence, "Parent page")).toBe("(not set: no parent page is sent)");
  });

  test("recipients are named: one To, one Cc and one Bcc line, each verbatim", () => {
    const p = previewOf("outlook_draft_create", {
      to: "a@x.com, b@y.com",
      cc: "c@z.com",
      bcc: "d@w.com",
      subject: "S",
      body: "B",
    });
    const lines = renderConnectorWritePreviewLines(p);
    expect(lines.filter((l) => l.startsWith("  To: "))).toEqual(['  To: "a@x.com, b@y.com"']);
    expect(lines.filter((l) => l.startsWith("  Cc: "))).toEqual(['  Cc: "c@z.com"']);
    expect(lines.filter((l) => l.startsWith("  Bcc (hidden from the other recipients): "))).toEqual(
      ['  Bcc (hidden from the other recipients): "d@w.com"'],
    );
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const id of B3_ROWS) {
      for (const f of rowOf(id).preview?.fields ?? [])
        expect(f.kind, `${id}.${f.key}`).toBe("text");
    }
  });

  test("the drift keys equal the 0.4.0 schema keys", () => {
    for (const id of B3_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("email.draft.create keeps today's raw prompt (it is no row's action type)", () => {
    const p = buildConnectorWritePreviewFrom(
      {
        type: "email.draft.create",
        origin: "model",
        payload: { mcpToolId: "apple_mail_draft_create", input: { ...DRAFT } },
      },
      CONNECTOR_WRITE_ROWS,
      () => "personal",
    );
    expect(p).toBeUndefined();
  });
});
