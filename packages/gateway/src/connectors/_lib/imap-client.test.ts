import { describe, expect, test } from "bun:test";
import type { FetchMessageObject, MessageStructureObject } from "imapflow";

import type { ImapConnectionConfig } from "../imap-sync.ts";
import {
  addresses,
  capPreview,
  extractAttachments,
  fetchImapMessages,
  findTextPlainPart,
  type ImapClientFactory,
  type ImapClientLike,
  previewFromParts,
  toInput,
} from "./imap-client.ts";

/** Build a partial BODYSTRUCTURE node; the connector only reads a few fields. */
function node(partial: Partial<MessageStructureObject>): MessageStructureObject {
  return partial as MessageStructureObject; // NOSONAR S4325: Partial→full assertion required under exactOptionalPropertyTypes
}

describe("capPreview", () => {
  test("normalizes CRLF, collapses runs, and trims", () => {
    expect(capPreview("a\r\nb")).toBe("a\nb");
    expect(capPreview("a   \t b")).toBe("a b");
    expect(capPreview("a\n\n\n\nb")).toBe("a\nb");
    expect(capPreview("  hi  ")).toBe("hi");
  });

  test("truncates to the 2000-char cap and never lengthens", () => {
    expect(capPreview("x".repeat(2500))).toHaveLength(2000);
    expect(capPreview("short")).toBe("short");
  });
});

describe("addresses", () => {
  test("formats name + address, address-only, and name-only", () => {
    expect(
      addresses([
        { name: "Ada", address: "ada@example.com" },
        { address: "noname@example.com" },
        { name: "Just Name" },
      ]),
    ).toEqual(["Ada <ada@example.com>", "noname@example.com", "Just Name"]);
  });

  test("returns [] for an undefined list", () => {
    expect(addresses(undefined)).toEqual([]);
  });
});

describe("findTextPlainPart", () => {
  test("returns the first non-attachment text/plain part key", () => {
    const root = node({
      childNodes: [node({ part: "1", type: "text/html" }), node({ part: "2", type: "text/plain" })],
    });
    expect(findTextPlainPart(root)).toBe("2");
  });

  test("falls back to the first text/* part, then to '1'", () => {
    expect(findTextPlainPart(node({ childNodes: [node({ part: "1", type: "text/html" })] }))).toBe(
      "1",
    );
    expect(findTextPlainPart(undefined)).toBe("1");
  });

  test("skips an attachment text/plain part", () => {
    const root = node({
      childNodes: [
        node({ part: "1", type: "text/plain", dispositionParameters: { filename: "a.txt" } }),
        node({ part: "2", type: "text/html" }),
      ],
    });
    expect(findTextPlainPart(root)).toBe("2");
  });
});

describe("extractAttachments", () => {
  test("collects metadata for leaf attachments only, recursing multiparts", () => {
    const root = node({
      childNodes: [
        node({ part: "1", type: "text/plain", size: 10 }),
        node({
          childNodes: [
            node({
              part: "2.1",
              type: "application/pdf",
              size: 2048,
              dispositionParameters: { filename: "report.pdf" },
            }),
          ],
        }),
        node({ part: "3", type: "image/png", size: 50, parameters: { name: "logo.png" } }),
      ],
    });
    expect(extractAttachments(root)).toEqual([
      { filename: "report.pdf", sizeBytes: 2048, mimeType: "application/pdf" },
      { filename: "logo.png", sizeBytes: 50, mimeType: "image/png" },
    ]);
  });

  test("nulls a non-numeric size and an empty mimetype", () => {
    const root = node({ part: "1", dispositionParameters: { filename: "x.bin" } });
    expect(extractAttachments(root)).toEqual([
      { filename: "x.bin", sizeBytes: null, mimeType: null },
    ]);
  });

  test("returns [] for an undefined structure", () => {
    expect(extractAttachments(undefined)).toEqual([]);
  });
});

describe("previewFromParts", () => {
  const parts = new Map<string, Buffer>([
    ["2", Buffer.from("from part 2")],
    ["1", Buffer.from("from part 1")],
  ]);

  test("returns the capped preview for the requested part", () => {
    expect(previewFromParts(parts, "2")).toBe("from part 2");
  });

  test("falls back to part '1' then 'TEXT'", () => {
    expect(previewFromParts(parts, "9")).toBe("from part 1");
    expect(previewFromParts(new Map([["TEXT", Buffer.from("text body")]]), "9")).toBe("text body");
  });

  test("returns '' when no parts or no match", () => {
    expect(previewFromParts(undefined, "1")).toBe("");
    expect(previewFromParts(new Map(), "1")).toBe("");
  });
});

describe("toInput", () => {
  test("maps a fetched message to the indexed input shape", () => {
    const msg = {
      uid: 42,
      envelope: {
        messageId: "<mid@example.com>",
        subject: "Hello",
        date: new Date("2026-01-02T03:04:05.000Z"),
        from: [{ name: "Ada", address: "ada@example.com" }],
        to: [{ address: "you@example.com" }],
        cc: [],
      },
      bodyStructure: node({ part: "1", type: "text/plain" }),
      bodyParts: new Map<string, Buffer>([["1", Buffer.from("body preview")]]),
    } as unknown as FetchMessageObject;

    expect(toInput(msg, "INBOX", "12345")).toEqual({
      uid: 42,
      mailbox: "INBOX",
      uidValidity: "12345",
      messageId: "<mid@example.com>",
      subject: "Hello",
      date: "2026-01-02T03:04:05.000Z",
      from: ["Ada <ada@example.com>"],
      to: ["you@example.com"],
      cc: [],
      attachments: [],
      preview: "body preview",
    });
  });

  test("tolerates a missing envelope and a string date", () => {
    const msg = {
      uid: 7,
      envelope: { date: "2026-05-01" },
      bodyStructure: undefined,
      bodyParts: undefined,
    } as unknown as FetchMessageObject;

    const out = toInput(msg, "Archive", null);
    expect(out.uid).toBe(7);
    expect(out.uidValidity).toBeNull();
    expect(out.messageId).toBeNull();
    expect(out.subject).toBeNull();
    expect(out.date).toBe("2026-05-01");
    expect(out.from).toEqual([]);
    expect(out.preview).toBe("");
  });
});

function makeFake(opts: {
  mailbox?: ImapClientLike["mailbox"];
  messages?: FetchMessageObject[];
  connectError?: Error;
  fetchError?: Error;
  onLogout?: () => void;
}): ImapClientFactory {
  return () => ({
    async connect() {
      if (opts.connectError !== undefined) {
        throw opts.connectError;
      }
    },
    async getMailboxLock() {
      return { release() {} };
    },
    mailbox: opts.mailbox ?? false,
    async *fetch() {
      if (opts.fetchError !== undefined) {
        throw opts.fetchError;
      }
      for (const m of opts.messages ?? []) {
        yield m;
      }
    },
    async logout() {
      opts.onLogout?.();
    },
  });
}

function fakeMsg(uid: number): FetchMessageObject {
  return {
    uid,
    envelope: { subject: `m${uid}` },
    bodyStructure: { part: "1", type: "text/plain" },
    bodyParts: new Map([["1", Buffer.from(`body ${uid}`)]]),
  } as unknown as FetchMessageObject;
}

describe("fetchImapMessages", () => {
  const config = {
    host: "imap.example.com",
    port: 993,
    username: "u",
    password: "p",
    mailbox: "INBOX",
  } as unknown as ImapConnectionConfig;

  test("returns the most-recent messages sorted by descending uid", async () => {
    const out = await fetchImapMessages(
      config,
      10,
      makeFake({ mailbox: { uidValidity: 100, exists: 2 }, messages: [fakeMsg(1), fakeMsg(2)] }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.messages.map((m) => m.uid)).toEqual([2, 1]);
      expect(out.messages[0]?.uidValidity).toBe("100");
    }
  });

  test("returns [] for an empty mailbox without fetching", async () => {
    const out = await fetchImapMessages(
      config,
      10,
      makeFake({ mailbox: { uidValidity: 1, exists: 0 }, messages: [fakeMsg(1)] }),
    );
    expect(out).toEqual({ ok: true, messages: [] });
  });

  test("treats an unselectable mailbox (false) as empty", async () => {
    const out = await fetchImapMessages(config, 10, makeFake({ mailbox: false }));
    expect(out).toEqual({ ok: true, messages: [] });
  });

  test("returns { ok: false } when connect fails", async () => {
    const out = await fetchImapMessages(
      config,
      10,
      makeFake({ connectError: new Error("ECONNREFUSED") }),
    );
    expect(out).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  test("returns { ok: false } and still logs out when fetch throws", async () => {
    let loggedOut = false;
    const out = await fetchImapMessages(
      config,
      10,
      makeFake({
        mailbox: { uidValidity: 5, exists: 3 },
        fetchError: new Error("boom"),
        onLogout: () => {
          loggedOut = true;
        },
      }),
    );
    expect(out).toEqual({ ok: false, error: "boom" });
    expect(loggedOut).toBe(true);
  });

  test("without a factory, the default ImapFlow client is used and a refused connection → { ok: false }", async () => {
    // Exercises `defaultImapClientFactory` (the real ImapFlow construction) and
    // the connect-failure path. Port 1 on loopback refuses immediately.
    const out = await fetchImapMessages(
      {
        host: "127.0.0.1",
        port: 1,
        username: "u",
        password: "p",
        mailbox: "INBOX",
        secure: false,
      },
      1,
    );
    expect(out.ok).toBe(false);
  });
});
