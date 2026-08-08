import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  type SyncTestFetchParams,
  silentSyncContextExtras,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createJiraSyncable } from "./jira-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

// Helper: build a valid credentials vault
function credVault(overrides: Record<string, string | null> = {}) {
  return createStubVault({
    "jira.email": "u@example.com",
    "jira.api_token": "tok",
    "jira.base_url": "https://example.atlassian.net",
    ...overrides,
  });
}

// Helper: build a sync context with credentials
function credCtx(overrides: Record<string, string | null> = {}) {
  const db = createMemoryIndexDb();
  return { db, ctx: { db, vault: credVault(overrides), ...silentSyncContextExtras() } };
}

// Helper: make a Jira issue fixture
function makeIssue(
  opts: {
    id?: string;
    key?: string;
    summary?: string;
    updated?: string;
    description?: unknown;
    creator?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    id: opts.id ?? "10001",
    key: opts.key ?? "NIM-1",
    fields: {
      summary: opts.summary ?? "Test Issue",
      updated: opts.updated ?? "2026-04-01T12:00:00.000+0000",
      description: opts.description !== undefined ? opts.description : null,
      creator:
        opts.creator !== undefined
          ? opts.creator
          : {
              accountId: "acct-1",
              displayName: "Author",
              emailAddress: "author@example.com",
            },
    },
  };
}

// Helper: returns a single-page successful fetch for given issues
function singlePageFetch(
  issues: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(
      JSON.stringify({ issues, startAt: 0, maxResults: 50, total: issues.length, ...extra }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

// Helper: returns a fetch that answers a `/rest/api/3/issue/<key>` detail request with a single
// issue object (as opposed to `singlePageFetch`'s search-envelope shape).
function singlePageIssueFetch(issue: Record<string, unknown>): typeof fetch {
  return (async (): Promise<Response> => {
    return new Response(JSON.stringify(issue), { status: 200 });
  }) as unknown as typeof fetch;
}

describeWithFetchRestore("jira-sync", () => {
  testConnectorSyncNoop(
    "no-op when credentials missing",
    () => createJiraSyncable({ ensureJiraMcpRunning: async () => {} }),
    EMPTY_NIMBUS_VAULT,
  );

  // ── no-op when only some credentials are provided ──────────────────────────

  // Any one blank credential is enough to make the whole sync a no-op. `"///"` is included here
  // because a base_url of only slashes normalizes to "".
  test.each([
    ["email is empty", "jira.email", ""],
    ["api_token is empty", "jira.api_token", ""],
    ["base_url normalizes to empty", "jira.base_url", "///"],
  ])("no-op when %s", async (_label, key, value) => {
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const db = createMemoryIndexDb();
    const ctx = { db, vault: credVault({ [key]: value }), ...silentSyncContextExtras() };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBeNull();
  });

  // ── main happy-path with creator+email ─────────────────────────────────────

  test("indexes issues from Jira search response and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("example.atlassian.net/rest/api/3/search");
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      expect(body.jql).toContain("updated");
      expect(body.fields).toContain("creator");
      return new Response(
        JSON.stringify({
          issues: [
            {
              id: "10001",
              key: "NIM-1",
              fields: {
                summary: "Ship Jira",
                description: { type: "doc", version: 1, content: [] },
                updated: "2026-04-01T12:00:00.000+0000",
                creator: {
                  accountId: "acct-1",
                  displayName: "Jira Author",
                  emailAddress: "jira.author@example.com",
                },
              },
            },
          ],
          startAt: 0,
          maxResults: 50,
          total: 1,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const ctx = {
      vault: createStubVault({
        "jira.email": "u@example.com",
        "jira.api_token": "tok",
        "jira.base_url": "https://example.atlassian.net",
      }),
      db,
      ...silentSyncContextExtras(),
    };
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-jra1:");
    expectServiceItemCount(db, "jira", 1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).not.toBeNull();
  });

  // ── cursor decode branches ──────────────────────────────────────────────────

  test("null cursor produces initial JQL with date range", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, null);
    expect(capturedJql).toContain("updated >= -30d");
    expect(capturedJql).toContain("ORDER BY updated ASC");
  });

  test("empty string cursor is treated as null (initial JQL)", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, "");
    // empty string → decodeCursor returns null → jiraJqlFromCursor uses initial range
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("cursor with wrong prefix is treated as null", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    // prefix "bad-prefix:" doesn't match "nimbus-jra1:"
    const badCursor =
      "bad-prefix:" +
      Buffer.from(JSON.stringify({ v: 1, floorJql: "2026/01/01 00:00" }), "utf8").toString(
        "base64url",
      );
    await sync.sync(ctx, badCursor);
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("cursor with valid prefix but non-object payload is treated as null", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    // payload is an array, not an object → branch 38
    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", ["array"]);
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("cursor with wrong v version is treated as null", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    // v: 2 → wrong version branch at line 42
    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", { v: 2, floorJql: "2026/01/01 00:00" });
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("cursor with non-string floorJql is treated as null", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    // floorJql is a number → line 46 branch
    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", { v: 1, floorJql: 12345 });
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("cursor with null floorJql is treated as initial sync", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    // floorJql is null → line 49: returns { v:1, floorJql: null } → jiraJqlFromCursor uses initial range
    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", { v: 1, floorJql: null });
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    expect(capturedJql).toContain("updated >= -30d");
  });

  test("valid cursor with floorJql uses incremental JQL", async () => {
    const { ctx } = credCtx();
    let capturedJql = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      capturedJql = typeof body.jql === "string" ? body.jql : "";
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", { v: 1, floorJql: "2026/04/01 12:00" });
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, cursor);
    expect(capturedJql).toContain('updated > "2026/04/01 12:00"');
    expect(capturedJql).toContain("ORDER BY updated ASC");
  });

  // ── HTTP error responses ───────────────────────────────────────────────────

  test("throws RateLimitError on HTTP 429", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Rate limited", {
        status: 429,
        headers: { "retry-after": "30" },
      });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow("rate limited");
  });

  // 401/403 surface as UnauthenticatedError, other non-ok statuses as a generic error, and a
  // 200 with an unparseable body as a JSON error — in each case the message names the cause.
  test.each([
    ["UnauthenticatedError on HTTP 401", 401, "Unauthorized", "401"],
    ["UnauthenticatedError on HTTP 403", 403, "Forbidden", "403"],
    ["a generic error on non-ok HTTP status (500)", 500, "Server Error", "500"],
    ["an error on an invalid JSON response", 200, "not-json{{{", "invalid JSON"],
  ])("throws %s", async (_label, status, body, expectedMessage) => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(body, { status });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow(expectedMessage);
  });

  test("throws error when issues field is missing from response", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow("missing issues array");
  });

  test("throws error when response is not a JSON object", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      // asRecord returns undefined for non-objects → envelope?.issues is undefined
      return new Response(JSON.stringify([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await expect(sync.sync(ctx, null)).rejects.toThrow("missing issues array");
  });

  // ── issue field edge cases ─────────────────────────────────────────────────

  test("skips issue with no key field", async () => {
    const { db, ctx } = credCtx();
    // Issue missing 'key' → jiraIndexOneIssue returns false → not counted
    const noKeyIssue = { id: "10099", fields: { summary: "No key" } };
    globalThis.fetch = singlePageFetch([noKeyIssue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "jira", 0);
  });

  test("skips non-object entries in the issues array", async () => {
    const { db, ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      // One entry is a primitive string (not a record), one is valid
      return new Response(
        JSON.stringify({
          issues: ["not-an-object", makeIssue({ key: "NIM-2" })],
          startAt: 0,
          maxResults: 50,
          total: 2,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    // "not-an-object" → asRecord returns undefined → continue; NIM-2 is indexed
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "jira", 1);
  });

  test("handles issue with null description", async () => {
    const { db, ctx } = credCtx();
    globalThis.fetch = singlePageFetch([makeIssue({ description: null })]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect(row?.body_preview).toBe("");
  });

  test("handles issue with undefined description (missing field)", async () => {
    const { db, ctx } = credCtx();
    // Fields without description key at all
    const issue = {
      id: "10001",
      key: "NIM-1",
      fields: { summary: "Test", updated: "2026-04-01T12:00:00.000+0000" },
    };
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect(row?.body_preview).toBe("");
  });

  test("handles issue with string description", async () => {
    const { db, ctx } = credCtx();
    globalThis.fetch = singlePageFetch([makeIssue({ description: "plain text description" })]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect(row?.body_preview).toBe("plain text description");
  });

  test("handles issue with ADF object description (serialized to JSON)", async () => {
    const { db, ctx } = credCtx();
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };
    globalThis.fetch = singlePageFetch([makeIssue({ description: adf })]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect(row?.body_preview).toContain("doc");
  });

  test("truncates description longer than 512 chars", async () => {
    const { db, ctx } = credCtx();
    const longDesc = "x".repeat(600);
    globalThis.fetch = singlePageFetch([makeIssue({ description: longDesc })]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT body_preview FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { body_preview: string }
      | undefined;
    expect(row?.body_preview?.length).toBeLessThanOrEqual(512);
  });

  test("truncates title/summary longer than 512 chars", async () => {
    const { db, ctx } = credCtx();
    const longSummary = "y".repeat(600);
    globalThis.fetch = singlePageFetch([makeIssue({ summary: longSummary })]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await sync.sync(ctx, null);
    const row = db.prepare("SELECT title FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { title: string }
      | undefined;
    expect(row?.title?.length).toBeLessThanOrEqual(512);
  });

  // ── creator/author resolution edge cases ──────────────────────────────────

  test("handles issue with no creator field", async () => {
    const { db, ctx } = credCtx();
    const issue = {
      id: "10001",
      key: "NIM-1",
      fields: {
        summary: "No creator",
        updated: "2026-04-01T12:00:00.000+0000",
        creator: undefined,
      },
    };
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    // No creator → authorId should be null
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).toBeNull();
  });

  test("handles creator with no emailAddress (uses accountId only path)", async () => {
    const { db, ctx } = credCtx();
    const issue = makeIssue({
      creator: { accountId: "acct-no-email", displayName: "No Email Author" },
    });
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    // resolvePersonForSync with accountId only → not null
    expect(row?.author_id).not.toBeNull();
  });

  test("handles creator with empty accountId (author resolves to null)", async () => {
    const { db, ctx } = credCtx();
    const issue = makeIssue({
      creator: { accountId: "", displayName: "Empty AccountId" },
    });
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    // empty accountId → resolveJiraIssueAuthorId returns null
    const row = db.prepare("SELECT author_id FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { author_id: string | null }
      | undefined;
    expect(row?.author_id).toBeNull();
  });

  // ── issue with no fields object ───────────────────────────────────────────

  test("handles issue with no fields object (uses key as summary)", async () => {
    const { db, ctx } = credCtx();
    // No 'fields' property at all
    const issue = { id: "10001", key: "NIM-5" };
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT title FROM item WHERE service = 'jira' LIMIT 1").get() as
      | { title: string }
      | undefined;
    // No fields → key used as summary
    expect(row?.title).toBe("NIM-5");
  });

  test("handles issue with no updated field (uses syncTime)", async () => {
    const { ctx } = credCtx();
    const issue = { id: "10001", key: "NIM-6", fields: { summary: "No updated" } };
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── pagination ─────────────────────────────────────────────────────────────

  test("fetches multiple pages when total > pageSize", async () => {
    const { db, ctx } = credCtx();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const startAt = typeof body.startAt === "number" ? body.startAt : 0;

      // Page 1 (startAt=0): 50 issues; page 2 (startAt=50): 1 issue, total=51
      const pageIssues =
        startAt === 0
          ? Array.from({ length: 50 }, (_, i) =>
              makeIssue({ key: `NIM-${String(i + 1)}`, id: String(i + 1) }),
            )
          : [makeIssue({ key: "NIM-51", id: "51" })];

      return new Response(
        JSON.stringify({ issues: pageIssues, startAt, maxResults: 50, total: 51 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(51);
    expectServiceItemCount(db, "jira", 51);
  });

  test("stops paging when issues array is empty", async () => {
    const { ctx } = credCtx();
    let callCount = 0;

    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(0);
  });

  test("stops paging when issues returned < pageSize (no total)", async () => {
    const { ctx } = credCtx();
    let callCount = 0;

    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      // Return 3 issues with no total field → issuesLen (3) < pageSize (50) → stop
      return new Response(
        JSON.stringify({
          issues: [
            makeIssue({ key: "NIM-A" }),
            makeIssue({ key: "NIM-B" }),
            makeIssue({ key: "NIM-C" }),
          ],
          startAt: 0,
          maxResults: 50,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(3);
  });

  // ── cursor emission ────────────────────────────────────────────────────────

  test("cursor retains previous floorJql when no issues are returned", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ issues: [], startAt: 0, maxResults: 50, total: 0 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    // Provide a cursor with floorJql
    const prevCursor = encodeNimbusJsonCursor("nimbus-jra1:", {
      v: 1,
      floorJql: "2026/04/01 12:01",
    });
    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, prevCursor);
    // maxUpdatedIso is still "" → nextFloor = prev.floorJql
    expect(r.cursor).toContain("nimbus-jra1:");
    // Decode the cursor and verify floorJql preserved
    const decoded = JSON.parse(
      Buffer.from(r.cursor!.slice("nimbus-jra1:".length), "base64url").toString("utf8"),
    ) as { v: number; floorJql: string | null };
    expect(decoded.floorJql).toBe("2026/04/01 12:01");
  });

  test("cursor advances floorJql when issues are returned", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = singlePageFetch([
      makeIssue({ key: "NIM-1", updated: "2026-05-10T08:00:00.000+0000" }),
    ]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.cursor).toContain("nimbus-jra1:");
    const decoded = JSON.parse(
      Buffer.from(r.cursor!.slice("nimbus-jra1:".length), "base64url").toString("utf8"),
    ) as { v: number; floorJql: string | null };
    // isoToJqlExclusiveFloor advances by 1 second
    expect(typeof decoded.floorJql).toBe("string");
    expect(decoded.floorJql).toContain("2026/05/10");
  });

  test("maxIso selects the later of two updated timestamps", async () => {
    const { ctx } = credCtx();
    // Two issues with different updated times → maxIso should pick the later one
    globalThis.fetch = singlePageFetch([
      makeIssue({ key: "NIM-1", updated: "2026-03-01T00:00:00.000+0000" }),
      makeIssue({ key: "NIM-2", id: "10002", updated: "2026-05-15T12:00:00.000+0000" }),
    ]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    const decoded = JSON.parse(
      Buffer.from(r.cursor!.slice("nimbus-jra1:".length), "base64url").toString("utf8"),
    ) as { v: number; floorJql: string | null };
    // Should contain the month of the later date
    expect(decoded.floorJql).toContain("2026/05/15");
  });

  test("isoToJqlExclusiveFloor returns fallback for invalid ISO", async () => {
    const { ctx } = credCtx();
    // Issue with invalid date → isoToJqlExclusiveFloor uses 1970 fallback
    const issue = {
      id: "10001",
      key: "NIM-1",
      fields: { summary: "Bad date", updated: "not-a-valid-date" },
    };
    globalThis.fetch = singlePageFetch([issue]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.cursor).toContain("nimbus-jra1:");
    const decoded = JSON.parse(
      Buffer.from(r.cursor!.slice("nimbus-jra1:".length), "base64url").toString("utf8"),
    ) as { v: number; floorJql: string | null };
    expect(decoded.floorJql).toBe("1970/01/01 00:00");
  });

  // ── bytes transferred ─────────────────────────────────────────────────────

  test("accumulates bytesTransferred across pages", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = singlePageFetch([makeIssue()]);

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(r.bytesTransferred).toBeGreaterThan(0);
  });

  // ── pagination with total field present and startAt >= total ──────────────

  test("stops when startAt after increment reaches total (total-based stop)", async () => {
    const { ctx } = credCtx();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      const startAt = typeof body.startAt === "number" ? body.startAt : 0;

      // Exactly 50 issues, total=50 → startAt+50 (=50) >= total (50) → stop after first page
      const issues = Array.from({ length: 50 }, (_, i) =>
        makeIssue({ key: `NIM-${String(startAt + i + 1)}`, id: String(startAt + i + 1) }),
      );

      return new Response(JSON.stringify({ issues, startAt, maxResults: 50, total: 50 }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const r = await sync.sync(ctx, null);
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(50);
  });
});

// ── fetchOne ───────────────────────────────────────────────────────────────

describeWithFetchRestore("jira-sync fetchOne", () => {
  test("jira fetchOne indexes a /browse/ issue url", async () => {
    const { db, ctx } = credCtx();
    globalThis.fetch = singlePageIssueFetch(makeIssue({ key: "ENG-42", id: "10042" }));

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "indexed", itemId: "jira:ENG-42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jira:ENG-42'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe("https://example.atlassian.net/browse/ENG-42");
  });

  test("jira fetchOne indexes a board deep link via selectedIssue", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = singlePageIssueFetch(makeIssue({ key: "ENG-42", id: "10042" }));

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const url =
      "https://example.atlassian.net/jira/software/c/projects/ENG/boards/1?selectedIssue=ENG-42";
    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "indexed", itemId: "jira:ENG-42" });
  });

  test("jira fetchOne declines a shape it does not support, rather than guessing a key", async () => {
    const { ctx } = credCtx();

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(
      ctx,
      "https://example.atlassian.net/projects/ENG/issues/?filter=all",
    );

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("jira fetchOne declines a selectedIssue value that is not a valid key", async () => {
    const { ctx } = credCtx();

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const url = "https://example.atlassian.net/jira/software/c/boards/1?selectedIssue=not-a-key";
    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("jira fetchOne declines a non-http(s) scheme", async () => {
    const { ctx } = credCtx();

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "ftp://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a 404", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-999");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = { db, vault: credVault({ "jira.email": "" }), ...silentSyncContextExtras() };

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND example.atlassian.net");
    }) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
  });

  // A stalled/aborted upstream request must report not_found rather than hang the caller
  // (`POST /v1/items/fetch`) indefinitely — and the outbound request must actually carry a bounded
  // abort signal, not merely happen to survive an unrelated rejection. Recording `init?.signal`
  // proves the timeout is WIRED, not just that some catch block happens to swallow errors.
  test("reports not_found and passes an abort signal when the request is aborted (timeout)", async () => {
    const { ctx } = credCtx();
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: SyncTestFetchParams[1]): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      );
    }) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
    expect(capturedSignal).toBeDefined();
  });

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `key` field, never the raw regex capture from the caller's URL. A Jira issue
  // can be MOVED between projects, changing its key; the old `/browse/` link still 200s, but with
  // the issue's CURRENT key. This pins the KNOWN BOUND documented beside `returnedKey` in
  // `fetchOneIssue` (jira-sync.ts): the written `resolve_key` follows the issue's CURRENT
  // canonical URL, never the caller's stale original link — kept deliberately, not fixed.
  test("a moved issue resolves to the API's current key, not the requested one", async () => {
    const { db, ctx } = credCtx();
    globalThis.fetch = singlePageIssueFetch(makeIssue({ key: "NEWPROJ-1", id: "10042" }));

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "indexed", itemId: "jira:NEWPROJ-1" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jira:NEWPROJ-1'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row?.resolve_key).toBe("https://example.atlassian.net/browse/NEWPROJ-1");
  });

  // ── base-URL vs request-URL mismatch (the loop-class bug) ──────────────────
  //
  // The host boundary (`sync/fetch-host-boundary.ts`) proves only that the request's HOST is
  // claimed by Jira; it says nothing about scheme, port, or a context path. Without a check here,
  // a caller URL whose spelling merely diverges from the configured `jira.base_url` would still
  // dispatch, and `jiraIndexOneIssue` would write `resolve_key` under the CONFIGURED base rather
  // than the CALLER's URL — a stored key the caller's own link can never resolve again, so the
  // client re-fetches forever (the loop this fix closes).

  test("rejects a /browse/ request when the configured base_url carries a context path the caller omitted", async () => {
    const { db, ctx } = credCtx({ "jira.base_url": "https://example.atlassian.net/jira" });
    // A counter, not a throw: a throwing fetch would be swallowed by fetchOneIssue's own
    // DNS/TLS-failure handler and come back `not_found`, which would mask "was the network ever
    // reached" behind a status this function already returns for an unrelated reason. Counting
    // calls proves the request was rejected BEFORE dispatch, not merely that dispatch failed.
    let fetchCalls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      fetchCalls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-1");

    expect(out).toEqual({ status: "unsupported_url" });
    expect(fetchCalls).toBe(0);
    const row = db.query("SELECT id FROM item WHERE id = 'jira:ENG-1'").get();
    expect(row).toBeNull();
  });

  test("accepts and round-trips a caller URL when the configured base_url has an explicit default port", async () => {
    const { db, ctx } = credCtx({ "jira.base_url": "https://example.atlassian.net:443" });
    globalThis.fetch = singlePageIssueFetch(makeIssue({ key: "ENG-42", id: "10042" }));

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const callerUrl = "https://example.atlassian.net/browse/ENG-42";
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jira:ENG-42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jira:ENG-42'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row?.resolve_key).toBe(callerUrl);
  });

  test("accepts and round-trips a caller URL when the configured base_url carries a trailing slash", async () => {
    const { db, ctx } = credCtx({ "jira.base_url": "https://example.atlassian.net/" });
    globalThis.fetch = singlePageIssueFetch(makeIssue({ key: "ENG-42", id: "10042" }));

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const callerUrl = "https://example.atlassian.net/browse/ENG-42";
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "jira:ENG-42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'jira:ENG-42'").get() as {
      resolve_key: string | null;
    } | null;
    expect(row?.resolve_key).toBe(callerUrl);
  });

  test("reports not_found for a malformed (non-JSON) ok response", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found for valid JSON that is not an object", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("[1,2,3]", { status: 200 })) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
  });

  test("reports not_found when the response body has no key field", async () => {
    const { ctx } = credCtx();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ id: "10042" }), { status: 200 })) as unknown as typeof fetch;

    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://example.atlassian.net/browse/ENG-42");

    expect(out).toEqual({ status: "not_found" });
  });
});

// ── ticket-depth metadata contract ───────────────────────────────────────────

/**
 * Runs one full search-page sync over `issues`, optionally handing each request
 * body to `onBody`. Assertions are made against the STORED row rather than
 * against what this stub received — a fake echoing params back proves nothing
 * about what the mapper wrote.
 */
async function runJiraSyncWithIssues(
  ctx: Parameters<ReturnType<typeof createJiraSyncable>["sync"]>[0],
  issues: ReadonlyArray<Record<string, unknown>>,
  onBody?: (body: string) => void,
): Promise<void> {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => {
    onBody?.(typeof init?.body === "string" ? init.body : "");
    const url = urlFromFetchInput(input);
    if (url.includes("/rest/api/3/search")) {
      return new Response(
        JSON.stringify({ issues, startAt: 0, maxResults: 50, total: issues.length }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
  await syncable.sync(ctx, null);
}

function storedMetadata(db: ReturnType<typeof createMemoryIndexDb>, externalId: string) {
  const row = db.prepare("SELECT metadata FROM item WHERE external_id = ?").get(externalId) as
    | { metadata: string }
    | undefined;
  return JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
}

describeWithFetchRestore("jira-sync ticket depth", () => {
  test("jira issue metadata carries the ticket-depth contract", async () => {
    const { db, ctx } = credCtx();
    await runJiraSyncWithIssues(ctx, [
      {
        id: "10001",
        key: "PROJ-7",
        fields: {
          summary: "Ship the thing",
          updated: "2026-02-01T00:00:00.000Z",
          created: "2026-01-01T00:00:00.000Z",
          resolutiondate: "2026-01-20T00:00:00.000Z",
          duedate: "2026-01-15",
          issuetype: { name: "Epic" },
          status: { name: "Shipped To Prod", statusCategory: { key: "done" } },
          parent: { key: "PROJ-1" },
        },
      },
    ]);

    const meta = storedMetadata(db, "PROJ-7");

    expect(meta["issue_type"]).toBe("Epic");
    expect(meta["status"]).toBe("Shipped To Prod");
    // Normalized, NOT the renamed display status.
    expect(meta["status_category"]).toBe("done");
    expect(meta["status_category_raw"]).toBe("done");
    expect(meta["created_at_ms"]).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(meta["resolved_at_ms"]).toBe(Date.parse("2026-01-20T00:00:00.000Z"));
    expect(meta["due_at_ms"]).toBe(Date.parse("2026-01-15"));
    expect(meta["parent_key"]).toBe("PROJ-1");
    expect(meta["meta_v"]).toBe(1);
    // Pre-existing keys survive.
    expect(meta["jiraId"]).toBe("10001");
    expect(meta["key"]).toBe("PROJ-7");
  });

  test("a renamed jira status does not change the normalized category", async () => {
    const { db, ctx } = credCtx();
    await runJiraSyncWithIssues(ctx, [
      {
        id: "10002",
        key: "PROJ-8",
        fields: {
          summary: "In flight",
          updated: "2026-02-01T00:00:00.000Z",
          status: { name: "Yak Shaving", statusCategory: { key: "indeterminate" } },
        },
      },
    ]);

    const meta = storedMetadata(db, "PROJ-8");
    expect(meta["status_category"]).toBe("in_progress");
    expect(meta["status"]).toBe("Yak Shaving");
  });

  test("absent jira depth fields omit their keys rather than writing zeros", async () => {
    const { db, ctx } = credCtx();
    await runJiraSyncWithIssues(ctx, [
      {
        id: "10003",
        key: "PROJ-9",
        fields: { summary: "Bare", updated: "2026-02-01T00:00:00.000Z" },
      },
    ]);

    const meta = storedMetadata(db, "PROJ-9");

    // A consumer must be able to tell "no due date" from "due at the epoch".
    expect("created_at_ms" in meta).toBe(false);
    expect("resolved_at_ms" in meta).toBe(false);
    expect("due_at_ms" in meta).toBe(false);
    expect("parent_key" in meta).toBe(false);
    expect(meta["status_category"]).toBe("unknown");
    expect(meta["meta_v"]).toBe(1);
  });

  test("jira requests the depth fields from the search API", async () => {
    const { ctx } = credCtx();
    const bodies: string[] = [];
    await runJiraSyncWithIssues(ctx, [], (body) => bodies.push(body));

    const requested = JSON.parse(bodies[0] ?? "{}") as { fields?: string[] };
    for (const f of ["created", "resolutiondate", "parent", "duedate", "issuetype", "status"]) {
      expect(requested.fields).toContain(f);
    }
  });
});
