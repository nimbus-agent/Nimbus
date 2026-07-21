import { describe, expect, test } from "bun:test";

import {
  type ImapMessageInput,
  imapExternalId,
  mapImapMessageToItem,
} from "../../../src/connectors/imap-email-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

function input(over: Partial<ImapMessageInput> = {}): ImapMessageInput {
  return {
    uid: 42,
    mailbox: "INBOX",
    uidValidity: "12345",
    messageId: "<abc@example.com>",
    subject: "Quarterly report",
    date: "2026-05-31T12:00:00.000Z",
    from: ["Ada Lovelace <ada@example.com>"],
    to: ["team@example.com"],
    cc: ["cc@example.com"],
    attachments: [{ filename: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf" }],
    preview: "Here is the quarterly report summary.",
    ...over,
  };
}

describe("imapExternalId", () => {
  test("prefers the RFC message-id when present", () => {
    expect(imapExternalId({ messageId: "<m@x>", mailbox: "INBOX", uidValidity: "9", uid: 3 })).toBe(
      "<m@x>",
    );
  });

  test("falls back to mailbox:uidvalidity:uid when message-id is absent", () => {
    expect(imapExternalId({ messageId: null, mailbox: "Archive", uidValidity: "9", uid: 3 })).toBe(
      "Archive:9:3",
    );
  });

  test("uses '0' for uidvalidity when null", () => {
    expect(imapExternalId({ messageId: "  ", mailbox: "INBOX", uidValidity: null, uid: 7 })).toBe(
      "INBOX:0:7",
    );
  });
});

describe("mapImapMessageToItem", () => {
  test("maps headers, preview, and attachment metadata into an imap:email item", () => {
    const row = mapImapMessageToItem(input(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("imap");
    expect(row.type).toBe("email");
    expect(row.externalId).toBe("<abc@example.com>");
    expect(row.title).toBe("Quarterly report");
    expect(row.bodyPreview).toBe("Here is the quarterly report summary.");
    expect(row.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00.000Z"));
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(row.syncedAt).toBe(SYNCED_AT);

    const meta = row.metadata;
    expect(meta.mailbox).toBe("INBOX");
    expect(meta.from).toEqual(["Ada Lovelace <ada@example.com>"]);
    expect(meta.to).toEqual(["team@example.com"]);
    expect(meta.cc).toEqual(["cc@example.com"]);
    expect(meta.attachmentCount).toBe(1);
    expect(meta.attachments).toEqual([
      { filename: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf" },
    ]);
  });

  test("returns null when neither a message-id nor a valid uid is present", () => {
    expect(
      mapImapMessageToItem(input({ messageId: null, uid: 0 }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(
      mapImapMessageToItem(input({ messageId: "   ", uid: -1 }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
  });

  test("falls back to the synthesized external id when only a uid is present", () => {
    const row = mapImapMessageToItem(input({ messageId: null }), { syncedAt: SYNCED_AT });
    expect(row?.externalId).toBe("INBOX:12345:42");
  });

  test("uses '(no subject)' for an empty subject", () => {
    const row = mapImapMessageToItem(input({ subject: "   " }), { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("(no subject)");
  });

  test("falls back to syncedAt when the date is unparseable", () => {
    const row = mapImapMessageToItem(input({ date: "not-a-date" }), { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  test("accepts an epoch-millis numeric date", () => {
    const row = mapImapMessageToItem(input({ date: 1_700_000_000_000 }), { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(1_700_000_000_000);
  });

  test("caps an over-long title and preview", () => {
    const row = mapImapMessageToItem(
      input({ subject: "S".repeat(400), preview: "P".repeat(5000) }),
      { syncedAt: SYNCED_AT },
    );
    expect(row?.title.length ?? 0).toBeLessThanOrEqual(257);
    expect(row?.bodyPreview.length ?? 0).toBeLessThanOrEqual(2001);
  });

  test("tolerates a missing cc field", () => {
    const row = mapImapMessageToItem(input({ cc: undefined }), { syncedAt: SYNCED_AT });
    expect(row?.metadata.cc).toEqual([]);
  });

  test("NEVER carries an attachment content/body field — metadata only", () => {
    const row = mapImapMessageToItem(
      input({
        attachments: [
          { filename: "secret.bin", sizeBytes: 9, mimeType: "application/octet-stream" },
        ],
      }),
      { syncedAt: SYNCED_AT },
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain("base64");
    // The attachment metadata fields ARE present.
    const att = (row?.metadata.attachments as Array<Record<string, unknown>> | undefined)?.[0];
    expect(att).toBeDefined();
    expect(Object.keys(att ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "filename",
      "mimeType",
      "sizeBytes",
    ]);
  });
});
