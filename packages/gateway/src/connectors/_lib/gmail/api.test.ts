import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../../../index/item-store.ts";
import {
  createOAuthConnectorTestSetup,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../../../testing/bun-test-support.ts";
import type { GmailMessageResource, MessagePayload } from "./api.ts";
import {
  extractErrorMessage,
  fetchMessageMetadataOrNullOn404,
  fetchProfile,
  gmailFetchJson,
  headerFrom,
  listQueryForInitial,
  parseHistoryList,
  parseMessagesList,
  upsertGmailMessage,
} from "./api.ts";

type FetchInput = string | URL | Request;

// ---------------------------------------------------------------------------
// listQueryForInitial — pure, no network
// ---------------------------------------------------------------------------
describe("listQueryForInitial", () => {
  test("clamps days below 1 to 1", () => {
    expect(listQueryForInitial(0)).toBe("newer_than:1d");
    expect(listQueryForInitial(-5)).toBe("newer_than:1d");
  });

  test("clamps days above 365 to 365", () => {
    expect(listQueryForInitial(400)).toBe("newer_than:365d");
  });

  test("floors fractional days", () => {
    expect(listQueryForInitial(30.9)).toBe("newer_than:30d");
  });

  test("returns exact day string for valid input", () => {
    expect(listQueryForInitial(7)).toBe("newer_than:7d");
  });
});

// ---------------------------------------------------------------------------
// extractErrorMessage — pure, all branches
// ---------------------------------------------------------------------------
describe("extractErrorMessage", () => {
  test("returns message for Error instances (L84 true branch)", () => {
    expect(extractErrorMessage(new Error("oops"))).toBe("oops");
  });

  test("returns the string itself when e is a string (L87 true branch)", () => {
    // Cast through unknown to satisfy no-any rule
    const thrown: unknown = "something went wrong";
    expect(extractErrorMessage(thrown)).toBe("something went wrong");
  });

  test("returns 'Request failed' for non-Error non-string (L84+L87 false branches)", () => {
    const thrown: unknown = { code: 42 };
    expect(extractErrorMessage(thrown)).toBe("Request failed");

    const thrownNull: unknown = null;
    expect(extractErrorMessage(thrownNull)).toBe("Request failed");

    const thrownNum: unknown = 123;
    expect(extractErrorMessage(thrownNum)).toBe("Request failed");
  });
});

// ---------------------------------------------------------------------------
// headerFrom — pure, branch coverage
// ---------------------------------------------------------------------------
describe("headerFrom", () => {
  test("returns null when payload is undefined (L127 true branch — !Array.isArray)", () => {
    expect(headerFrom(undefined, "Subject")).toBeNull();
  });

  test("returns null when headers is absent from payload (L127 true branch)", () => {
    const payload: MessagePayload = {};
    expect(headerFrom(payload, "Subject")).toBeNull();
  });

  test("returns null when headers is not an array (L127 true branch)", () => {
    // Force a non-array via unknown cast
    const payload = { headers: "bad" } as unknown as MessagePayload;
    expect(headerFrom(payload, "Subject")).toBeNull();
  });

  test("returns null when no matching header found (loop exhausted, L140 null)", () => {
    const payload: MessagePayload = {
      headers: [{ name: "From", value: "a@b.com" }],
    };
    expect(headerFrom(payload, "Subject")).toBeNull();
  });

  test("returns header value when found (case-insensitive)", () => {
    const payload: MessagePayload = {
      headers: [
        { name: "SUBJECT", value: "Hello World" },
        { name: "From", value: "a@b.com" },
      ],
    };
    expect(headerFrom(payload, "subject")).toBe("Hello World");
  });

  test("skips headers where name or value is not a string", () => {
    // h.name undefined, h.value undefined — should be skipped
    const payload = {
      headers: [
        { name: undefined, value: undefined },
        { name: "Subject", value: "Found" },
      ],
    } as unknown as MessagePayload;
    expect(headerFrom(payload, "Subject")).toBe("Found");
  });
});

// ---------------------------------------------------------------------------
// parseMessagesList / parseHistoryList — pure passthrough of asUnknownObjectRecord
// ---------------------------------------------------------------------------
describe("parseMessagesList", () => {
  test("returns empty object for null input", () => {
    expect(parseMessagesList(null)).toEqual({});
  });

  test("returns empty object for array input", () => {
    expect(parseMessagesList([])).toEqual({});
  });

  test("returns parsed object with messages array", () => {
    const input: unknown = { messages: [{ id: "m1" }], nextPageToken: "tok" };
    const result = parseMessagesList(input);
    expect(result.messages).toEqual([{ id: "m1" }]);
    expect(result.nextPageToken).toBe("tok");
  });
});

describe("parseHistoryList", () => {
  test("returns empty object for null input", () => {
    expect(parseHistoryList(null)).toEqual({});
  });

  test("returns object for valid history shape", () => {
    const input: unknown = { history: [], historyId: "999" };
    const result = parseHistoryList(input);
    expect(result.historyId).toBe("999");
  });
});

// ---------------------------------------------------------------------------
// gmailFetchJson + fetchProfile — fetch override tests
// ---------------------------------------------------------------------------
describe("gmailFetchJson", () => {
  registerGlobalFetchRestore(afterEach);

  test("returns json and bytes on 200", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await gmailFetchJson(ctx, "tok", "https://gmail.googleapis.com/test");
    expect((result.json as Record<string, unknown>)["ok"]).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  test("throws on non-200 response (covers L101 indirectly via google-sync-shared)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ error: { code: 500, message: "internal" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(gmailFetchJson(ctx, "tok", "https://gmail.googleapis.com/test")).rejects.toThrow(
      "Gmail sync failed: 500",
    );
  });
});

describe("fetchProfile", () => {
  registerGlobalFetchRestore(afterEach);

  test("returns profile with emailAddress and historyId", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ emailAddress: "user@example.com", historyId: "42" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const profile = await fetchProfile(ctx, "tok");
    expect(profile.emailAddress).toBe("user@example.com");
    expect(profile.historyId).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// fetchMessageMetadataOrNullOn404 — branch coverage (L101 both arms)
// ---------------------------------------------------------------------------
describe("fetchMessageMetadataOrNullOn404", () => {
  registerGlobalFetchRestore(afterEach);

  test("returns null on 404 response (L101 true branch)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(
        JSON.stringify({ error: { code: 404, message: "Requested entity was not found." } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchMessageMetadataOrNullOn404(ctx, "tok", "msg-gone");
    expect(result).toBeNull();
  });

  test("rethrows non-404 errors (L101 false branch — throw e)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (_input: FetchInput) => {
      return new Response(JSON.stringify({ error: { code: 403, message: "Forbidden" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(fetchMessageMetadataOrNullOn404(ctx, "tok", "msg-forbidden")).rejects.toThrow(
      "403",
    );
  });

  test("returns resource on success", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("msg-ok")) {
        return new Response(
          JSON.stringify({
            id: "msg-ok",
            threadId: "th1",
            snippet: "hello",
            internalDate: "1700000000000",
            payload: { headers: [{ name: "Subject", value: "Test" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const result = await fetchMessageMetadataOrNullOn404(ctx, "tok", "msg-ok");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("msg-ok");
  });
});

// ---------------------------------------------------------------------------
// upsertGmailMessage — all uncovered branches (L145–L180)
// ---------------------------------------------------------------------------
describe("upsertGmailMessage", () => {
  test("returns early when id is undefined (L145 true branch — id undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {};
    upsertGmailMessage(ctx, m, Date.now());
    // No row should be inserted
    const row = db.query("SELECT id FROM item WHERE service = 'gmail'").get();
    expect(row).toBeNull();
  });

  test("returns early when id is empty string (L145 true branch — id '')", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = { id: "" };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db.query("SELECT id FROM item WHERE service = 'gmail'").get();
    expect(row).toBeNull();
  });

  test("uses (no subject) when Subject header absent (L148 ?? fallback)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-nosubj",
      payload: { headers: [] },
      snippet: "snip",
      internalDate: "1700000000000",
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-nosubj")) as { title: string } | null;
    expect(row?.title).toBe("(no subject)");
  });

  test("body_preview is '' when the payload carries no usable MIME part", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    // snippet is no longer read for the body — it is irrelevant here even
    // when malformed (number through unknown to satisfy no-any).
    const m = {
      id: "m-badsnip",
      snippet: 999,
      internalDate: "1700000000000",
      payload: { headers: [{ name: "Subject", value: "S" }] },
    } as unknown as GmailMessageResource;
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT body_preview FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-badsnip")) as { body_preview: string | null } | null;
    expect(row?.body_preview).toBe("");
  });

  test("a body longer than 512 chars has body_preview sliced", async () => {
    // body_preview is derived from the real MIME body (message-body.ts), not
    // the provider snippet, since the full-body indexing change — see
    // upsertIndexedItem's body_preview = clampBody(body, BODY_PREVIEW_MAX).
    const longBody = "x".repeat(600);
    const encoded = Buffer.from(longBody, "utf8").toString("base64url");
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-longbody",
      internalDate: "1700000000000",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "S" }],
        body: { data: encoded },
      },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT body_preview FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-longbody")) as { body_preview: string | null } | null;
    expect(row?.body_preview).toHaveLength(512);
  });

  test("subject longer than 512 chars is sliced (L173 true branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const longSubject = "A".repeat(600);
    const m: GmailMessageResource = {
      id: "m-longsubj",
      snippet: "snip",
      internalDate: "1700000000000",
      payload: { headers: [{ name: "Subject", value: longSubject }] },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-longsubj")) as { title: string } | null;
    expect(row?.title).toHaveLength(512);
  });

  test("uses now when internalDate is undefined (L150 true branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const now = 1_700_000_000_000;
    const m: GmailMessageResource = {
      id: "m-nodate",
      snippet: "snip",
      // internalDate intentionally omitted
      payload: { headers: [{ name: "Subject", value: "S" }] },
    };
    upsertGmailMessage(ctx, m, now);
    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-nodate")) as { modified_at: number } | null;
    expect(row?.modified_at).toBe(now);
  });

  test("uses now when internalDate is non-numeric (L151 false branch — not finite)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const now = 1_700_000_000_000;
    const m = {
      id: "m-badinternaldate",
      snippet: "snip",
      internalDate: "not-a-number",
      payload: { headers: [{ name: "Subject", value: "S" }] },
    } as unknown as GmailMessageResource;
    upsertGmailMessage(ctx, m, now);
    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-badinternaldate")) as { modified_at: number } | null;
    // Number("not-a-number") = NaN, not finite → fallback to now
    expect(row?.modified_at).toBe(now);
  });

  test("threadId '' when threadId is not a string (L152 false branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m = {
      id: "m-badthreadid",
      snippet: "snip",
      internalDate: "1700000000000",
      // threadId as number → non-string
      threadId: 99,
      payload: { headers: [{ name: "Subject", value: "S" }] },
    } as unknown as GmailMessageResource;
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT url FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-badthreadid")) as { url: string } | null;
    // threadId === '' → URL uses message id
    expect(row?.url).toContain("m-badthreadid");
    expect(row?.url).not.toContain("99");
  });

  test("URL uses threadId when threadId is non-empty string (L165 false branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-withthreadid",
      threadId: "th-real",
      snippet: "snip",
      internalDate: "1700000000000",
      payload: { headers: [{ name: "Subject", value: "S" }] },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT url, metadata FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-withthreadid")) as {
      url: string;
      metadata: string | null;
    } | null;
    expect(row?.url).toContain("th-real");
    // metadata threadId field is set (L180 false branch)
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["threadId"]).toBe("th-real");
  });

  test("metadata threadId is undefined when threadId is '' (L180 true branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m = {
      id: "m-nothreadid",
      // threadId will be coerced to '' via non-string
      snippet: "snip",
      internalDate: "1700000000000",
      payload: { headers: [{ name: "Subject", value: "S" }] },
    } as unknown as GmailMessageResource;
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT metadata FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-nothreadid")) as { metadata: string | null } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // threadId === '' → undefined in metadata
    expect(meta["threadId"]).toBeUndefined();
  });

  test("from email present → resolves authorId (L162 false branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-withauthor",
      threadId: "th-author",
      snippet: "snip",
      internalDate: "1700000000000",
      payload: {
        headers: [
          { name: "Subject", value: "S" },
          { name: "From", value: "Alice <alice@example.com>" },
        ],
      },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-withauthor")) as { author_id: string | null } | null;
    // email parsed → author_id should be set (non-null)
    expect(row?.author_id).not.toBeNull();
  });

  test("from header absent → authorId is null (L162 true branch — email undefined)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-noauthor",
      snippet: "snip",
      internalDate: "1700000000000",
      payload: { headers: [{ name: "Subject", value: "S" }] },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-noauthor")) as { author_id: string | null } | null;
    expect(row?.author_id).toBeNull();
  });

  test("from header with displayName included in resolvePersonForSync (L153 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("google", "gmail");
    const m: GmailMessageResource = {
      id: "m-displayname",
      snippet: "snip",
      internalDate: "1700000000000",
      payload: {
        headers: [
          { name: "Subject", value: "S" },
          // Name + email format triggers displayName code path in parseFromHeaderForPerson
          { name: "From", value: "Bob Smith <bob@example.com>" },
        ],
      },
    };
    upsertGmailMessage(ctx, m, Date.now());
    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("gmail", "m-displayname")) as { author_id: string | null } | null;
    expect(row?.author_id).not.toBeNull();
  });
});
