import { describe, expect, test } from "bun:test";

import {
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  capPreview,
  clampLimit,
  extractAttachments,
  extractEmailList,
  formatAddress,
  formatAddresses,
  methodResponseArgs,
  parseSession,
  previewFor,
  validateApiUrl,
  viewEmail,
} from "../src/jmap-core.ts";

describe("parseSession", () => {
  test("extracts apiUrl + mail account id", () => {
    expect(
      parseSession({
        apiUrl: "https://api.fastmail.com/jmap/api/",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
      }),
    ).toEqual({ apiUrl: "https://api.fastmail.com/jmap/api/", accountId: "acc1" });
  });

  test("returns null when apiUrl or the mail account is missing", () => {
    expect(parseSession({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } })).toBeNull();
    expect(parseSession({ apiUrl: "x", primaryAccounts: {} })).toBeNull();
    expect(parseSession(null)).toBeNull();
    expect(parseSession("nope")).toBeNull();
  });
});

describe("validateApiUrl (SSRF guard)", () => {
  const base = "https://api.fastmail.com";

  test("accepts a same-host https apiUrl", () => {
    expect(validateApiUrl("https://api.fastmail.com/jmap/api/", base)).toBe(
      "https://api.fastmail.com/jmap/api/",
    );
  });

  test("rejects a different host (SSRF redirect)", () => {
    expect(() => validateApiUrl("https://evil.example.com/jmap/api/", base)).toThrow(
      /does not match configured/,
    );
  });

  test("rejects non-https schemes", () => {
    expect(() => validateApiUrl("http://api.fastmail.com/jmap/api/", base)).toThrow(/https/);
  });

  test("rejects a non-absolute / malformed url", () => {
    expect(() => validateApiUrl("/jmap/api/", base)).toThrow(/not a valid absolute URL/);
  });
});

describe("formatAddress(es)", () => {
  test("formats Name <email> / bare email / name-only / empty", () => {
    expect(formatAddress({ name: "Ada", email: "a@x" })).toBe("Ada <a@x>");
    expect(formatAddress({ email: "a@x" })).toBe("a@x");
    expect(formatAddress({ name: "Ada" })).toBe("Ada");
    expect(formatAddress({})).toBe("");
    expect(formatAddress("nope")).toBe("");
  });

  test("formatAddresses filters empties and tolerates non-arrays", () => {
    expect(formatAddresses([{ email: "a@x" }, {}])).toEqual(["a@x"]);
    expect(formatAddresses(undefined)).toEqual([]);
  });
});

describe("extractAttachments", () => {
  test("maps name/size/type and tolerates missing fields", () => {
    expect(
      extractAttachments([
        { name: "r.pdf", size: 10, type: "application/pdf" },
        { size: "bad", type: "" },
      ]),
    ).toEqual([
      { name: "r.pdf", sizeBytes: 10, mimeType: "application/pdf" },
      { name: null, sizeBytes: null, mimeType: null },
    ]);
  });

  test("returns [] for a non-array", () => {
    expect(extractAttachments(undefined)).toEqual([]);
  });
});

describe("capPreview", () => {
  test("normalizes whitespace + trims and truncates", () => {
    expect(capPreview("  a\r\n\r\n\r\nb   c ")).toBe("a\nb c");
    expect(capPreview("x".repeat(2500))).toHaveLength(2000);
  });
});

describe("previewFor", () => {
  test("prefers the first textBody part's body value", () => {
    expect(
      previewFor({
        textBody: [{ partId: "1" }],
        bodyValues: { "1": { value: "body text" } },
        preview: "p",
      }),
    ).toBe("body text");
  });

  test("falls back to the server preview string", () => {
    expect(previewFor({ preview: "server preview" })).toBe("server preview");
    expect(previewFor({ textBody: [{ partId: "9" }], bodyValues: {}, preview: "fallback" })).toBe(
      "fallback",
    );
  });
});

describe("viewEmail", () => {
  test("reduces a raw JMAP email to the header/metadata/preview view (no bytes)", () => {
    const v = viewEmail({
      id: "M1",
      messageId: ["<a@x>"],
      subject: "Hi",
      from: [{ name: "Ada", email: "a@x" }],
      to: [{ email: "b@x" }],
      cc: [],
      receivedAt: "2026-05-31T00:00:00Z",
      attachments: [{ blobId: "B1", name: "f.pdf", size: 3, type: "application/pdf" }],
      preview: "hi",
    });
    expect(v).not.toBeNull();
    expect(v?.id).toBe("M1");
    expect(v?.messageId).toBe("<a@x>");
    expect(v?.from).toEqual(["Ada <a@x>"]);
    expect(v?.attachments).toEqual([{ name: "f.pdf", sizeBytes: 3, mimeType: "application/pdf" }]);
    // The blobId pointer is dropped — only name/size/type survive.
    expect(JSON.stringify(v)).not.toContain("blobId");
  });

  test("returns null when both id and message-id are absent", () => {
    expect(viewEmail({ subject: "x" })).toBeNull();
    expect(viewEmail(null)).toBeNull();
  });
});

describe("request builders", () => {
  test("buildListRequest queries recent then gets with capped body values", () => {
    const req = buildListRequest("acc1", 25) as Record<string, unknown>;
    const calls = req["methodCalls"] as unknown[];
    expect((calls[0] as unknown[])[0]).toBe("Email/query");
    expect(((calls[0] as unknown[])[1] as Record<string, unknown>)["limit"]).toBe(25);
    const getArgs = (calls[1] as unknown[])[1] as Record<string, unknown>;
    expect(getArgs["maxBodyValueBytes"]).toBe(2048);
    expect(getArgs["fetchTextBodyValues"]).toBe(true);
  });

  test("buildSearchRequest sets a text filter", () => {
    const req = buildSearchRequest("acc1", "invoice", 10) as Record<string, unknown>;
    const queryArgs = ((req["methodCalls"] as unknown[])[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(queryArgs["filter"]).toEqual({ text: "invoice" });
  });

  test("buildGetRequest fetches a single id", () => {
    const req = buildGetRequest("acc1", "M7") as Record<string, unknown>;
    const getArgs = ((req["methodCalls"] as unknown[])[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(getArgs["ids"]).toEqual(["M7"]);
  });
});

describe("methodResponseArgs / extractEmailList", () => {
  const envelope = {
    methodResponses: [
      ["Email/query", { ids: ["M1"] }, "q"],
      ["Email/get", { list: [{ id: "M1" }, { id: "M2" }] }, "e"],
    ],
  };

  test("methodResponseArgs locates a named response", () => {
    expect(methodResponseArgs(envelope, "Email/query")).toEqual({ ids: ["M1"] });
    expect(methodResponseArgs(envelope, "Nope")).toBeNull();
    expect(methodResponseArgs({}, "Email/get")).toBeNull();
  });

  test("extractEmailList returns the Email/get list", () => {
    expect(extractEmailList(envelope)).toHaveLength(2);
    expect(extractEmailList({ methodResponses: [] })).toEqual([]);
    expect(extractEmailList(null)).toEqual([]);
  });
});

describe("clampLimit", () => {
  test("defaults, floors at 1, caps at 200", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(200);
    expect(clampLimit(30)).toBe(30);
  });
});
