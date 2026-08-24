import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createFastmailSyncable } from "./fastmail-sync.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}): unknown {
  return {
    apiUrl: "https://jmap.fastmail.com/api/",
    primaryAccounts: {
      "urn:ietf:params:jmap:mail": "acct-123",
    },
    ...overrides,
  };
}

function makeEmailsResponse(emails: unknown[]): unknown {
  return {
    methodResponses: [
      ["Email/query", { accountId: "acct-123", ids: emails.map((_, i) => `id-${i}`) }, "q"],
      [
        "Email/get",
        {
          accountId: "acct-123",
          list: emails,
        },
        "e",
      ],
    ],
  };
}

function makeEmail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowMs = Date.now();
  const receivedAt = new Date(nowMs - 3600_000).toISOString();
  return {
    id: "email-abc-1",
    messageId: ["<msg-1@example.com>"],
    subject: "Hello World",
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "bob@example.com" }],
    cc: [],
    receivedAt,
    attachments: [],
    preview: "Short preview",
    textBody: [],
    bodyValues: {},
    ...overrides,
  };
}

/** Vault with api_token set but no custom base_url. */
function tokenVault(token = "fm-test-token"): ReturnType<typeof createStubVault> {
  return createStubVault({
    "fastmail.api_token": token,
    "fastmail.base_url": null,
  });
}

/** Two-call fetch fake: first call returns session JSON, second returns emails JSON. */
function twoCallFetch(
  sessionBody: unknown,
  emailsBody: unknown,
  sessionStatus = 200,
  emailsStatus = 200,
): typeof fetch {
  let callCount = 0;
  return (async (
    _input: SyncTestFetchParams[0],
    _init?: SyncTestFetchParams[1],
  ): Promise<Response> => {
    callCount++;
    if (callCount === 1) {
      return new Response(sessionStatus === 200 ? JSON.stringify(sessionBody) : "error", {
        status: sessionStatus,
      });
    }
    return new Response(emailsStatus === 200 ? JSON.stringify(emailsBody) : "error", {
      status: emailsStatus,
    });
  }) as typeof fetch;
}

/** A syncable with a no-op MCP runner. */
function makeSyncable() {
  return createFastmailSyncable({ ensureFastmailMcpRunning: async () => {} });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describeWithFetchRestore("fastmail-sync", () => {
  // ─── Missing credentials → noop ────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when api_token is missing",
    makeSyncable,
    createStubVault({ "fastmail.api_token": null }),
  );

  testConnectorSyncNoop(
    "no-op when api_token is empty string",
    makeSyncable,
    createStubVault({ "fastmail.api_token": "" }),
  );

  // ─── loadCreds: base_url present with trailing slash ────────────────────────
  test("trims trailing slash from custom base_url", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "fastmail.api_token": "tok",
      "fastmail.base_url": "https://custom.fastmail.example/",
    });
    const urls: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      urls.push(urlFromFetchInput(input));
      callCount++;
      return callCount === 1
        ? new Response(
            JSON.stringify(makeSession({ apiUrl: "https://custom.fastmail.example/jmap/api/" })),
            { status: 200 },
          )
        : new Response(JSON.stringify(makeEmailsResponse([])), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, vault, "fastmail"), null);
    expect(r.cursor).toContain("nimbus-fastmail1:");
    // The trailing slash in base_url must be trimmed → session endpoint has no `//`.
    expect(urls[0]).toBe("https://custom.fastmail.example/jmap/session");
  });

  // ─── loadCreds: base_url absent → uses DEFAULT_BASE_URL ────────────────────
  test("uses default base URL when base_url vault entry is absent", async () => {
    const db = createMemoryIndexDb();
    const urls: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      urls.push(urlFromFetchInput(input));
      callCount++;
      return callCount === 1
        ? new Response(JSON.stringify(makeSession()), { status: 200 })
        : new Response(JSON.stringify(makeEmailsResponse([])), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    // base_url absent → DEFAULT_BASE_URL (api.fastmail.com) is used for the session endpoint.
    expect(urls[0]).toBe("https://api.fastmail.com/jmap/session");
  });

  // ─── Session HTTP error → syncPassCursorHttpEmpty ───────────────────────────
  test("returns http-empty cursor when session endpoint returns HTTP error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
    expectServiceItemCount(db, "fastmail", 0);
  });

  // ─── Session parse error → syncPassCursorParseEmpty ────────────────────────
  test("returns parse-empty cursor when session response is not JSON", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json-at-all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Session returns non-object (null JSON) → parse-empty ──────────────────
  test("returns parse-empty when session body parses to JSON null", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("null", { status: 200 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Session missing apiUrl → parse-empty ──────────────────────────────────
  test("returns parse-empty when session has no apiUrl", async () => {
    const db = createMemoryIndexDb();
    // Session without apiUrl
    const badSession = {
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-123" },
      // no apiUrl
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(badSession), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Session missing primaryAccounts → parse-empty ─────────────────────────
  test("returns parse-empty when session has no primaryAccounts", async () => {
    const db = createMemoryIndexDb();
    const badSession = { apiUrl: "https://api.fastmail.com/jmap" };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(badSession), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Session missing accountId for mail capability → parse-empty ───────────
  test("returns parse-empty when session primaryAccounts lacks mail capability key", async () => {
    const db = createMemoryIndexDb();
    const badSession = {
      apiUrl: "https://api.fastmail.com/jmap",
      primaryAccounts: {
        "urn:ietf:params:jmap:core": "acct-core", // mail capability absent
      },
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(badSession), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Email query HTTP error → syncPassCursorHttpEmpty ──────────────────────
  test("returns http-empty cursor when email query returns HTTP error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = twoCallFetch(makeSession(), {}, 200, 503);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
    expectServiceItemCount(db, "fastmail", 0);
  });

  // ─── Email query parse error → syncPassCursorParseEmpty ────────────────────
  test("returns parse-empty cursor when email query response is not JSON", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(makeSession()), { status: 200 });
      }
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
  });

  // ─── Happy path: single email upserted ─────────────────────────────────────
  test("indexes a single email on happy path and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([makeEmail()]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-fastmail1:");
    expectServiceItemCount(db, "fastmail", 1);
  });

  // ─── Happy path: multiple emails ───────────────────────────────────────────
  test("indexes multiple emails and counts them all", async () => {
    const db = createMemoryIndexDb();
    const emails = [
      makeEmail({ id: "e1", messageId: ["<m1@x.com>"] }),
      makeEmail({ id: "e2", messageId: ["<m2@x.com>"] }),
      makeEmail({ id: "e3", messageId: ["<m3@x.com>"] }),
    ];
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse(emails));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "fastmail", 3);
  });

  // ─── extractEmails: no methodResponses → 0 emails ──────────────────────────
  test("returns 0 upserts when response has no methodResponses array", async () => {
    const db = createMemoryIndexDb();
    const noResponses = { something: "else" };
    globalThis.fetch = twoCallFetch(makeSession(), noResponses);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "fastmail", 0);
  });

  // ─── extractEmails: no "Email/get" entry → 0 emails ────────────────────────
  test("returns 0 upserts when methodResponses has no Email/get entry", async () => {
    const db = createMemoryIndexDb();
    const noEmailGet = {
      methodResponses: [
        ["Email/query", { ids: [] }, "q"],
        // no Email/get
      ],
    };
    globalThis.fetch = twoCallFetch(makeSession(), noEmailGet);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "fastmail", 0);
  });

  // ─── extractEmails: Email/get entry with non-array list → 0 ─────────────────
  test("returns 0 upserts when Email/get list is not an array", async () => {
    const db = createMemoryIndexDb();
    const badList = {
      methodResponses: [["Email/get", { list: "not-an-array" }, "e"]],
    };
    globalThis.fetch = twoCallFetch(makeSession(), badList);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── normalizeJmapEmail: both id and messageId absent → skipped ─────────────
  test("skips email when both id and messageId are absent", async () => {
    const db = createMemoryIndexDb();
    const badEmail = {
      // no id field, no messageId
      subject: "No ID email",
    };
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([badEmail]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "fastmail", 0);
  });

  // ─── normalizeJmapEmail: id empty string and no messageId → skipped ─────────
  test("skips email when id is empty string and messageId is absent", async () => {
    const db = createMemoryIndexDb();
    const badEmail = { id: "", subject: "Empty ID" };
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([badEmail]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── normalizeJmapEmail: messageId is not an array → null messageId ─────────
  test("handles email with messageId as non-array (uses null messageId)", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({ id: "e-nomsgid", messageId: "not-an-array" });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    // id is present so it should still index
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── normalizeJmapEmail: non-object raw → skipped ───────────────────────────
  test("skips non-object entries in Email/get list", async () => {
    const db = createMemoryIndexDb();
    const response = {
      methodResponses: [["Email/get", { list: ["not-an-object", 42, null, makeEmail()] }, "e"]],
    };
    globalThis.fetch = twoCallFetch(makeSession(), response);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    // Only the valid makeEmail() entry should be upserted
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── formatAddress: null record → empty string filtered ─────────────────────
  test("handles null/non-object 'from' entries (filtered from result)", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      from: [null, "not-an-object", { email: "real@example.com" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── formatAddress: name present, email empty → returns name only ───────────
  test("formats address as 'name' when name is present but email is empty", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      from: [{ name: "Alice", email: "" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'fastmail' LIMIT 1").get() as
      | { metadata: string }
      | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as { from: string[] };
    expect(meta.from[0]).toBe("Alice");
  });

  // ─── formatAddress: name absent → returns email only ───────────────────────
  test("formats address as 'email' only when name is absent", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      from: [{ email: "noreply@example.com" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'fastmail' LIMIT 1").get() as
      | { metadata: string }
      | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as { from: string[] };
    expect(meta.from[0]).toBe("noreply@example.com");
  });

  // ─── formatAddresses: not an array → empty ──────────────────────────────────
  test("handles non-array 'to' field (returns empty array)", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({ to: "not-an-array" });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractAttachments: not array → empty ──────────────────────────────────
  test("handles non-array attachments field (returns empty)", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({ attachments: "not-an-array" });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'fastmail' LIMIT 1").get() as
      | { metadata: string }
      | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as { attachmentCount: number };
    expect(meta.attachmentCount).toBe(0);
  });

  // ─── extractAttachments: null entry in array → null fields ──────────────────
  test("handles null entries in attachments array", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      attachments: [null, { name: "file.pdf", size: 1024, type: "application/pdf" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractAttachments: non-finite size → null sizeBytes ──────────────────
  test("treats non-finite attachment size as null sizeBytes", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      attachments: [{ name: "x.txt", size: Number.POSITIVE_INFINITY, type: "text/plain" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractAttachments: valid numeric size ─────────────────────────────────
  test("stores finite numeric attachment size correctly", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      attachments: [{ name: "doc.pdf", size: 2048, type: "application/pdf" }],
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'fastmail' LIMIT 1").get() as
      | { metadata: string }
      | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as {
      attachments: Array<{ sizeBytes: number | null }>;
    };
    expect(meta.attachments[0]?.sizeBytes).toBe(2048);
  });

  // ─── previewFor: textBody path ──────────────────────────────────────────────
  test("uses textBody body value as preview when present", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: "This is the body text." } },
      preview: "fallback preview",
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    expect(row?.body_preview).toContain("This is the body text.");
  });

  // ─── previewFor: textBody part empty value → falls through to preview ───────
  test("falls back to JMAP preview when textBody value is empty", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: "" } },
      preview: "JMAP server preview",
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    expect(row?.body_preview).toContain("JMAP server preview");
  });

  // ─── previewFor: textBody entry with no partId → skip ──────────────────────
  test("skips textBody parts with no partId and falls back to preview", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      textBody: [{ blobId: "blob-1" }], // no partId
      bodyValues: {},
      preview: "fallback preview text",
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    expect(row?.body_preview).toContain("fallback preview text");
  });

  // ─── previewFor: bodyValues is null → fallback to preview ──────────────────
  test("uses JMAP preview when bodyValues is null", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({
      textBody: [{ partId: "1" }],
      bodyValues: null,
      preview: "null bodyValues preview",
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    expect(row?.body_preview).toContain("null bodyValues preview");
  });

  // ─── capPreview: long text is truncated ─────────────────────────────────────
  test("truncates preview text longer than 2000 characters", async () => {
    const db = createMemoryIndexDb();
    const longBody = "A".repeat(3000);
    const email = makeEmail({
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: longBody } },
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    // Should be capped at 2000 chars
    expect((row?.body_preview ?? "").length).toBeLessThanOrEqual(2000);
  });

  // ─── capPreview: whitespace normalization ────────────────────────────────────
  test("normalizes whitespace in preview (collapses spaces and blank lines)", async () => {
    const db = createMemoryIndexDb();
    const messyBody = "Hello  world\r\n\r\nNew paragraph\t  with tabs";
    const email = makeEmail({
      textBody: [{ partId: "1" }],
      bodyValues: { "1": { value: messyBody } },
    });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT body_preview FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { body_preview: string } | undefined;
    const preview = row?.body_preview ?? "";
    expect(preview).not.toContain("  "); // no double spaces
    expect(preview).not.toContain("\r\n"); // no CRLF
  });

  // ─── cursor is passed through on each call ──────────────────────────────────
  test("returns a fastmail cursor on success regardless of input cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([]));

    const sync = makeSyncable();
    // Pass an existing cursor — it's stored but fastmail always returns pass1Cursor
    const r = await sync.sync(
      syncTestContext(db, tokenVault(), "fastmail"),
      "nimbus-fastmail1:previous",
    );
    expect(r.cursor).toContain("nimbus-fastmail1:");
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── Authorization header is sent ───────────────────────────────────────────
  test("sends Bearer token in Authorization header for session and query", async () => {
    const db = createMemoryIndexDb();
    const capturedHeaders: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount++;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.["Authorization"]) {
        capturedHeaders.push(headers["Authorization"]);
      }
      if (callCount === 1) {
        return new Response(JSON.stringify(makeSession()), { status: 200 });
      }
      return new Response(JSON.stringify(makeEmailsResponse([makeEmail()])), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault("my-secret-token"), "fastmail"), null);
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    for (const h of capturedHeaders) {
      expect(h).toBe("Bearer my-secret-token");
    }
    // Vault non-leak: the secret token must never escape into the returned cursor
    // or any persisted item row (title/body/metadata/url).
    expect(r.cursor ?? "").not.toContain("my-secret-token");
    const rows = db
      .query(`SELECT title, body_preview, metadata, url, canonical_url FROM item`)
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("my-secret-token");
    }
  });

  // ─── extractEmails: methodResponses entries that are not arrays are skipped ──
  test("skips non-array methodResponse entries when extracting emails", async () => {
    const db = createMemoryIndexDb();
    const response = {
      methodResponses: ["not-an-array-entry", ["Email/get", { list: [makeEmail()] }, "e"]],
    };
    globalThis.fetch = twoCallFetch(makeSession(), response);

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── mapFastmailEmailToItem: null mapped item skipped ───────────────────────
  test("skips emails that map to null (both id and messageId empty after normalize)", async () => {
    const db = createMemoryIndexDb();
    // An email with id="" and messageId=[""] — asString returns null for empty string
    // normalizeJmapEmail: id = asString("") = null; messageIdArr = [""]; asString("") = null
    // So both id and messageId are null → return null → skipped
    const badEmail = {
      id: "",
      messageId: [""],
      subject: "Bad email",
      from: [],
      to: [],
      receivedAt: new Date(Date.now() - 1000).toISOString(),
      attachments: [],
      preview: "",
    };
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([badEmail]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── Email with only messageId (no JMAP id) ─────────────────────────────────
  test("indexes email that has messageId but no JMAP id", async () => {
    const db = createMemoryIndexDb();
    const email = {
      // no id field
      messageId: ["<unique-msg-id@domain.com>"],
      subject: "Only message-id",
      from: [{ name: "Sender", email: "s@d.com" }],
      to: [],
      receivedAt: new Date(Date.now() - 7200_000).toISOString(),
      attachments: [],
      preview: "preview",
    };
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── Email with cc field absent ──────────────────────────────────────────────
  test("indexes email without cc field (absent is treated as empty)", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({ cc: undefined });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── Email receivedAt absent → uses syncedAt ────────────────────────────────
  test("uses syncedAt as modifiedAt when receivedAt is absent", async () => {
    const db = createMemoryIndexDb();
    const email = makeEmail({ receivedAt: undefined });
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([email]));

    const beforeSync = Date.now();
    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    const afterSync = Date.now();
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'fastmail' LIMIT 1")
      .get() as { modified_at: number } | undefined;
    expect(row?.modified_at).toBeGreaterThanOrEqual(beforeSync - 1000);
    expect(row?.modified_at).toBeLessThanOrEqual(afterSync + 1000);
  });

  // ─── Empty email list → 0 upserts but cursor advances ───────────────────────
  test("returns success cursor with 0 upserts for empty email list", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = twoCallFetch(makeSession(), makeEmailsResponse([]));

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, tokenVault(), "fastmail"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-fastmail1:");
    expectServiceItemCount(db, "fastmail", 0);
  });
});
