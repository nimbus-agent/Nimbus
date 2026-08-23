import { describe, expect, test } from "bun:test";
import type { WriteToolRegistrar } from "./consent-kit.ts";

import {
  type EmailMessageMeta,
  type EmailReadClient,
  type EmailSendMailer,
  emailToolSchemas,
  envInt,
  previewFromParts,
  registerEmailConnectorTools,
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

  // fallback 993 throughout, so the expected value doubles as "was the raw value accepted?"
  test.each([
    ["empty string", "", 993],
    ["a valid port", "587", 587],
    ["a non-numeric value", "notanumber", 993],
    ["0 (below range)", "0", 993],
    ["65536 (above range)", "65536", 993],
    ["65535 (upper boundary)", "65535", 65535],
  ])("%s → %s", (_label, raw, expected) => {
    process.env["__TEST_IMAP_PORT"] = raw;
    expect(envInt("__TEST_IMAP_PORT", 993)).toBe(expected);
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

// ---------------------------------------------------------------------------
// registerEmailConnectorTools
// ---------------------------------------------------------------------------

type RecordedTool = {
  name: string;
  description: string;
  handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};

function fakeServer(recorded: RecordedTool[]): { tool: (...args: never) => unknown } {
  return {
    tool: ((
      name: string,
      description: string,
      _shape: unknown,
      handler: RecordedTool["handler"],
    ) => {
      recorded.push({ name, description, handler });
    }) as unknown as (...args: never) => unknown,
  };
}

function stubMeta(uid: number): EmailMessageMeta {
  return {
    uid,
    mailbox: "INBOX",
    uidValidity: "1",
    envelope: { subject: `s${uid}`, from: [{ address: "a@b.com" }] },
    attachments: [],
    preview: `p${uid}`,
  };
}

describe("registerEmailConnectorTools", () => {
  function setup(prefix: string) {
    const recorded: RecordedTool[] = [];
    const calls: { list: number; get: number; search: number; send: number } = {
      list: 0,
      get: 0,
      search: 0,
      send: 0,
    };
    const client: EmailReadClient = {
      list: async () => {
        calls.list += 1;
        return [stubMeta(1)];
      },
      get: async (uid) => {
        calls.get += 1;
        return uid === 999 ? null : stubMeta(uid);
      },
      search: async () => {
        calls.search += 1;
        return [stubMeta(2)];
      },
    };
    const mailer: EmailSendMailer = {
      send: async () => {
        calls.send += 1;
        return { messageId: "<mid>", accepted: ["a@b.com"], rejected: [] };
      },
    };
    // The send tool now goes through the connector's write registrar. This stub records the
    // registration the same way `fakeServer` does, so the existing assertions about the four
    // tool names and their descriptions keep testing what they always did.
    const registerWriteTool = ((
      name: string,
      _cfg: unknown,
      description: string,
      _schema: unknown,
      handler: unknown,
    ) => {
      recorded.push({ name, description, handler } as (typeof recorded)[number]);
    }) as unknown as WriteToolRegistrar;

    registerEmailConnectorTools({
      server: fakeServer(recorded),
      registerWriteTool,
      toolPrefix: prefix,
      descriptions: { list: "L", get: "G", search: "Se", send: "Sd" },
      client,
      mailer,
      formatAddr: fmtAddr,
    });
    return { recorded, calls };
  }

  test("registers the 4 prefixed tools with the supplied descriptions", () => {
    const { recorded } = setup("imap");
    expect(recorded.map((r) => r.name)).toEqual([
      "imap_list",
      "imap_get",
      "imap_search",
      "imap_mail_send",
    ]);
    expect(recorded.map((r) => r.description)).toEqual(["L", "G", "Se", "Sd"]);
  });

  test("honours the toolPrefix", () => {
    const { recorded } = setup("protonmail");
    expect(recorded[0]!.name).toBe("protonmail_list");
    expect(recorded[3]!.name).toBe("protonmail_mail_send");
  });

  test("list handler calls client.list and wraps items", async () => {
    const { recorded, calls } = setup("imap");
    const res = await recorded[0]!.handler({});
    expect(calls.list).toBe(1);
    const body = JSON.parse(res.content[0]!.text) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  test("get handler returns item:null when client.get returns null", async () => {
    const { recorded } = setup("imap");
    const res = await recorded[1]!.handler({ uid: 999 });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ item: null });
  });

  test("search handler calls client.search and wraps matches", async () => {
    const { recorded, calls } = setup("imap");
    const res = await recorded[2]!.handler({ query: "x" });
    expect(calls.search).toBe(1);
    const body = JSON.parse(res.content[0]!.text) as { matches: unknown[] };
    expect(body.matches).toHaveLength(1);
  });

  test("send handler calls mailer.send and returns the result", async () => {
    const { recorded, calls } = setup("imap");
    const res = await recorded[3]!.handler({ to: "a@b.com", subject: "S", body: "B" });
    expect(calls.send).toBe(1);
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      messageId: "<mid>",
      accepted: ["a@b.com"],
      rejected: [],
    });
  });

  test("handler throws on invalid args (zod message)", async () => {
    const { recorded } = setup("imap");
    await expect(recorded[0]!.handler({ limit: 0 })).rejects.toThrow();
    await expect(recorded[1]!.handler({ uid: 0 })).rejects.toThrow();
  });
});
