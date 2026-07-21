import { describe, expect, test } from "bun:test";

import {
  type FastmailEmailInput,
  fastmailExternalId,
  mapFastmailEmailToItem,
} from "../../../src/connectors/fastmail-email-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

function input(over: Partial<FastmailEmailInput> = {}): FastmailEmailInput {
  return {
    id: "M1234",
    messageId: "<abc@example.com>",
    subject: "Quarterly report",
    from: ["Ada Lovelace <ada@example.com>"],
    to: ["team@example.com"],
    cc: ["cc@example.com"],
    receivedAt: "2026-05-31T12:00:00.000Z",
    attachments: [{ name: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf" }],
    preview: "Here is the quarterly report summary.",
    ...over,
  };
}

describe("fastmailExternalId", () => {
  test("prefers the RFC message-id", () => {
    expect(fastmailExternalId({ messageId: "<m@x>", id: "M9" })).toBe("<m@x>");
  });

  test("falls back to the JMAP id when message-id is absent", () => {
    expect(fastmailExternalId({ messageId: null, id: "M9" })).toBe("M9");
    expect(fastmailExternalId({ messageId: "   ", id: "M9" })).toBe("M9");
  });
});

describe("mapFastmailEmailToItem", () => {
  test("maps headers, preview, and attachment metadata into a fastmail:email item", () => {
    const row = mapFastmailEmailToItem(input(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("fastmail");
    expect(row.type).toBe("email");
    expect(row.externalId).toBe("<abc@example.com>");
    expect(row.title).toBe("Quarterly report");
    expect(row.bodyPreview).toBe("Here is the quarterly report summary.");
    expect(row.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00.000Z"));
    expect(row.url).toBeNull();
    expect(row.metadata.jmapId).toBe("M1234");
    expect(row.metadata.attachmentCount).toBe(1);
    expect(row.metadata.attachments).toEqual([
      { filename: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf" },
    ]);
  });

  test("returns null when neither a JMAP id nor a message-id is present", () => {
    expect(
      mapFastmailEmailToItem(input({ id: "", messageId: null }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
    expect(
      mapFastmailEmailToItem(input({ id: "  ", messageId: "  " }), { syncedAt: SYNCED_AT }),
    ).toBeNull();
  });

  test("falls back to the JMAP id when message-id is absent", () => {
    const row = mapFastmailEmailToItem(input({ messageId: null }), { syncedAt: SYNCED_AT });
    expect(row?.externalId).toBe("M1234");
  });

  test("uses '(no subject)' for an empty subject", () => {
    const row = mapFastmailEmailToItem(input({ subject: "   " }), { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("(no subject)");
  });

  test("falls back to syncedAt when receivedAt is unparseable / null", () => {
    expect(
      mapFastmailEmailToItem(input({ receivedAt: "nope" }), { syncedAt: SYNCED_AT })?.modifiedAt,
    ).toBe(SYNCED_AT);
    expect(
      mapFastmailEmailToItem(input({ receivedAt: null }), { syncedAt: SYNCED_AT })?.modifiedAt,
    ).toBe(SYNCED_AT);
  });

  test("caps an over-long title and preview", () => {
    const row = mapFastmailEmailToItem(
      input({ subject: "S".repeat(400), preview: "P".repeat(5000) }),
      { syncedAt: SYNCED_AT },
    );
    expect(row?.title.length ?? 0).toBeLessThanOrEqual(257);
    expect(row?.bodyPreview.length ?? 0).toBeLessThanOrEqual(2001);
  });

  test("tolerates a missing cc field", () => {
    const row = mapFastmailEmailToItem(input({ cc: undefined }), { syncedAt: SYNCED_AT });
    expect(row?.metadata.cc).toEqual([]);
  });

  test("NEVER carries an attachment content/body field — metadata only", () => {
    const row = mapFastmailEmailToItem(
      input({
        attachments: [{ name: "x.bin", sizeBytes: 9, mimeType: "application/octet-stream" }],
      }),
      { syncedAt: SYNCED_AT },
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("blobId");
    const att = (row?.metadata.attachments as Array<Record<string, unknown>> | undefined)?.[0];
    expect(att).toBeDefined();
    expect(Object.keys(att ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      "filename",
      "mimeType",
      "sizeBytes",
    ]);
  });
});
