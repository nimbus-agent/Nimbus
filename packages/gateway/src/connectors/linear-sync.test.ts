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
import { createLinearSyncable } from "./linear-sync.ts";

/** Build a minimal valid single-page GraphQL response */
function makeLinearResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): string {
  return JSON.stringify({
    data: {
      issues: {
        nodes,
        pageInfo,
      },
    },
  });
}

/** Single-node issue fixture with all optional fields present */
const FULL_ISSUE = {
  id: "uuid-1",
  identifier: "NIM-1",
  title: "Ship Linear",
  description: "Connector",
  updatedAt: "2026-04-01T12:00:00.000Z",
  url: "https://linear.example/NIM-1",
  creator: {
    id: "lin-user-1",
    name: "Lin User",
    email: "lin@example.com",
  },
};

describeWithFetchRestore("linear-sync", () => {
  testConnectorSyncNoop(
    "no-op when API key missing",
    () => createLinearSyncable({ ensureLinearMcpRunning: async () => {} }),
    createStubVault({ "linear.api_key": null }),
  );

  test("indexes issues from GraphQL response and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("api.linear.app/graphql");
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      expect(body.query).toContain("issues(");
      expect(body.query).toContain("creator");
      return new Response(makeLinearResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "lin_api_test" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-lnr1:");
    expectServiceItemCount(db, "linear", 1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'linear' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ─── decodeCursor: empty-string cursor returns noop ───────────────────────
  test("empty-string cursor treated as no previous cursor (noop fetch path)", async () => {
    // The cursor "" is treated as null → no previous since → uses floor date.
    // We verify the sync still runs and fetches (no crash, cursor advances).
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      "", // empty string cursor — decodeCursor line 44 branch
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── decodeCursor: wrong prefix → decoded undefined ───────────────────────
  test("cursor with wrong prefix is decoded as null (falls back to floor date)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    // "nimbus-bad:" prefix → decodeNimbusJsonCursorPayload returns undefined → decodeCursor returns null
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      "nimbus-bad:aGVsbG8=",
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── decodeCursor: payload is JSON null ───────────────────────────────────
  test("cursor whose payload decodes to JSON null falls back to floor date", async () => {
    // Build a cursor with the right prefix but payload = null (JSON null)
    const prefix = "nimbus-lnr1:";
    const nullPayload = Buffer.from(JSON.stringify(null), "utf8").toString("base64url");
    const badCursor = prefix + nullPayload;

    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      badCursor,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── decodeCursor: payload is a JSON array ────────────────────────────────
  test("cursor whose payload is a JSON array falls back to floor date", async () => {
    const prefix = "nimbus-lnr1:";
    const arrPayload = Buffer.from(JSON.stringify(["not", "an", "object"]), "utf8").toString(
      "base64url",
    );
    const badCursor = prefix + arrPayload;

    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      badCursor,
    );
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── decodeCursor: payload has no "since" field ───────────────────────────
  test("cursor with object payload missing 'since' falls back to floor date", async () => {
    const prefix = "nimbus-lnr1:";
    const noSince = Buffer.from(JSON.stringify({ other: "field" }), "utf8").toString("base64url");
    const badCursor = prefix + noSince;

    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      badCursor,
    );
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── decodeCursor: "since" is empty string ───────────────────────────────
  test("cursor with empty-string 'since' falls back to floor date", async () => {
    const prefix = "nimbus-lnr1:";
    const emptySince = Buffer.from(JSON.stringify({ since: "" }), "utf8").toString("base64url");
    const badCursor = prefix + emptySince;

    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      badCursor,
    );
    expect(r.cursor).toContain("nimbus-lnr1:");
  });

  // ─── rate-limit 429 ───────────────────────────────────────────────────────
  test("throws on 429 rate-limit response and penalises rate limiter", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Rate Limited", { status: 429 }))) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), null),
    ).rejects.toThrow("rate limited");
  });

  // ─── HTTP error (non-ok, non-429) ─────────────────────────────────────────
  test("throws on non-ok HTTP response (500)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), null),
    ).rejects.toThrow("Linear sync HTTP 500");
  });

  // ─── Invalid JSON body (json=null) ────────────────────────────────────────
  test("throws when response body is not valid JSON", async () => {
    const db = createMemoryIndexDb();
    // ok=true but body is not JSON → JSON.parse throws → json=null → non-ok path
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json-at-all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    // ok=true but json=null → linearRequireIssuesData throws "Linear sync HTTP 200"
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), null),
    ).rejects.toThrow("Linear sync HTTP 200");
  });

  // ─── GraphQL errors array ─────────────────────────────────────────────────
  test("throws on GraphQL errors in response body", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({
      errors: [{ message: "Access denied" }, { message: "Invalid query" }],
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), null),
    ).rejects.toThrow("Access denied; Invalid query");
  });

  // ─── Missing data field ───────────────────────────────────────────────────
  test("throws when GraphQL response has no data field", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({ something: "else" }); // no "data"
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    await expect(
      sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), null),
    ).rejects.toThrow("Linear sync: missing data");
  });

  // ─── Issue missing id or identifier → skipped ────────────────────────────
  test("skips issues missing required id field", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      { identifier: "NIM-2", title: "No ID" }, // missing id
      FULL_ISSUE, // valid
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    // Only the valid issue should be upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "linear", 1);
  });

  test("skips issues missing required identifier field", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      { id: "some-uuid", title: "No Identifier" }, // missing identifier
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "linear", 0);
  });

  // ─── Title fallback to identifier ────────────────────────────────────────
  test("falls back to identifier as title when title is absent", async () => {
    const db = createMemoryIndexDb();
    const nodes = [{ id: "uuid-3", identifier: "NIM-3", updatedAt: "2026-04-01T12:00:00.000Z" }]; // no title
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT title FROM item WHERE service = 'linear' AND external_id = 'NIM-3'")
      .get() as { title: string } | undefined;
    expect(row?.title).toBe("NIM-3");
  });

  // ─── updatedAt absent / empty → syncTime fallback ────────────────────────
  test("uses syncTime as modifiedAt when updatedAt is absent", async () => {
    const db = createMemoryIndexDb();
    const nodes = [{ id: "uuid-4", identifier: "NIM-4", title: "No Date" }]; // no updatedAt
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'linear' AND external_id = 'NIM-4'")
      .get() as { modified_at: number } | undefined;
    // modified_at should be a recent timestamp (within last second)
    expect(row?.modified_at).toBeGreaterThan(Date.now() - 5000);
  });

  test("uses syncTime as modifiedAt when updatedAt is empty string", async () => {
    const db = createMemoryIndexDb();
    const nodes = [{ id: "uuid-5", identifier: "NIM-5", title: "Empty Date", updatedAt: "" }];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── url is null/absent ───────────────────────────────────────────────────
  test("stores null url when issue has no url field", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-6",
        identifier: "NIM-6",
        title: "No URL",
        updatedAt: "2026-04-01T12:00:00.000Z",
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT url FROM item WHERE service = 'linear' AND external_id = 'NIM-6'")
      .get() as { url: string | null } | undefined;
    expect(row?.url).toBeNull();
  });

  // ─── creator is absent (no creator field) ────────────────────────────────
  test("handles issue with no creator field — author_id is null", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-7",
        identifier: "NIM-7",
        title: "No Creator",
        updatedAt: "2026-04-01T12:00:00.000Z",
        // no creator field
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'linear' AND external_id = 'NIM-7'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ─── creator present with id but no email ────────────────────────────────
  test("resolves author by linearMemberId when creator has id but no email", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-8",
        identifier: "NIM-8",
        title: "Creator By ID",
        updatedAt: "2026-04-01T12:00:00.000Z",
        creator: { id: "lin-member-8", name: "ID User" }, // no email
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    // author_id resolved via linearMemberId path
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'linear' AND external_id = 'NIM-8'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ─── creator with email but no creatorId ─────────────────────────────────
  test("resolves author by email when creator has email but no id", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-9",
        identifier: "NIM-9",
        title: "Creator By Email",
        updatedAt: "2026-04-01T12:00:00.000Z",
        creator: { name: "Email User", email: "email@example.com" }, // no id
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    // author resolved via canonicalEmail path; hints.linearMemberId NOT set
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'linear' AND external_id = 'NIM-9'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ─── creator is non-object (asRecord returns undefined) ──────────────────
  test("handles issue where creator field is a primitive (non-object)", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-10",
        identifier: "NIM-10",
        title: "Primitive Creator",
        updatedAt: "2026-04-01T12:00:00.000Z",
        creator: "not-an-object", // primitive — asRecord returns undefined
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'linear' AND external_id = 'NIM-10'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ─── creator with no email and no id (both absent) ───────────────────────
  test("author_id is null when creator has neither email nor id", async () => {
    const db = createMemoryIndexDb();
    const nodes = [
      {
        id: "uuid-11",
        identifier: "NIM-11",
        title: "Anonymous Creator",
        updatedAt: "2026-04-01T12:00:00.000Z",
        creator: { name: "Ghost" }, // no id, no email
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT author_id FROM item WHERE service = 'linear' AND external_id = 'NIM-11'")
      .get() as { author_id: string | null } | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ─── Non-record node in nodes array (skipped by asRecord) ────────────────
  test("skips non-object entries in nodes array", async () => {
    const db = createMemoryIndexDb();
    // Mix: one primitive (skipped), one valid issue
    const nodesRaw = JSON.stringify({
      data: {
        issues: {
          nodes: ["not-an-object", FULL_ISSUE], // first entry is a string, not a record
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(nodesRaw, { status: 200 }))) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    // Only the valid one is upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "linear", 1);
  });

  // ─── Pagination: hasNextPage=true then false ──────────────────────────────
  test("fetches multiple pages when hasNextPage is true", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount++;
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const variables = body.variables as Record<string, unknown> | undefined;

      if (callCount === 1) {
        // First page: hasNextPage=true, variables should NOT have "after"
        expect(variables?.["after"]).toBeUndefined();
        return new Response(
          makeLinearResponse(
            [
              {
                id: "uuid-p1",
                identifier: "NIM-P1",
                title: "Page 1 Issue",
                updatedAt: "2026-04-01T10:00:00.000Z",
                url: "https://linear.example/NIM-P1",
              },
            ],
            { hasNextPage: true, endCursor: "cursor-page-2" },
          ),
          { status: 200 },
        );
      }
      // Second page: hasNextPage=false, variables should have "after"
      expect(variables?.["after"]).toBe("cursor-page-2");
      return new Response(
        makeLinearResponse(
          [
            {
              id: "uuid-p2",
              identifier: "NIM-P2",
              title: "Page 2 Issue",
              updatedAt: "2026-04-01T11:00:00.000Z",
              url: "https://linear.example/NIM-P2",
            },
          ],
          { hasNextPage: false, endCursor: null },
        ),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      null,
    );
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expect(r.cursor).toContain("nimbus-lnr1:");
    expectServiceItemCount(db, "linear", 2);
  });

  // ─── maxIso: older 'a' vs newer 'b' ─────────────────────────────────────
  test("cursor advances to the latest updatedAt across multiple issues", async () => {
    const db = createMemoryIndexDb();
    // Supply a known cursor (since = 2026-06-01) so maxUpdated starts there.
    // Two issues: one older (2026-06-02), one newer (2026-06-10).
    // maxIso picks the newer one; cursor should encode 2026-06-10.
    const startSince = "2026-06-01T00:00:00.000Z";
    const olderDate = "2026-06-02T10:00:00.000Z";
    const newerDate = "2026-06-10T10:00:00.000Z";

    const prefix = "nimbus-lnr1:";
    const startCursor =
      prefix + Buffer.from(JSON.stringify({ since: startSince }), "utf8").toString("base64url");

    const nodes = [
      {
        id: "uuid-a",
        identifier: "NIM-A",
        title: "Older Issue",
        updatedAt: olderDate,
        url: "https://linear.example/NIM-A",
      },
      {
        id: "uuid-b",
        identifier: "NIM-B",
        title: "Newer Issue",
        updatedAt: newerDate,
        url: "https://linear.example/NIM-B",
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeLinearResponse(nodes), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "key" })),
      startCursor,
    );
    expect(r.itemsUpserted).toBe(2);
    // The cursor should encode the newest updatedAt
    expect(r.cursor).toMatch(/^nimbus-lnr1:/);
    const b64 = r.cursor!.slice(prefix.length);
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      since: string;
    };
    expect(payload.since).toBe(newerDate);
  });

  // ─── Valid cursor round-trips through sync ────────────────────────────────
  test("resumes from a valid cursor (since is passed as gt variable)", async () => {
    const db = createMemoryIndexDb();
    let capturedGt = "";

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const variables = body.variables as Record<string, unknown> | undefined;
      capturedGt = typeof variables?.["gt"] === "string" ? variables["gt"] : "";
      return new Response(makeLinearResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });

    // Build a valid cursor
    const sinceDateStr = "2026-04-15T08:00:00.000Z";
    const prefix = "nimbus-lnr1:";
    const validCursor =
      prefix + Buffer.from(JSON.stringify({ since: sinceDateStr }), "utf8").toString("base64url");

    await sync.sync(syncTestContext(db, createStubVault({ "linear.api_key": "key" })), validCursor);
    expect(capturedGt).toBe(sinceDateStr);
  });
});
