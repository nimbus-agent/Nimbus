import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../index/item-store.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createOutlookSyncable,
  decodeOutlookSyncCursor,
  encodeOutlookSyncCursor,
  type OutlookSyncCursorV1,
} from "./outlook-sync.ts";

type FetchInput = string | URL | Request;

/** Builds a minimal Graph delta response with a deltaLink (no more pages). */
function deltaResponse(messages: unknown[]): Response {
  return new Response(
    JSON.stringify({
      value: messages,
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?token=end",
    }),
    { status: 200 },
  );
}

describe("Outlook sync cursor codec", () => {
  test("round-trip", () => {
    const samples: OutlookSyncCursorV1[] = [
      { v: 1, nextUrl: null },
      { v: 1, nextUrl: "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=a" },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeOutlookSyncCursor,
      decodeOutlookSyncCursor,
      "nimbus-outl2:",
    );
  });
});

describe("createOutlookSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  // ── existing smoke test ───────────────────────────────────────────────────
  test("indexes messages from delta page", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "m1",
                subject: "Hi",
                bodyPreview: "Hello",
                lastModifiedDateTime: "2024-05-01T10:00:00Z",
                webLink: "https://outlook.office.com/m1",
                from: {
                  emailAddress: { name: "Sender", address: "sender@example.com" },
                },
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?token=z",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(false);

    const row = db
      .query("SELECT service, type, author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "m1")) as
      | { service: string; type: string; author_id: string | null }
      | undefined;
    expect(row?.service).toBe("outlook");
    expect(row?.type).toBe("email");
    expect(row?.author_id).not.toBeNull();
  });

  // ── L43: message with undefined id is skipped (id === undefined) ──────────
  // The upserted counter is incremented for every non-removed entry even when
  // upsertMessage returns early; verify via DB that no row was written for it.
  test("skips message with undefined id — no DB row written", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          { subject: "No id here", bodyPreview: "body" }, // no id field → upsertMessage returns early
          {
            id: "valid1",
            subject: "Valid",
            bodyPreview: "ok",
            lastModifiedDateTime: "2024-05-01T10:00:00Z",
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    // valid1 must be in the DB
    const validRow = db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "valid1")) as { id: string } | null;
    expect(validRow).not.toBeNull();

    // No row should exist for the no-id message (no externalId to key on)
    const allRows = db.query("SELECT id FROM item").all() as { id: string }[];
    expect(allRows).toHaveLength(1);
  });

  // ── L43: message with empty-string id is skipped (id === "") ─────────────
  test("skips message with empty-string id — no DB row written", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          { id: "", subject: "Empty id" }, // id === "" → upsertMessage returns early
          { id: "valid2", subject: "Valid" },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    // Only valid2 should be in the DB
    const allRows = db.query("SELECT id FROM item").all() as { id: string }[];
    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.id).toBe(itemPrimaryKey("outlook", "valid2"));
  });

  // ── L46: missing subject → "(no subject)" ────────────────────────────────
  test("falls back to (no subject) when subject is missing", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "nosub", lastModifiedDateTime: "2024-05-01T10:00:00Z" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "nosub")) as { title: string } | undefined;
    expect(row?.title).toBe("(no subject)");
  });

  // ── L46: empty-string subject → "(no subject)" ───────────────────────────
  test("falls back to (no subject) when subject is empty string", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "empsub", subject: "" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "empsub")) as { title: string } | undefined;
    expect(row?.title).toBe("(no subject)");
  });

  // ── L47: missing bodyPreview → empty string in db ────────────────────────
  test("stores empty preview when bodyPreview is absent", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "nobody", subject: "Test" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT body_preview FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "nobody")) as { body_preview: string | null } | undefined;
    expect(row?.body_preview ?? "").toBe("");
  });

  // ── L48: missing webLink → null url ──────────────────────────────────────
  test("stores null url when webLink is absent", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "nolink", subject: "No link" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT url FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "nolink")) as { url: string | null } | undefined;
    expect(row?.url).toBeNull();
  });

  // ── L49: lastModifiedDateTime missing → fall back to receivedDateTime ────
  test("uses receivedDateTime when lastModifiedDateTime is absent", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          { id: "recv1", subject: "Received only", receivedDateTime: "2024-03-01T08:00:00Z" },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT modified_at FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "recv1")) as { modified_at: number } | undefined;
    // 2024-03-01T08:00:00Z → 1709280000000
    expect(row?.modified_at).toBe(Date.parse("2024-03-01T08:00:00Z"));
  });

  // ── L53: missing from address → null authorId ────────────────────────────
  test("stores null authorId when from address is absent", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "nofrom", subject: "No from" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "nofrom")) as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ── L53: empty-string from address → null authorId ───────────────────────
  test("stores null authorId when from address is empty string", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          { id: "emptyfrom", subject: "Empty addr", from: { emailAddress: { address: "" } } },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "emptyfrom")) as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ── L56: address present but name missing → addr used as displayName ─────
  test("uses email address as displayName when name is absent", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "noname",
            subject: "No name",
            from: { emailAddress: { address: "noname@example.com" } }, // name omitted
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "noname")) as { author_id: string | null } | undefined;
    expect(row?.author_id).not.toBeNull(); // person resolved using addr as name
  });

  // ── L56: address present but name is empty string → addr used as displayName
  test("uses email address as displayName when name is empty string", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "emptyname",
            subject: "Empty name",
            from: { emailAddress: { address: "emptyname@example.com", name: "" } },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "emptyname")) as { author_id: string | null } | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ── L64: very long subject gets truncated to 512 chars ───────────────────
  test("truncates subject longer than 512 chars", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const longSubject = "A".repeat(600);

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "longsubj", subject: longSubject }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "longsubj")) as { title: string } | undefined;
    expect(row?.title).toHaveLength(512);
    expect(row?.title).toBe("A".repeat(512));
  });

  // ── L93: null cursor → no delta decode, uses initial URL ─────────────────
  test("null cursor triggers initial sync URL (not nextUrl)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrls.push(url);
      if (url.includes("/messages/delta")) {
        return deltaResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    // Should have hit the initial /me/messages/delta URL
    expect(capturedUrls.some((u) => u.includes("/me/messages/delta?$top="))).toBe(true);
  });

  // ── L93: empty-string cursor → treated same as null (no decode) ──────────
  test("empty-string cursor triggers initial sync URL", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrls.push(url);
      if (url.includes("/messages/delta")) {
        return deltaResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, "");

    expect(capturedUrls.some((u) => u.includes("/me/messages/delta?$top="))).toBe(true);
  });

  // ── L95: valid cursor with a nextUrl → uses that URL as the page URL ─────
  test("valid cursor uses stored nextUrl for continuation", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const nextUrl = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=continuation123";
    const cursor = encodeOutlookSyncCursor({ v: 1, nextUrl });

    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrls.push(url);
      return deltaResponse([]);
    }) as typeof fetch;

    await syncable.sync(ctx, cursor);

    expect(capturedUrls.some((u) => u.includes("continuation123"))).toBe(true);
  });

  // ── L95: cursor with invalid prefix → dec undefined → nextUrl falls to null
  test("cursor with wrong prefix is ignored, falls back to initial URL", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    // Wrong prefix — decodeOutlookSyncCursor returns undefined
    const badCursor = "nimbus-OTHER:abc123";

    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrls.push(url);
      if (url.includes("/messages/delta")) {
        return deltaResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, badCursor);

    // Should fall back to the initial ?$top= URL, not the bad cursor
    expect(capturedUrls.some((u) => u.includes("/me/messages/delta?$top="))).toBe(true);
  });

  // ── L106: empty value array → 0 upserted ─────────────────────────────────
  test("returns 0 upserted when value array is empty", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([]); // empty value
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
  });

  // ── L106: response without value key → 0 upserted ────────────────────────
  test("returns 0 upserted when value key is absent from response", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        // No value key at all
        return new Response(
          JSON.stringify({
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?token=end",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ── L112/L114: removed message with valid id → deleted, not upserted ─────
  test("deletes message marked with @removed", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    // First upsert the message so it exists in the db
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "todelete", subject: "Will be deleted" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r1 = await syncable.sync(ctx, null);
    expect(r1.itemsUpserted).toBe(1);

    // Now send the same id as removed
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([{ id: "todelete", "@removed": { reason: "deleted" } }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r2 = await syncable.sync(ctx, null);
    expect(r2.itemsDeleted).toBe(1);
    expect(r2.itemsUpserted).toBe(0);

    const row = db
      .query("SELECT id FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "todelete")) as { id: string } | null;
    expect(row).toBeNull();
  });

  // ── L114: @removed entry with undefined id → delete branch NOT taken ────────
  // removed=true but id=undefined: the `if (removed && id !== undefined && id !== "")`
  // guard is false, so deleteItemByServiceExternal is NOT called (itemsDeleted stays 0).
  test("@removed entry with undefined id does not trigger delete", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          { "@removed": { reason: "deleted" } }, // no id: remove-guard fails, no delete
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    // No delete should have fired
    expect(r.itemsDeleted).toBe(0);
    // No rows should be in the DB (upsertMessage returns early for undefined id)
    const allRows = db.query("SELECT id FROM item").all() as { id: string }[];
    expect(allRows).toHaveLength(0);
  });

  // ── pagination: nextLink present → hasMore = true, cursor stored ──────────
  test("returns hasMore=true and stores nextLink cursor when nextLink present", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const nextLink = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=page2";

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "pg1msg", subject: "Page 1" }],
            "@odata.nextLink": nextLink,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.hasMore).toBe(true);
    expect(r.itemsUpserted).toBe(1);

    const dec = decodeOutlookSyncCursor(r.cursor ?? "");
    expect(dec?.nextUrl).toBe(nextLink);
  });

  // ── cursor with null nextUrl → dec.nextUrl is null → fallback to initial ─
  test("cursor with null nextUrl falls back to initial URL", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const cursor = encodeOutlookSyncCursor({ v: 1, nextUrl: null });

    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrls.push(url);
      return deltaResponse([]);
    }) as typeof fetch;

    await syncable.sync(ctx, cursor);

    // null nextUrl means no continuation, should use the default initial URL
    expect(capturedUrls.some((u) => u.includes("/me/messages/delta?$top="))).toBe(true);
  });

  // ── real Graph `body` indexing (Task 5) ───────────────────────────────────

  test("indexes the Graph body with the quoted tail stripped", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "htmlbody",
            subject: "Ship it",
            body: { contentType: "html", content: "<p>Ship it.</p><p>On Mon, Ana wrote:</p>" },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT body FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "htmlbody")) as { body: string } | undefined;
    expect(row?.body).toBe("Ship it.");
  });

  test("contentType text passes through without HTML stripping", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    // "plain & simple" is a FIXED POINT of plainTextFromHtmlLines (no tags, no
    // newlines, no whitespace runs) -- it round-trips identically whether or
    // not the text arm is (wrongly) routed through the html path, so it can't
    // discriminate. A fixture with a real newline can: plainTextFromHtmlLines's
    // first step neutralises every source newline to a space, so if the text
    // arm were ever routed through it, "line one\nline two" would come back as
    // "line one line two" instead of unchanged.
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "textbody",
            subject: "Plain",
            body: { contentType: "text", content: "line one\nline two" },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT body FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "textbody")) as { body: string } | undefined;
    expect(row?.body).toBe("line one\nline two");
  });

  // A REPRESENTATIVE input rather than a fragment shaped to the code: what
  // Graph actually returns for a Word-composed Outlook reply — a complete
  // HTML document with a `<head><style>` block of `mso-` CSS, `&nbsp;`
  // padding, an `&lt;`-escaped comparison in the prose, the underscore
  // divider, and a quoted header block. Every other consumer of the shared
  // HTML helpers is handed a FRAGMENT, so Outlook is the first caller that
  // ever sees `<head>`/`<style>` at all.
  const WORD_HTML_REPLY = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
    "<head>",
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    '<style type="text/css"><!--',
    '@font-face{font-family:"Cambria Math";panose-1:2 4 5 3 5 4 6 3 2 4;}',
    "p.MsoNormal, li.MsoNormal, div.MsoNormal",
    "{mso-style-unhide:no;mso-style-qformat:yes;margin:0cm;font-size:11.0pt;",
    'font-family:"Calibri",sans-serif;mso-fareast-language:EN-US;}',
    "a:link, span.MsoHyperlink{mso-style-priority:99;color:#0563C1;}",
    "--></style>",
    "</head>",
    '<body lang="EN-GB" link="#0563C1">',
    '<div class="WordSection1">',
    '<p class="MsoNormal">Approved &#8212; ship it.&nbsp;&nbsp;Note the guard only fires when',
    "latency &lt; 200ms.<o:p></o:p></p>",
    '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>',
    '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">',
    `<p class="MsoNormal">${"_".repeat(38)}<o:p></o:p></p>`,
    '<p class="MsoNormal"><b>From:</b> Ana Ruiz &lt;ana@example.com&gt;<br>',
    "<b>Sent:</b> 04 August 2026 09:14<br>",
    "<b>To:</b> Bo Lin &lt;bo@example.com&gt;<br>",
    "<b>Subject:</b> Re: rollout guard<o:p></o:p></p>",
    '<p class="MsoNormal">Can we ship the guard on Tuesday?<o:p></o:p></p>',
    "</div></div></body></html>",
  ].join("\r\n");

  test("a Word-composed HTML document indexes its prose, not its mso- CSS", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "word1",
            subject: "Re: rollout guard",
            bodyPreview: "Approved — ship it.",
            body: { contentType: "html", content: WORD_HTML_REPLY },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT body, body_complete FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "word1")) as
      | { body: string; body_complete: number }
      | undefined;
    const body = row?.body ?? "";

    // The CSS must not reach the index: it lands AHEAD of the prose, eats the
    // 16 KiB cap, and pollutes item_fts / the glossary miner / the decisions
    // extractor with style tokens.
    expect(body).not.toContain("mso-style-unhide");
    expect(body).not.toContain("font-family");
    expect(body).not.toContain("Cambria Math");
    // Entities decoded: `&nbsp;` padding normalised, `&#8212;` and `&lt;`
    // rendered. Before this branch Outlook indexed Graph's already-decoded
    // `bodyPreview`, so leaving them raw was a body-quality regression.
    expect(body).toContain("Approved — ship it. Note the guard only fires when latency < 200ms.");
    expect(body).not.toContain("&nbsp;");
    // The quoted reply chain below the divider is stripped, and the divider
    // here IS followed by a From:/Sent: header block, so it is genuinely
    // terminal.
    expect(body).not.toContain("Can we ship the guard on Tuesday?");
    expect(body).not.toContain("From:");
    expect(row?.body_complete).toBe(1);
  });

  test("a body-less message keeps Graph's bodyPreview instead of discarding it", async () => {
    // `$select` already fetches `bodyPreview`, so throwing it away bought
    // nothing: the `bodyPreview` arm gives `body_complete = 0` either way,
    // and keeping the ~255-char preview keeps the message searchable.
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        return deltaResponse([
          {
            id: "prevonly",
            subject: "Invoice attached",
            bodyPreview: "Please find the September invoice attached.",
            // An attachment-only message: Graph returns an empty body.
            body: { contentType: "html", content: "" },
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT body_preview, body_complete FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "prevonly")) as
      | { body_preview: string | null; body_complete: number }
      | undefined;
    expect(row?.body_preview).toBe("Please find the September invoice attached.");
    expect(row?.body_complete).toBe(0);
  });

  test("a message with no body still indexes title-only", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/messages/delta")) {
        // Pre-upgrade delta-link shape: no `body` field on the message at all.
        return deltaResponse([{ id: "nobody2", subject: "No body field" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT body_complete FROM item WHERE id = ?")
      .get(itemPrimaryKey("outlook", "nobody2")) as { body_complete: number } | undefined;
    expect(row?.body_complete).toBe(0);
  });

  test("$select including body is on the initial delta request", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    let seenUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      seenUrl = url;
      if (url.includes("/messages/delta")) {
        return deltaResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    expect(seenUrl).toContain("$select=");
    expect(decodeURIComponent(seenUrl)).toContain("body");
  });

  test("$select is NOT re-appended to a followed nextLink", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const storedNextLink =
      "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=continuePage";
    const cursor = encodeOutlookSyncCursor({ v: 1, nextUrl: storedNextLink });

    let seenUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      seenUrl = url;
      return deltaResponse([]);
    }) as typeof fetch;

    await syncable.sync(ctx, cursor);

    expect(seenUrl).toBe(storedNextLink);
  });

  test("a pre-upgrade outl1 cursor is ignored and the initial delta URL is used", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft");
    const syncable = createOutlookSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    // Built with the OLD "nimbus-outl1:" prefix — must decode to undefined
    // under the bumped "nimbus-outl2:" CURSOR_PREFIX and fall through to the
    // initial (i.e. $select-bearing) request URL.
    const oldPrefixCursor = `nimbus-outl1:${Buffer.from(
      JSON.stringify({ v: 1, nextUrl: "https://graph.microsoft.com/v1.0/me/messages/delta?x=1" }),
    ).toString("base64url")}`;

    let seenUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      seenUrl = url;
      if (url.includes("/messages/delta")) {
        return deltaResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, oldPrefixCursor);

    expect(seenUrl).toContain("/me/messages/delta");
    expect(decodeURIComponent(seenUrl)).toContain("body");
  });
});
