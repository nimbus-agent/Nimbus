import { describe, expect, test } from "bun:test";

import {
  asRecord,
  asString,
  buildGetRequest,
  buildListRequest,
  buildSearchRequest,
  CORE_CAPABILITY,
  capPreview,
  EMAIL_PROPERTIES,
  extractAttachments,
  extractEmailList,
  formatAddress,
  formatAddresses,
  type JmapAttachmentMeta,
  type JmapEmailView,
  type JmapSession,
  MAIL_CAPABILITY,
  MAX_BODY_VALUE_BYTES,
  methodResponseArgs,
  PREVIEW_MAX_CHARS,
  parseSession,
  previewFor,
  SUBMISSION_CAPABILITY,
  validateApiUrl,
  viewEmail,
} from "./index.ts";

// ─── constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  test("capability URNs are non-empty strings", () => {
    expect(CORE_CAPABILITY).toBe("urn:ietf:params:jmap:core");
    expect(MAIL_CAPABILITY).toBe("urn:ietf:params:jmap:mail");
    expect(SUBMISSION_CAPABILITY).toBe("urn:ietf:params:jmap:submission");
  });

  test("MAX_BODY_VALUE_BYTES and PREVIEW_MAX_CHARS are positive numbers", () => {
    expect(MAX_BODY_VALUE_BYTES).toBeGreaterThan(0);
    expect(PREVIEW_MAX_CHARS).toBeGreaterThan(0);
    expect(PREVIEW_MAX_CHARS).toBe(2000);
    expect(MAX_BODY_VALUE_BYTES).toBe(2048);
  });

  test("EMAIL_PROPERTIES includes required fields", () => {
    expect(EMAIL_PROPERTIES).toContain("id");
    expect(EMAIL_PROPERTIES).toContain("subject");
    expect(EMAIL_PROPERTIES).toContain("from");
    expect(EMAIL_PROPERTIES).toContain("preview");
    expect(EMAIL_PROPERTIES).toContain("attachments");
    expect(EMAIL_PROPERTIES.length).toBeGreaterThan(5);
  });
});

// ─── asRecord ────────────────────────────────────────────────────────────────

describe("asRecord", () => {
  test("returns the object for plain objects", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });

  test("returns null for non-object values", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord("string")).toBeNull();
    expect(asRecord(42)).toBeNull();
    expect(asRecord(true)).toBeNull();
  });

  test("returns null for arrays", () => {
    expect(asRecord([])).toBeNull();
    expect(asRecord([1, 2, 3])).toBeNull();
  });
});

// ─── asString ────────────────────────────────────────────────────────────────

describe("asString", () => {
  test("returns string for non-empty strings", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString(" ")).toBe(" ");
  });

  test("returns null for empty string, non-strings, and null", () => {
    expect(asString("")).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
    expect(asString(42)).toBeNull();
    expect(asString({})).toBeNull();
  });
});

// ─── parseSession ─────────────────────────────────────────────────────────────

describe("parseSession", () => {
  test("extracts apiUrl + mail account id", () => {
    const session: JmapSession | null = parseSession({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
    });
    expect(session).toEqual({ apiUrl: "https://api.fastmail.com/jmap/api/", accountId: "acc1" });
  });

  test("returns null when apiUrl is missing", () => {
    expect(parseSession({ primaryAccounts: { "urn:ietf:params:jmap:mail": "a" } })).toBeNull();
  });

  test("returns null when mail capability key is missing", () => {
    expect(parseSession({ apiUrl: "x", primaryAccounts: {} })).toBeNull();
  });

  test("returns null for non-object / null / string input", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("nope")).toBeNull();
    expect(parseSession(42)).toBeNull();
  });

  test("returns null when primaryAccounts is not an object", () => {
    expect(parseSession({ apiUrl: "https://x.com", primaryAccounts: "bad" })).toBeNull();
  });
});

// ─── validateApiUrl ───────────────────────────────────────────────────────────

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

  test("rejects when base itself is not a valid URL", () => {
    expect(() => validateApiUrl("https://x.com/api", "not-a-url")).toThrow(
      /not a valid absolute URL/,
    );
  });
});

// ─── formatAddress(es) ────────────────────────────────────────────────────────

describe("formatAddress", () => {
  test("formats Name <email> when both present", () => {
    expect(formatAddress({ name: "Ada", email: "a@x" })).toBe("Ada <a@x>");
  });

  test("formats bare email when name is absent", () => {
    expect(formatAddress({ email: "a@x" })).toBe("a@x");
  });

  test("returns name when email is empty or missing", () => {
    expect(formatAddress({ name: "Ada", email: "" })).toBe("Ada");
    expect(formatAddress({ name: "Ada" })).toBe("Ada");
  });

  test("returns empty string for empty object", () => {
    expect(formatAddress({})).toBe("");
  });

  test("returns empty string for non-object", () => {
    expect(formatAddress("nope")).toBe("");
    expect(formatAddress(null)).toBe("");
    expect(formatAddress(42)).toBe("");
  });
});

describe("formatAddresses", () => {
  test("maps and filters empty entries", () => {
    expect(formatAddresses([{ email: "a@x" }, {}])).toEqual(["a@x"]);
  });

  test("returns [] for non-arrays", () => {
    expect(formatAddresses(undefined)).toEqual([]);
    expect(formatAddresses(null)).toEqual([]);
    expect(formatAddresses("nope")).toEqual([]);
  });

  test("returns [] for empty array", () => {
    expect(formatAddresses([])).toEqual([]);
  });
});

// ─── extractAttachments ───────────────────────────────────────────────────────

describe("extractAttachments", () => {
  test("maps name/size/type and tolerates missing fields", () => {
    const result: JmapAttachmentMeta[] = extractAttachments([
      { name: "r.pdf", size: 10, type: "application/pdf" },
      { size: "bad", type: "" },
    ]);
    expect(result).toEqual([
      { name: "r.pdf", sizeBytes: 10, mimeType: "application/pdf" },
      { name: null, sizeBytes: null, mimeType: null },
    ]);
  });

  test("returns [] for a non-array", () => {
    expect(extractAttachments(undefined)).toEqual([]);
    expect(extractAttachments(null)).toEqual([]);
    expect(extractAttachments("nope")).toEqual([]);
  });

  test("returns [] for empty array", () => {
    expect(extractAttachments([])).toEqual([]);
  });

  test("treats non-finite size as null sizeBytes", () => {
    const result = extractAttachments([{ name: "x.txt", size: Infinity, type: "text/plain" }]);
    expect(result[0]?.sizeBytes).toBeNull();
  });

  test("treats null entry as all-null attachment", () => {
    const result = extractAttachments([null]);
    expect(result).toEqual([{ name: null, sizeBytes: null, mimeType: null }]);
  });
});

// ─── capPreview ───────────────────────────────────────────────────────────────

describe("capPreview", () => {
  test("collapses multiple spaces and tabs", () => {
    expect(capPreview("a   b\t\tc")).toBe("a b c");
  });

  test("normalizes CRLF to LF", () => {
    expect(capPreview("a\r\nb")).toBe("a\nb");
  });

  test("collapses multiple blank lines to single newline", () => {
    expect(capPreview("a\n\n\nb")).toBe("a\nb");
  });

  test("trims leading and trailing whitespace", () => {
    expect(capPreview("  a  ")).toBe("a");
  });

  test("truncates at PREVIEW_MAX_CHARS", () => {
    const long = "x".repeat(2500);
    expect(capPreview(long).length).toBe(2000);
  });

  test("does not truncate text shorter than limit", () => {
    expect(capPreview("hello world")).toBe("hello world");
  });

  test("combined: whitespace normalization + truncation", () => {
    const result = capPreview("  a\r\n\r\n\r\nb   c ");
    expect(result).toBe("a\nb c");
  });
});

// ─── previewFor ───────────────────────────────────────────────────────────────

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

  test("falls back to the server preview string when bodyValues is missing", () => {
    expect(previewFor({ preview: "server preview" })).toBe("server preview");
  });

  test("falls back when textBody part id is not in bodyValues", () => {
    expect(previewFor({ textBody: [{ partId: "9" }], bodyValues: {}, preview: "fallback" })).toBe(
      "fallback",
    );
  });

  test("falls back when textBody value is empty string", () => {
    expect(
      previewFor({
        textBody: [{ partId: "1" }],
        bodyValues: { "1": { value: "" } },
        preview: "empty-val-fallback",
      }),
    ).toBe("empty-val-fallback");
  });

  test("returns empty string when both bodyValues and preview are absent", () => {
    expect(previewFor({})).toBe("");
  });

  test("falls back when bodyValues is null (not a record)", () => {
    expect(previewFor({ textBody: [{ partId: "1" }], bodyValues: null, preview: "np" })).toBe("np");
  });

  test("skips textBody parts without a partId", () => {
    expect(
      previewFor({
        textBody: [{ blobId: "b1" }],
        bodyValues: {},
        preview: "noPart",
      }),
    ).toBe("noPart");
  });
});

// ─── viewEmail ────────────────────────────────────────────────────────────────

describe("viewEmail", () => {
  test("reduces a full JMAP email to header/metadata/preview (no bytes)", () => {
    const v: JmapEmailView | null = viewEmail({
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
    expect(v?.subject).toBe("Hi");
    expect(v?.from).toEqual(["Ada <a@x>"]);
    expect(v?.to).toEqual(["b@x"]);
    expect(v?.cc).toEqual([]);
    expect(v?.receivedAt).toBe("2026-05-31T00:00:00Z");
    expect(v?.attachments).toEqual([{ name: "f.pdf", sizeBytes: 3, mimeType: "application/pdf" }]);
    // blobId must be dropped — only name/size/type survive
    expect(JSON.stringify(v)).not.toContain("blobId");
    expect(v?.preview).toBe("hi");
  });

  test("returns null when both id and message-id are absent", () => {
    expect(viewEmail({ subject: "x" })).toBeNull();
  });

  test("returns null for null input", () => {
    expect(viewEmail(null)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(viewEmail("nope")).toBeNull();
    expect(viewEmail(42)).toBeNull();
  });

  test("uses messageId[0] as messageId and empty string for missing id", () => {
    const v = viewEmail({ messageId: ["<x@y>"], subject: "s" });
    expect(v).not.toBeNull();
    expect(v?.id).toBe("");
    expect(v?.messageId).toBe("<x@y>");
  });

  test("uses id when messageId array has empty first element", () => {
    const v = viewEmail({ id: "abc", messageId: [""] });
    expect(v).not.toBeNull();
    expect(v?.id).toBe("abc");
    expect(v?.messageId).toBeNull();
  });
});

// ─── request builders ─────────────────────────────────────────────────────────

describe("buildListRequest", () => {
  test("queries recent emails then gets their views with capped body values", () => {
    const req = buildListRequest("acc1", 25) as Record<string, unknown>;
    const calls = req["methodCalls"] as unknown[];
    expect((calls[0] as unknown[])[0]).toBe("Email/query");
    expect(((calls[0] as unknown[])[1] as Record<string, unknown>)["limit"]).toBe(25);
    const getArgs = (calls[1] as unknown[])[1] as Record<string, unknown>;
    expect(getArgs["maxBodyValueBytes"]).toBe(2048);
    expect(getArgs["fetchTextBodyValues"]).toBe(true);
  });

  test("includes CORE and MAIL capabilities", () => {
    const req = buildListRequest("acc1", 10) as Record<string, unknown>;
    expect(req["using"]).toEqual([CORE_CAPABILITY, MAIL_CAPABILITY]);
  });

  test("uses a back-reference #ids from the query result", () => {
    const req = buildListRequest("acc1", 10) as Record<string, unknown>;
    const calls = req["methodCalls"] as unknown[];
    const getArgs = (calls[1] as unknown[])[1] as Record<string, unknown>;
    expect(getArgs["#ids"]).toEqual({ resultOf: "q", name: "Email/query", path: "/ids" });
  });
});

describe("buildSearchRequest", () => {
  test("sets a text filter for the query", () => {
    const req = buildSearchRequest("acc1", "invoice", 10) as Record<string, unknown>;
    const queryArgs = ((req["methodCalls"] as unknown[])[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(queryArgs["filter"]).toEqual({ text: "invoice" });
  });

  test("passes the limit to the query call", () => {
    const req = buildSearchRequest("acc1", "q", 15) as Record<string, unknown>;
    const queryArgs = ((req["methodCalls"] as unknown[])[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(queryArgs["limit"]).toBe(15);
  });
});

describe("buildGetRequest", () => {
  test("fetches a single email by id", () => {
    const req = buildGetRequest("acc1", "M7") as Record<string, unknown>;
    const calls = req["methodCalls"] as unknown[];
    const getArgs = (calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(getArgs["ids"]).toEqual(["M7"]);
  });

  test("uses only a single Email/get call", () => {
    const req = buildGetRequest("acc1", "M7") as Record<string, unknown>;
    const calls = req["methodCalls"] as unknown[];
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[])[0]).toBe("Email/get");
  });
});

// ─── methodResponseArgs / extractEmailList ────────────────────────────────────

describe("methodResponseArgs", () => {
  const envelope = {
    methodResponses: [
      ["Email/query", { ids: ["M1"] }, "q"],
      ["Email/get", { list: [{ id: "M1" }, { id: "M2" }] }, "e"],
    ],
  };

  test("locates a named response by method name", () => {
    expect(methodResponseArgs(envelope, "Email/query")).toEqual({ ids: ["M1"] });
  });

  test("returns null for unknown method name", () => {
    expect(methodResponseArgs(envelope, "Nope")).toBeNull();
  });

  test("returns null when methodResponses is missing", () => {
    expect(methodResponseArgs({}, "Email/get")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(methodResponseArgs(null, "Email/get")).toBeNull();
  });

  test("returns null when entry args is not a record", () => {
    const env = { methodResponses: [["Email/get", "not-a-record", "e"]] };
    expect(methodResponseArgs(env, "Email/get")).toBeNull();
  });
});

describe("extractEmailList", () => {
  test("returns the Email/get list from a valid envelope", () => {
    const envelope = {
      methodResponses: [
        ["Email/query", { ids: ["M1"] }, "q"],
        ["Email/get", { list: [{ id: "M1" }, { id: "M2" }] }, "e"],
      ],
    };
    expect(extractEmailList(envelope)).toHaveLength(2);
  });

  test("returns [] for empty methodResponses", () => {
    expect(extractEmailList({ methodResponses: [] })).toEqual([]);
  });

  test("returns [] for null input", () => {
    expect(extractEmailList(null)).toEqual([]);
  });

  test("returns [] when list is not an array", () => {
    const env = { methodResponses: [["Email/get", { list: "nope" }, "e"]] };
    expect(extractEmailList(env)).toEqual([]);
  });

  test("returns [] when Email/get has no list field", () => {
    const env = { methodResponses: [["Email/get", {}, "e"]] };
    expect(extractEmailList(env)).toEqual([]);
  });
});
