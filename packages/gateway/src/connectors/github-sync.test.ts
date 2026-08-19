import { expect, test } from "bun:test";

import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import { PR_FILES_PAGE_SIZE } from "../prfiles/pr-file-fetch.ts";
import { RateLimitError } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  type SyncTestFetchParams,
  silentSyncContextExtras,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import {
  createGithubSyncable,
  extractPrMetadataForIndex,
  processEvent,
  pullFilesUrl,
  selectPrEnrichCandidates,
  throwGithubRateLimitErrorIfApplicable,
  upsertPr,
} from "./github-sync.ts";

function ctxWithPat(db: ReturnType<typeof createMemoryIndexDb>, pat: string | null) {
  return {
    db,
    vault: createStubVault({ "github.pat": pat }),
    ...silentSyncContextExtras(),
  };
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Fix the retry loop",
    body: "Body text",
    html_url: "https://github.com/o/r/pull/42",
    state: "open",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describeWithFetchRestore("github-sync fetchOne", () => {
  test("indexes a PR url and makes it resolvable", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(prPayload()), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#42" });
    const row = db.query("SELECT resolve_key FROM item WHERE id = 'github:o/r#42'").get() as {
      resolve_key: string | null;
    };
    expect(row.resolve_key).toBe("https://github.com/o/r/pull/42");
  });

  test("declines a non-PR github url", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/actions/runs/1");

    expect(out).toEqual({ status: "unsupported_url" });
  });

  // Five upstream status codes, one shape: mock the status, assert the mapped
  // result. The mapping is the whole point — a 403 must read as `unauthorized`
  // and NOT as `absent`, or a permissions problem looks like a deleted PR, and a
  // 429 must surface as `rate_limited` rather than as a miss. `pat` varies only
  // to keep the expired-token narrative on the 401 row.
  test.each([
    [404, "pat-value", { status: "not_found", reason: "absent" }],
    [401, "expired-pat", { status: "not_found", reason: "unauthorized" }],
    [403, "pat-value", { status: "not_found", reason: "unauthorized" }],
    [429, "pat-value", { status: "rate_limited" }],
    [500, "pat-value", { status: "not_found", reason: "upstream_error" }],
  ] as const)("maps upstream %i to the right fetchOne result", async (code, pat, expected) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, pat);
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("body", { status: code }))) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual(expected);
  });

  // IMPORTANT 3: a DNS/TLS/connect failure must report not_found, not throw — the caller
  // (http-write-routes.ts) would otherwise surface an HTTP 500 + an audit row instead of the
  // 200 {"status":"not_found"} gitlab/jenkins/jira already report for the same offline condition.
  test("reports not_found when fetch itself throws (DNS/TLS/connect failure)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(JSON.stringify(out)).not.toContain("api.github.com");
  });

  test("reports not_found when the PAT is missing", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, null);
    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "no_credential" });
  });

  // A stalled/aborted upstream request must report not_found rather than hang the caller
  // (`POST /v1/items/fetch`) indefinitely — and the outbound request must actually carry a bounded
  // abort signal, not merely happen to survive an unrelated rejection.
  test("reports not_found and passes an abort signal when the request is aborted (timeout)", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: unknown, init?: SyncTestFetchParams[1]): Promise<Response> => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.reject(
        Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      );
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "unreachable" });
    expect(capturedSignal).toBeDefined();
  });

  // Regression: the returned itemId must match the row's ACTUAL id — derived from the API
  // response's own `number` field, not the raw regex-captured digit string from the caller's
  // URL. A leading-zero URL is the case where they diverge ("007" vs the API's normalized `7`).
  //
  // `resolve_key` stays the CALLER's literal URL ("...pull/007"), never the API-normalized
  // "...pull/7" — resolve_key must always equal whatever URL the caller actually resolved by, or
  // a second resolve of that SAME literal URL would miss (the exact class of bug CRITICAL 3
  // fixes). Before that fix this test asserted the normalized form, which was itself a latent
  // instance of the bug — masked because nothing here round-tripped through resolveItemByUrl.
  test("a leading-zero PR number resolves to the API's normalized id, not the raw capture", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const callerUrl = "https://github.com/o/r/pull/007";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify(prPayload({ number: 7, html_url: "https://github.com/o/r/pull/7" })),
          {
            status: 200,
          },
        ),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#7" });
    const row = db.query("SELECT id, resolve_key FROM item WHERE id = 'github:o/r#7'").get() as {
      id: string;
      resolve_key: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
    expect(resolveItemByUrl(db, callerUrl)).toMatchObject({ found: true, matchKind: "exact" });
  });

  test.each([
    ["owner is a dot-traversal segment", "https://github.com/../r/pull/1"],
    ["repo is a dot-traversal segment", "https://github.com/o/../pull/1"],
  ])("declines when %s", async (_label, url) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });

    const out = await syncable.fetchOne?.(ctx, url);

    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("reports not_found for a malformed (non-JSON) ok response", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  test("reports not_found for valid JSON that is not an object", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("[1,2,3]", { status: 200 }))) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });

  // CRITICAL 3: `html_url` is REMOTE-supplied and must never become the `resolve_key` — a repo
  // rename (GitHub 301s and returns the NEW `html_url`) or a response that omits `html_url`
  // entirely must not change what the caller's own URL resolves to. The existing tests above all
  // pass only because their fixture's `html_url` happens to equal the caller URL, which is
  // precisely why this survived: a genuinely DIVERGENT fixture is required to prove the fix.
  test.each([
    ["points at a renamed repo (a GitHub redirect)", "https://github.com/o/renamed-r/pull/42"],
    ["points at a completely different host", "https://evil.example/o/r/pull/42"],
    ["is an empty string", ""],
  ])("ignores a response html_url that %s", async (_label, responseHtmlUrl) => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const callerUrl = "https://github.com/o/r/pull/42";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(prPayload({ html_url: responseHtmlUrl })), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);

    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#42" });
    const row = db.query("SELECT resolve_key, url FROM item WHERE id = 'github:o/r#42'").get() as {
      resolve_key: string | null;
      url: string | null;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.resolve_key).toBe(callerUrl);
    expect(row?.url).toBe(callerUrl);
  });

  // Round-trip: caller URL -> fetchOne -> stored resolve_key -> resolveItemByUrl(callerUrl) must
  // be an exact hit, even when the API response's own html_url diverges from the caller's URL.
  test("round-trips through resolveItemByUrl even when html_url diverges", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const callerUrl = "https://github.com/o/r/pull/42";
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify(prPayload({ html_url: "https://github.com/o/renamed-r/pull/42" })),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, callerUrl);
    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#42" });

    const resolved = resolveItemByUrl(db, callerUrl);
    expect(resolved).toMatchObject({ found: true, matchKind: "exact" });
  });

  test("reports not_found when the response body has no number field", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ title: "No number field" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");

    expect(out).toEqual({ status: "not_found", reason: "upstream_error" });
  });
});

describeWithFetchRestore("github-sync events sync (I-3)", () => {
  test("PR detail enrichment still runs on a 304 (unchanged) events tick", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();

    // A previously-indexed PR missing stats — a live enrichment candidate.
    upsertPr(
      ctx,
      "acme/app",
      {
        number: 1,
        title: "Add rate limiter",
        body: "",
        html_url: "https://github.com/acme/app/pull/1",
        user: { login: "author" },
        state: "open",
      },
      now,
    );
    expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).toContain("acme/app#1");

    let pullDetailCalled = false;
    globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
      const url = urlFromFetchInput(input);
      if (url === "https://api.github.com/user") {
        return Promise.resolve(new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
      }
      if (url.startsWith("https://api.github.com/users/octocat/events")) {
        // The events feed itself is UNCHANGED — this is the 304 path under test.
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      if (url === "https://api.github.com/repos/acme/app/pulls/1") {
        pullDetailCalled = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 1,
              title: "Add rate limiter",
              additions: 10,
              deletions: 2,
              changed_files: 1,
              commits: 1,
            }),
            { status: 200 },
          ),
        );
      }
      throw new Error(`unexpected fetch in I-3 test: ${url}`);
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    const result = await syncable.sync(ctx, null);

    // The 304 path's own cursor/return semantics are preserved exactly.
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).not.toBeNull();

    // But enrichment newly ran on this quiet tick.
    expect(pullDetailCalled).toBe(true);
    expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).not.toContain("acme/app#1");
    db.close();
  });
});

function reviewEvent(): Record<string, unknown> {
  return {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: {
      action: "created",
      review: {
        id: 500,
        state: "approved",
        body: "LGTM",
        html_url: "https://github.com/acme/app/pull/1#pullrequestreview-500",
        submitted_at: "2026-08-11T10:00:00Z",
        user: { login: "reviewer" },
      },
      pull_request: {
        number: 1,
        title: "Add rate limiter",
        body: "",
        html_url: "https://github.com/acme/app/pull/1",
        user: { login: "author" },
        state: "open",
      },
    },
  };
}

test("a PullRequestReviewEvent indexes both the review and its PR", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const now = Date.now();

  expect(processEvent(ctx, reviewEvent(), now)).toBe(true);

  const review = db
    .query("SELECT id, author_id, metadata FROM item WHERE service = 'github' AND type = 'review'")
    .get() as { id: string; author_id: string | null; metadata: string };
  expect(review.id).toBe("github:acme/app#1#review-500");
  expect(review.author_id).not.toBeNull();
  expect(JSON.parse(review.metadata)).toMatchObject({
    repo: "acme/app",
    pr_number: 1,
    review_id: 500,
  });

  const pr = db.query("SELECT title FROM item WHERE id = 'github:acme/app#1'").get() as {
    title: string;
  };
  expect(pr.title).toBe("Add rate limiter");
  db.close();
});

test("the reviewer resolves to a different person than the PR author", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const now = Date.now();
  processEvent(ctx, reviewEvent(), now);

  const prAuthor = db.query("SELECT author_id FROM item WHERE id = 'github:acme/app#1'").get() as {
    author_id: string;
  };
  const reviewer = db
    .query("SELECT author_id FROM item WHERE id = 'github:acme/app#1#review-500'")
    .get() as { author_id: string };

  expect(reviewer.author_id).not.toBe(prAuthor.author_id);
  db.close();
});

test("a review event missing its pull_request is skipped without throwing", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: { action: "created", review: { id: 500, user: { login: "reviewer" } } },
  };

  expect(() => processEvent(ctx, ev, Date.now())).not.toThrow();
  expectServiceItemCount(db, "github", 0);
  db.close();
});

test("a review missing a usable id writes the PR but skips the review, and processEvent reports false", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: {
      action: "created",
      review: { user: { login: "reviewer" } },
      pull_request: { number: 1, title: "x", user: { login: "a" } },
    },
  };

  expect(() => processEvent(ctx, ev, Date.now())).not.toThrow();
  expect(processEvent(ctx, ev, Date.now())).toBe(false);

  const pr = db.query("SELECT title FROM item WHERE id = 'github:acme/app#1'").get() as {
    title: string;
  } | null;
  expect(pr).not.toBeNull();
  const review = db.query("SELECT id FROM item WHERE service = 'github' AND type = 'review'").get();
  expect(review).toBeNull();
  db.close();
});

test("a review id sent as a string (not a number) writes the PR but skips the review", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: {
      action: "created",
      review: { id: "500", user: { login: "reviewer" } },
      pull_request: { number: 1, title: "x", user: { login: "a" } },
    },
  };

  expect(processEvent(ctx, ev, Date.now())).toBe(false);

  const pr = db.query("SELECT title FROM item WHERE id = 'github:acme/app#1'").get() as {
    title: string;
  } | null;
  expect(pr).not.toBeNull();
  const review = db.query("SELECT id FROM item WHERE service = 'github' AND type = 'review'").get();
  expect(review).toBeNull();
  db.close();
});

test("a review event whose pull_request has no usable number is skipped without throwing", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: {
      action: "created",
      review: { id: 500, user: { login: "reviewer" } },
      pull_request: { title: "x", user: { login: "a" } },
    },
  };

  expect(() => processEvent(ctx, ev, Date.now())).not.toThrow();
  expect(processEvent(ctx, ev, Date.now())).toBe(false);
  expectServiceItemCount(db, "github", 0);
  db.close();
});

test("PR stats are captured from a pull-detail payload", () => {
  const meta = extractPrMetadataForIndex("acme/app", {
    number: 1,
    title: "Add rate limiter",
    state: "open",
    user: { login: "author" },
    additions: 120,
    deletions: 30,
    changed_files: 7,
    commits: 3,
  });

  expect(meta["additions"]).toBe(120);
  expect(meta["deletions"]).toBe(30);
  expect(meta["changed_files"]).toBe(7);
  expect(meta["commits"]).toBe(3);
});

test("PR stats are absent, not null, when the payload omits them", () => {
  const meta = extractPrMetadataForIndex("acme/app", {
    number: 1,
    title: "Add rate limiter",
    state: "open",
    user: { login: "author" },
  });

  expect("additions" in meta).toBe(false);
  expect("deletions" in meta).toBe(false);
  expect("changed_files" in meta).toBe(false);
  expect("commits" in meta).toBe(false);
});

test("I-2: an events-path upsert after enrichment preserves stats and does not re-queue the PR", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const now = Date.now();

  // Simulate `enrichPrDetail`'s single-PR response: real title + full stats.
  upsertPr(
    ctx,
    "acme/app",
    {
      number: 1,
      title: "Add rate limiter",
      body: "",
      html_url: "https://github.com/acme/app/pull/1",
      user: { login: "author" },
      state: "open",
      additions: 120,
      deletions: 30,
      changed_files: 7,
      commits: 3,
    },
    now,
  );

  expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).not.toContain("acme/app#1");

  // A later PullRequestEvent for the same PR — real event payloads never carry stats.
  expect(
    processEvent(
      ctx,
      {
        type: "PullRequestEvent",
        repo: { full_name: "acme/app" },
        payload: {
          action: "labeled",
          pull_request: {
            number: 1,
            title: "Add rate limiter",
            body: "",
            html_url: "https://github.com/acme/app/pull/1",
            user: { login: "author" },
            state: "open",
          },
        },
      },
      now + 60_000,
    ),
  ).toBe(true);

  const row = db.query("SELECT metadata FROM item WHERE id = 'github:acme/app#1'").get() as {
    metadata: string;
  };
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  expect(meta["additions"]).toBe(120);
  expect(meta["deletions"]).toBe(30);
  expect(meta["changed_files"]).toBe(7);
  expect(meta["commits"]).toBe(3);

  // Stats survived the events-path upsert, so the PR must not re-qualify for enrichment.
  expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).not.toContain("acme/app#1");
  db.close();
});

test("a 403 with retry-after is rate limiting even when remaining is non-zero", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const res = new Response("secondary rate limit", {
    status: 403,
    headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" },
  });

  expect(() => throwGithubRateLimitErrorIfApplicable(ctx, res, "events")).toThrow(RateLimitError);
  db.close();
});

test("a 403 with no retry-after and remaining left is not rate limiting", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const res = new Response("forbidden", {
    status: 403,
    headers: { "x-ratelimit-remaining": "4999" },
  });

  expect(() => throwGithubRateLimitErrorIfApplicable(ctx, res, "events")).not.toThrow();
  db.close();
});

test("pullFilesUrl requests the largest page and a page number", () => {
  const u = pullFilesUrl("o/r", 7, 2);
  expect(u).toContain("/repos/o/r/pulls/7/files");
  expect(u).toContain("per_page=100");
  expect(u).toContain("page=2");
});

/**
 * A PR with stats already present and a real title is NOT a pull-detail enrichment candidate
 * (`selectPrEnrichCandidates` excludes it), so these tests exercise the files pass in isolation
 * from `runPrDetailEnrichmentBestEffort` — no `/pulls/{n}` fetch happens.
 */
function enrichedPrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: "Add rate limiter",
    body: "",
    html_url: "https://github.com/acme/app/pull/1",
    user: { login: "author" },
    state: "open",
    additions: 10,
    deletions: 2,
    changed_files: 1,
    commits: 1,
    ...overrides,
  };
}

function githubFileEntry(name: string): Record<string, unknown> {
  return { filename: name, status: "modified" };
}

/** Stubs `/user` (login) and `/users/octocat/events` (304, the quiet-tick path under I-3). */
function stubUserAnd304Events(
  extra: (url: string) => Response | undefined,
): (input: SyncTestFetchParams[0]) => Promise<Response> {
  return (input: SyncTestFetchParams[0]) => {
    const url = urlFromFetchInput(input);
    if (url === "https://api.github.com/user") {
      return Promise.resolve(new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    }
    if (url.startsWith("https://api.github.com/users/octocat/events")) {
      return Promise.resolve(new Response(null, { status: 304 }));
    }
    const res = extra(url);
    if (res === undefined) {
      throw new Error(`unexpected fetch in pull-files test: ${url}`);
    }
    return Promise.resolve(res);
  };
}

describeWithFetchRestore("github-sync pull files pass", () => {
  test("a full-length page (PR_FILES_PAGE_SIZE files) requests a second page", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();
    upsertPr(ctx, "acme/app", enrichedPrPayload(), now);

    const filesPages: string[] = [];
    globalThis.fetch = stubUserAnd304Events((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/app/pulls/1/files")) {
        filesPages.push(url);
        // Match `&page=1` / `&page=2`, not the bare digit: `per_page=100` itself contains the
        // substring "page=1" (as a prefix of "100"), so a naive `.includes("page=1")` matches
        // every request regardless of its actual page number.
        if (url.includes("&page=1")) {
          const full = Array.from({ length: PR_FILES_PAGE_SIZE }, (_, i) =>
            githubFileEntry(`f${String(i)}.ts`),
          );
          return new Response(JSON.stringify(full), { status: 200 });
        }
        // Page 2 is short — the pass stops here.
        return new Response(JSON.stringify([githubFileEntry("last.ts")]), { status: 200 });
      }
      return undefined;
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    await syncable.sync(ctx, null);

    expect(filesPages.some((u) => u.includes("&page=1"))).toBe(true);
    expect(filesPages.some((u) => u.includes("&page=2"))).toBe(true);
    const s = db
      .query(
        "SELECT stored_count, truncated FROM pr_files_state WHERE item_id = 'github:acme/app#1'",
      )
      .get() as { stored_count: number; truncated: number } | null;
    expect(s?.stored_count).toBe(PR_FILES_PAGE_SIZE + 1);
    expect(s?.truncated).toBe(0);
    db.close();
  });

  test("a short page stops after one request and covers the PR", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();
    upsertPr(ctx, "acme/app", enrichedPrPayload(), now);

    let filesCalls = 0;
    globalThis.fetch = stubUserAnd304Events((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/app/pulls/1/files")) {
        filesCalls += 1;
        return new Response(JSON.stringify([githubFileEntry("a.ts")]), { status: 200 });
      }
      return undefined;
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    await syncable.sync(ctx, null);

    expect(filesCalls).toBe(1);
    const s = db
      .query("SELECT stored_count FROM pr_files_state WHERE item_id = 'github:acme/app#1'")
      .get() as { stored_count: number } | null;
    expect(s?.stored_count).toBe(1);
    db.close();
  });

  test("a 401 on pull files leaves the PR uncovered and does not abort the sync", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();
    upsertPr(ctx, "acme/app", enrichedPrPayload(), now);

    globalThis.fetch = stubUserAnd304Events((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/app/pulls/1/files")) {
        return new Response("unauthorized", { status: 401 });
      }
      return undefined;
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    await expect(syncable.sync(ctx, null)).resolves.toBeDefined();

    const s = db
      .query("SELECT COUNT(*) AS c FROM pr_files_state WHERE item_id = 'github:acme/app#1'")
      .get() as { c: number };
    expect(s.c).toBe(0);
    db.close();
  });

  test("a non-ok pull files response (e.g. 404) leaves the PR uncovered", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();
    upsertPr(ctx, "acme/app", enrichedPrPayload(), now);

    globalThis.fetch = stubUserAnd304Events((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/app/pulls/1/files")) {
        return new Response("not found", { status: 404 });
      }
      return undefined;
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    await syncable.sync(ctx, null);

    const s = db
      .query("SELECT COUNT(*) AS c FROM pr_files_state WHERE item_id = 'github:acme/app#1'")
      .get() as { c: number };
    expect(s.c).toBe(0);
    db.close();
  });

  test("a JSON parse failure on pull files leaves the PR uncovered", async () => {
    const db = createMemoryIndexDb();
    const ctx = ctxWithPat(db, "pat-value");
    const now = Date.now();
    upsertPr(ctx, "acme/app", enrichedPrPayload(), now);

    globalThis.fetch = stubUserAnd304Events((url) => {
      if (url.startsWith("https://api.github.com/repos/acme/app/pulls/1/files")) {
        return new Response("not json{{{", { status: 200 });
      }
      return undefined;
    }) as unknown as typeof fetch;

    const syncable = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
    await syncable.sync(ctx, null);

    const s = db
      .query("SELECT COUNT(*) AS c FROM pr_files_state WHERE item_id = 'github:acme/app#1'")
      .get() as { c: number };
    expect(s.c).toBe(0);
    db.close();
  });
});
