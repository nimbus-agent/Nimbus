import { describe, expect, test } from "bun:test";

import {
  type EmailMessageMeta,
  emailToolSchemas,
  envInt,
  previewFromParts,
  viewEmailMessage,
} from "./imap-tool-kit.ts";

// ---------------------------------------------------------------------------
// emailToolSchemas — parse / reject
// ---------------------------------------------------------------------------

describe("emailToolSchemas.listArgs", () => {
  test("accepts empty object (all optional)", () => {
    expect(emailToolSchemas.listArgs.safeParse({}).success).toBe(true);
  });
  test("accepts full object", () => {
    const r = emailToolSchemas.listArgs.safeParse({ mailbox: "INBOX", limit: 20 });
    expect(r.success).toBe(true);
  });
  test("rejects limit=0 (below min)", () => {
    expect(emailToolSchemas.listArgs.safeParse({ limit: 0 }).success).toBe(false);
  });
  test("rejects limit=201 (above max)", () => {
    expect(emailToolSchemas.listArgs.safeParse({ limit: 201 }).success).toBe(false);
  });
  test("rejects empty mailbox string", () => {
    expect(emailToolSchemas.listArgs.safeParse({ mailbox: "" }).success).toBe(false);
  });
});

describe("emailToolSchemas.getArgs", () => {
  test("accepts valid uid", () => {
    expect(emailToolSchemas.getArgs.safeParse({ uid: 1 }).success).toBe(true);
  });
  test("accepts uid with optional mailbox", () => {
    expect(emailToolSchemas.getArgs.safeParse({ uid: 42, mailbox: "Sent" }).success).toBe(true);
  });
  test("rejects uid=0 (below min=1)", () => {
    expect(emailToolSchemas.getArgs.safeParse({ uid: 0 }).success).toBe(false);
  });
  test("rejects missing uid", () => {
    expect(emailToolSchemas.getArgs.safeParse({}).success).toBe(false);
  });
});

describe("emailToolSchemas.searchArgs", () => {
  test("accepts query with optional limit", () => {
    expect(emailToolSchemas.searchArgs.safeParse({ query: "hello" }).success).toBe(true);
  });
  test("rejects empty query", () => {
    expect(emailToolSchemas.searchArgs.safeParse({ query: "" }).success).toBe(false);
  });
  test("rejects query over 500 chars", () => {
    expect(emailToolSchemas.searchArgs.safeParse({ query: "x".repeat(501) }).success).toBe(false);
  });
});

describe("emailToolSchemas.sendArgs", () => {
  test("accepts full send args", () => {
    const r = emailToolSchemas.sendArgs.safeParse({
      to: "a@b.com",
      subject: "Hi",
      body: "Hello",
      cc: "c@d.com",
      bcc: "e@f.com",
    });
    expect(r.success).toBe(true);
  });
  test("rejects empty to", () => {
    expect(emailToolSchemas.sendArgs.safeParse({ to: "", subject: "S", body: "B" }).success).toBe(
      false,
    );
  });
  test("rejects empty subject", () => {
    expect(emailToolSchemas.sendArgs.safeParse({ to: "a@b", subject: "", body: "B" }).success).toBe(
      false,
    );
  });
  test("rejects subject over 998 chars", () => {
    expect(
      emailToolSchemas.sendArgs.safeParse({
        to: "a@b",
        subject: "x".repeat(999),
        body: "B",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// viewEmailMessage
// ---------------------------------------------------------------------------

function sampleMeta(): EmailMessageMeta {
  return {
    uid: 42,
    mailbox: "INBOX",
    uidValidity: "999",
    envelope: {
      date: new Date("2026-05-31T12:00:00.000Z"),
      subject: "Test Subject",
      messageId: "<abc@example.com>",
      from: [{ name: "Alice", address: "alice@example.com" }],
      to: [{ address: "bob@example.com" }],
      cc: [{ name: "Carol", address: "carol@example.com" }],
    },
    attachments: [{ filename: "doc.pdf", sizeBytes: 4096, mimeType: "application/pdf" }],
    preview: "Preview text here",
  };
}

function fmtAddr(a: { readonly name?: string; readonly address?: string }): string {
  const addr = a.address ?? "";
  if (a.name !== undefined && a.name !== "") {
    return addr === "" ? a.name : `${a.name} <${addr}>`;
  }
  return addr;
}

describe("viewEmailMessage", () => {
  test("maps uid/mailbox/uidValidity correctly", () => {
    const view = viewEmailMessage(sampleMeta(), fmtAddr);
    expect(view["uid"]).toBe(42);
    expect(view["mailbox"]).toBe("INBOX");
    expect(view["uidValidity"]).toBe("999");
  });

  test("converts Date to ISO string", () => {
    const view = viewEmailMessage(sampleMeta(), fmtAddr);
    expect(view["date"]).toBe("2026-05-31T12:00:00.000Z");
  });

  test("passes through string date as-is", () => {
    const meta: EmailMessageMeta = {
      ...sampleMeta(),
      envelope: { ...sampleMeta().envelope, date: "Thu, 31 May 2026 12:00:00 +0000" },
    };
    const view = viewEmailMessage(meta, fmtAddr);
    expect(view["date"]).toBe("Thu, 31 May 2026 12:00:00 +0000");
  });

  test("null date maps to null", () => {
    const meta: EmailMessageMeta = {
      ...sampleMeta(),
      envelope: { ...sampleMeta().envelope, date: null },
    };
    expect(viewEmailMessage(meta, fmtAddr)["date"]).toBeNull();
  });

  test("formats from/to/cc addresses using formatAddr", () => {
    const view = viewEmailMessage(sampleMeta(), fmtAddr);
    expect(view["from"]).toEqual(["Alice <alice@example.com>"]);
    expect(view["to"]).toEqual(["bob@example.com"]);
    expect(view["cc"]).toEqual(["Carol <carol@example.com>"]);
  });

  test("missing envelope arrays default to empty", () => {
    const meta: EmailMessageMeta = {
      ...sampleMeta(),
      envelope: { subject: "X" },
    };
    const view = viewEmailMessage(meta, fmtAddr);
    expect(view["from"]).toEqual([]);
    expect(view["to"]).toEqual([]);
    expect(view["cc"]).toEqual([]);
  });

  test("maps attachment metadata (filename/sizeBytes/mimeType only)", () => {
    const view = viewEmailMessage(sampleMeta(), fmtAddr);
    const atts = view["attachments"] as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    const att = atts[0]!;
    expect(att["filename"]).toBe("doc.pdf");
    expect(att["sizeBytes"]).toBe(4096);
    expect(att["mimeType"]).toBe("application/pdf");
    // Exactly these three keys — no content/bytes/data field.
    expect(Object.keys(att).sort()).toEqual(["filename", "mimeType", "sizeBytes"]);
  });

  test("carries preview through unchanged", () => {
    expect(viewEmailMessage(sampleMeta(), fmtAddr)["preview"]).toBe("Preview text here");
  });

  test("null messageId/subject map to null", () => {
    const meta: EmailMessageMeta = {
      ...sampleMeta(),
      envelope: { ...sampleMeta().envelope, messageId: null, subject: null },
    };
    const view = viewEmailMessage(meta, fmtAddr);
    expect(view["messageId"]).toBeNull();
    expect(view["subject"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// envInt
// ---------------------------------------------------------------------------

describe("envInt", () => {
  test("returns fallback when env var is unset", () => {
    delete process.env["__TEST_IMAP_PORT"];
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(993);
  });

  test("returns fallback for empty string", () => {
    process.env["__TEST_IMAP_PORT"] = "";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(993);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("parses a valid port", () => {
    process.env["__TEST_IMAP_PORT"] = "587";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(587);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("returns fallback for non-numeric value", () => {
    process.env["__TEST_IMAP_PORT"] = "notanumber";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(993);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("returns fallback for 0 (below range)", () => {
    process.env["__TEST_IMAP_PORT"] = "0";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(993);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("returns fallback for 65536 (above range)", () => {
    process.env["__TEST_IMAP_PORT"] = "65536";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(993);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("accepts 65535 (boundary)", () => {
    process.env["__TEST_IMAP_PORT"] = "65535";
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(65535);
    delete process.env["__TEST_IMAP_PORT"];
  });

  test("truncates float to integer", () => {
    process.env["__TEST_IMAP_PORT"] = "993.9";
    expect(envInt("__TEST_IMAP_PORT", 465)).toBe(993);
    delete process.env["__TEST_IMAP_PORT"];
  });
});

// ---------------------------------------------------------------------------
// previewFromParts
// ---------------------------------------------------------------------------

describe("previewFromParts", () => {
  test("returns empty string for undefined map", () => {
    expect(previewFromParts(undefined, "1")).toBe("");
  });

  test("looks up the given partKey first", () => {
    const m = new Map<string, Buffer>([
      ["2", Buffer.from("part2 content")],
      ["1", Buffer.from("part1 content")],
    ]);
    expect(previewFromParts(m, "2")).toBe("part2 content");
  });

  test('falls back to "1" when partKey is not found', () => {
    const m = new Map<string, Buffer>([["1", Buffer.from("fallback 1")]]);
    expect(previewFromParts(m, "MISSING")).toBe("fallback 1");
  });

  test('falls back to "TEXT" when neither partKey nor "1" is found', () => {
    const m = new Map<string, Buffer>([["TEXT", Buffer.from("text fallback")]]);
    expect(previewFromParts(m, "2.1")).toBe("text fallback");
  });

  test("returns empty string when nothing matches", () => {
    const m = new Map<string, Buffer>([["3", Buffer.from("unused")]]);
    expect(previewFromParts(m, "2.1")).toBe("");
  });

  test("caps long content via capPreview (over 2000 chars trimmed)", () => {
    const longText = "A".repeat(3000);
    const m = new Map<string, Buffer>([["1", Buffer.from(longText)]]);
    const result = previewFromParts(m, "1");
    expect(result.length).toBeLessThanOrEqual(2000);
  });
});
