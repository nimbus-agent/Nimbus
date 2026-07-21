import { describe, expect, test } from "bun:test";

import type { ImapMessageInput } from "../../../src/connectors/imap-email-mapping.ts";
import { mapProtonmailEmailToItem } from "../../../src/connectors/protonmail-email-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

function input(over: Partial<ImapMessageInput> = {}): ImapMessageInput {
  return {
    uid: 42,
    mailbox: "INBOX",
    uidValidity: "12345",
    messageId: "<abc@proton.me>",
    subject: "Encrypted note",
    date: "2026-05-31T12:00:00.000Z",
    from: ["Ada <ada@proton.me>"],
    to: ["team@proton.me"],
    cc: [],
    attachments: [{ filename: "doc.pdf", sizeBytes: 2048, mimeType: "application/pdf" }],
    preview: "decrypted body preview",
    ...over,
  };
}

describe("mapProtonmailEmailToItem", () => {
  test("maps to a protonmail:email item with headers + preview + attachment metadata", () => {
    const row = mapProtonmailEmailToItem(input(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("protonmail");
    expect(row.type).toBe("email");
    expect(row.externalId).toBe("<abc@proton.me>");
    expect(row.title).toBe("Encrypted note");
    expect(row.bodyPreview).toBe("decrypted body preview");
    expect(row.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00.000Z"));
    expect(row.metadata.attachmentCount).toBe(1);
    expect(row.metadata.attachments).toEqual([
      { filename: "doc.pdf", sizeBytes: 2048, mimeType: "application/pdf" },
    ]);
  });

  test("falls back to mailbox:uidvalidity:uid when no message-id", () => {
    const row = mapProtonmailEmailToItem(input({ messageId: null }), { syncedAt: SYNCED_AT });
    expect(row?.externalId).toBe("INBOX:12345:42");
  });

  test("returns null when neither message-id nor a valid uid is present", () => {
    expect(
      mapProtonmailEmailToItem(input({ messageId: null, uid: 0 }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
  });

  test("uses '(no subject)' and falls back to syncedAt for a bad date", () => {
    const row = mapProtonmailEmailToItem(input({ subject: "  ", date: "nope" }), {
      syncedAt: SYNCED_AT,
    });
    expect(row?.title).toBe("(no subject)");
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  test("NEVER carries attachment content — metadata only", () => {
    const row = mapProtonmailEmailToItem(
      input({
        attachments: [{ filename: "x.bin", sizeBytes: 9, mimeType: "application/octet-stream" }],
      }),
      { syncedAt: SYNCED_AT },
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain("base64");
    const att = (row?.metadata.attachments as Array<Record<string, unknown>> | undefined)?.[0];
    expect(att).toBeDefined();
    expect(Object.keys(att ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "filename",
      "mimeType",
      "sizeBytes",
    ]);
  });
});
