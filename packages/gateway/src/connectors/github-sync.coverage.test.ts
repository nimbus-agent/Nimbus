/**
 * Edge shapes of the GitHub connector that the other github-sync test files do not reach: odd
 * label/merge/review/issue payloads, a corrupt stored row during the stats merge-forward, malformed
 * candidate ids, the `/user` and full-page paths of the events sync, rate limits raised inside the
 * two best-effort passes, and the targeted-fetch URL pre-check.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { RateLimitError, type SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  createGithubSyncable,
  extractPrMetadataForIndex,
  githubFetchOneUrlIsSupported,
  processEvent,
  selectPrEnrichCandidates,
  shouldRefreshMergeableState,
  upsertPr,
} from "./github-sync.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-ghub1:";
const ENSURE_MCP = { ensureGithubMcpRunning: async (): Promise<void> => {} };
const USER_URL = "https://api.github.com/user";
const EVENTS_URL = "https://api.github.com/users/octo/events?per_page=100";
const FILES_RE = /^https:\/\/api\.github\.com\/repos\/[^?]+\/files\?/;

function cursorWith(payload: unknown): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, payload);
}

function ctxFor(db: Database): SyncContext {
  return syncTestContext(db, createStubVault({ "github.pat": "pat-test" }), "github");
}

type LogLine = { level: number; msg: string; [k: string]: unknown };

/** A real pino logger whose output is kept, so a test can assert what was (not) warned. */
function capturingLogger(): { logger: Logger; lines: () => LogLine[] } {
  const raw: string[] = [];
  const logger = pino({ level: "debug" }, { write: (s: string) => raw.push(s) });
  return { logger, lines: () => raw.map((s) => JSON.parse(s) as LogLine) };
}

const WARN = 40;

function seedPr(
  db: Database,
  externalId: string,
  title: string,
  metadata: Record<string, unknown>,
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId,
    title,
    bodyPreview: "",
    url: null,
    canonicalUrl: null,
    modifiedAt: 1000,
    metadata,
    syncedAt: 1000,
  });
}

function itemRow(
  db: Database,
  externalId: string,
): {
  title: string;
  body_preview: string;
  url: string | null;
  author_id: string | null;
  modified_at: number;
  metadata: string;
} | null {
  return db
    .query(
      "SELECT title, body_preview, url, author_id, modified_at, metadata FROM item WHERE service = 'github' AND external_id = ?",
    )
    .get(externalId) as {
    title: string;
    body_preview: string;
    url: string | null;
    author_id: string | null;
    modified_at: number;
    metadata: string;
  } | null;
}

describe("extractPrMetadataForIndex — edge payloads", () => {
  test("labels keep plain strings and named objects, and skip non-objects and empty names", () => {
    const meta = extractPrMetadataForIndex("o/r", {
      number: 1,
      labels: [7, null, ["nested"], { name: "" }, { color: "red" }, { name: "bug" }, "triage"],
    });
    expect(meta["labels"]).toEqual(["bug", "triage"]);
  });

  test.each([
    ["no merged_at and no merge sha", { number: 1, merged: true }],
    [
      "an unparseable merged_at and an empty merge sha",
      { number: 2, merged: true, merged_at: "not a date", merge_commit_sha: "" },
    ],
  ])("a merged PR with %s writes neither merge field", (_label, pr) => {
    const meta = extractPrMetadataForIndex("o/r", pr);
    expect(meta["merged"]).toBe(true);
    expect("merged_at" in meta).toBe(false);
    expect("merge_commit_sha" in meta).toBe(false);
  });

  test("a merged PR with a valid merged_at and sha writes both (control)", () => {
    const meta = extractPrMetadataForIndex("o/r", {
      number: 3,
      merged: true,
      merged_at: "2026-01-02T03:04:05Z",
      merge_commit_sha: "abc123",
    });
    expect(meta["merged_at"]).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(meta["merge_commit_sha"]).toBe("abc123");
  });
});

describe("shouldRefreshMergeableState", () => {
  test("a known mergeable_state with no fetch timestamp is due; one fetched a minute ago is not", () => {
    const nowMs = 10_000_000;
    const base = { mergeableState: "clean", updatedAtMs: nowMs - 1000, nowMs };
    expect(shouldRefreshMergeableState({ ...base, mergeableStateFetchedAtMs: null })).toBe(true);
    expect(
      shouldRefreshMergeableState({ ...base, mergeableStateFetchedAtMs: nowMs - 60_000 }),
    ).toBe(false);
  });
});

describe("upsertPr — edge payloads", () => {
  test.each([
    ["no login field", { id: 5, email: "octo.cat@example.com" }],
    ["an empty login", { login: "", email: "octo.cat@example.com" }],
  ])("a user object with %s resolves no author, even when it carries an email", (_label, user) => {
    const db = createMemoryIndexDb();
    const ctx = ctxFor(db);
    upsertPr(ctx, "o/r", { number: 1, title: "t", user }, 1000);
    expect(itemRow(db, "o/r#1")?.author_id).toBeNull();
    // Premise: the person resolver links on an email ALONE, so with one present it is the login
    // guard — not the resolver declining an empty hint — that produced the null above.
    const byEmail = ctx.resolvePerson({ displayName: "", canonicalEmail: "octo.cat@example.com" });
    expect(byEmail).not.toBeNull();
    // Control: the same user WITH a login is resolved — through that email, to that same person.
    upsertPr(
      ctx,
      "o/r",
      { number: 2, title: "t", user: { login: "octo", email: "octo.cat@example.com" } },
      1000,
    );
    expect(itemRow(db, "o/r#2")?.author_id).toBe(byEmail);
    db.close();
  });

  test("with no updated_at, a valid created_at is the timestamp and an unparseable one falls back to now", () => {
    const db = createMemoryIndexDb();
    upsertPr(ctxFor(db), "o/r", { number: 1, created_at: "2026-01-02T00:00:00Z" }, 5000);
    upsertPr(ctxFor(db), "o/r", { number: 2, created_at: "sometime last week" }, 5000);
    expect(itemRow(db, "o/r#1")?.modified_at).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(itemRow(db, "o/r#2")?.modified_at).toBe(5000);
    db.close();
  });

  test.each([
    ["is not valid JSON", "{not json"],
    ["is JSON but not an object", "[1,2,3]"],
    // An array has no `additions` to merge either way, so only `null` — which throws on any
    // property read — proves the object guard runs before the stored keys are read.
    ["is the JSON literal null", "null"],
  ])("stats are not merged forward when the stored metadata %s", (_label, stored) => {
    const db = createMemoryIndexDb();
    const ctx: SyncContext = { ...ctxFor(db), itemMetadata: () => stored };
    upsertPr(ctx, "o/r", { number: 1, title: "t" }, 1000);
    const meta = JSON.parse(itemRow(db, "o/r#1")?.metadata ?? "{}") as Record<string, unknown>;
    // The PR row WAS written (so the absences below are about the merge, not a missing row)...
    expect(meta["number"]).toBe(1);
    expect(meta["repo"]).toBe("o/r");
    // ...and it carries none of the stats a merge-forward would have copied in.
    expect(meta["additions"]).toBeUndefined();
    expect(meta["commits"]).toBeUndefined();
    db.close();
  });

  test("stats ARE merged forward from a well-formed stored row (control)", () => {
    const db = createMemoryIndexDb();
    const ctx: SyncContext = {
      ...ctxFor(db),
      itemMetadata: () => JSON.stringify({ additions: 5, deletions: 2 }),
    };
    upsertPr(ctx, "o/r", { number: 1, title: "t" }, 1000);
    const meta = JSON.parse(itemRow(db, "o/r#1")?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["additions"]).toBe(5);
    expect(meta["deletions"]).toBe(2);
    db.close();
  });
});

describe("processEvent — sparse review and issue payloads", () => {
  function reviewEvent(review: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "PullRequestReviewEvent",
      repo: { name: "o/r" },
      payload: { review, pull_request: { number: 3, title: "Add retries" } },
    };
  }

  test("a review carrying only an id is indexed with no body, no url, a null state and the sync time", () => {
    const db = createMemoryIndexDb();
    expect(processEvent(ctxFor(db), reviewEvent({ id: 77 }), 5000)).toBe(true);
    const row = itemRow(db, "o/r#3#review-77");
    expect(row?.body_preview).toBe("");
    expect(row?.url).toBeNull();
    expect(row?.modified_at).toBe(5000);
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({
      repo: "o/r",
      pr_number: 3,
      review_id: 77,
      state: null,
    });
    db.close();
  });

  test("a review whose submitted_at does not parse is timestamped with the sync time", () => {
    const db = createMemoryIndexDb();
    const url = "https://github.com/o/r/pull/3#pullrequestreview-78";
    processEvent(
      ctxFor(db),
      reviewEvent({
        id: 78,
        submitted_at: "yesterday-ish",
        state: "APPROVED",
        body: "lgtm",
        html_url: url,
      }),
      5000,
    );
    const row = itemRow(db, "o/r#3#review-78");
    expect(row?.modified_at).toBe(5000);
    expect(row?.url).toBe(url);
    expect(row?.body_preview).toBe("lgtm");
    expect((JSON.parse(row?.metadata ?? "{}") as { state: unknown }).state).toBe("APPROVED");
    db.close();
  });

  test("an IssuesEvent whose issue is not an object is skipped", () => {
    const db = createMemoryIndexDb();
    const ev = { type: "IssuesEvent", repo: { name: "o/r" }, payload: { issue: "closed" } };
    expect(processEvent(ctxFor(db), ev, 1)).toBe(false);
    expect((db.query("SELECT COUNT(*) AS c FROM item").get() as { c: number }).c).toBe(0);
    db.close();
  });

  test("an IssuesEvent whose issue has no number writes no row", () => {
    const db = createMemoryIndexDb();
    const ev = {
      type: "IssuesEvent",
      repo: { name: "o/r" },
      payload: { issue: { title: "no number here" } },
    };
    processEvent(ctxFor(db), ev, 1);
    expect((db.query("SELECT COUNT(*) AS c FROM item").get() as { c: number }).c).toBe(0);
    db.close();
  });
});

describe("selectPrEnrichCandidates — malformed rows", () => {
  test("ids with no repo before '#', or a non-numeric suffix, are skipped; non-object metadata stays a candidate", () => {
    const db = createMemoryIndexDb();
    seedPr(db, "nohash", "PR #1", {});
    seedPr(db, "#5", "PR #5", {});
    seedPr(db, "o/r#abc", "PR #abc", {});
    seedPr(db, "o/r#9", "Real title", { additions: 1 });
    // Valid JSON that is not an object: it cannot be proven to carry stats, so the row must stay
    // a candidate rather than be read as "already enriched".
    db.run("UPDATE item SET metadata = '[1]' WHERE external_id = 'o/r#9'");

    expect(selectPrEnrichCandidates(db, 10)).toEqual([
      { externalId: "o/r#9", repoFull: "o/r", num: 9 },
    ]);
    db.close();
  });
});

describe("events sync — /user, cursor and page edges", () => {
  let mock: StubFetch;

  beforeEach(() => {
    mock = new StubFetch();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  test("a non-ok /user response fails the sync with its status and body excerpt", async () => {
    mock.respondWithText("GET", USER_URL, "upstream exploded", { status: 500 });
    const db = createMemoryIndexDb();
    const sync = createGithubSyncable(ENSURE_MCP);

    await expect(sync.sync(ctxFor(db), null)).rejects.toThrow(
      "GitHub /user 500: upstream exploded",
    );
    expect(mock.calls.map((c) => c.url)).toEqual([USER_URL]);
    db.close();
  });

  test.each([
    ["an array", [1]],
    // `null` is the case that separates a shape guard from luck: reading `login` off it throws.
    ["null", null],
  ])("a /user body that is %s, not an object, fails as a missing login", async (_label, body) => {
    mock.respond("GET", USER_URL, body);
    const db = createMemoryIndexDb();

    await expect(createGithubSyncable(ENSURE_MCP).sync(ctxFor(db), null)).rejects.toThrow(
      "GitHub /user: response missing login",
    );
    db.close();
  });

  test.each([
    ["a null etag", { etag: null, login: "octo" }],
    ["a non-string etag", { etag: 42, login: "octo" }],
  ])("a cached login with %s skips /user and sends no If-None-Match", async (_label, payload) => {
    mock.respond("GET", EVENTS_URL, [], { headers: { etag: '"e2"' } });
    const db = createMemoryIndexDb();

    const r = await createGithubSyncable(ENSURE_MCP).sync(ctxFor(db), cursorWith(payload));

    expect(mock.calls.map((c) => c.url)).toEqual([EVENTS_URL]);
    expect(mock.calls[0]?.headers["if-none-match"]).toBeUndefined();
    expect(decodeNimbusJsonCursorPayload(r.cursor ?? "", CURSOR_PREFIX)).toEqual({
      etag: '"e2"',
      login: "octo",
    });
    db.close();
  });

  test.each([
    [99, false],
    [100, true],
  ])("a page of %d events warns that the window may have overflowed: %p", async (count, warns) => {
    const events = Array.from({ length: count }, (_, i) => ({
      type: "PushEvent",
      repo: { name: "o/r" },
      payload: { ref: `refs/heads/b${String(i)}` },
    }));
    mock.respond("GET", EVENTS_URL, events, { headers: { etag: '"e3"' } });
    const db = createMemoryIndexDb();
    const { logger, lines } = capturingLogger();

    const r = await createGithubSyncable(ENSURE_MCP).sync(
      { ...ctxFor(db), logger },
      cursorWith({ etag: null, login: "octo" }),
    );

    expect(r.itemsUpserted).toBe(0);
    const fullPage = lines().filter(
      (l) => l.level === WARN && l.msg.startsWith("github events page was full"),
    );
    expect(fullPage).toHaveLength(warns ? 1 : 0);
    if (warns) expect(fullPage[0]?.["events"]).toBe(100);
    db.close();
  });
});

describe("events sync — the two best-effort passes", () => {
  let mock: StubFetch;

  beforeEach(() => {
    mock = new StubFetch();
    mock.install();
    mock.respond("GET", EVENTS_URL, [], { headers: { etag: '"e4"' } });
  });

  afterEach(() => {
    mock.restore();
  });

  const cachedLogin = (): string => cursorWith({ etag: null, login: "octo" });

  test("a rate limit during PR detail enrichment is not swallowed: it ends the sync", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "o/r#5", "PR #5", {});
    mock.respondWithText("GET", "https://api.github.com/repos/o/r/pulls/5", "slow down", {
      status: 429,
    });

    const run = createGithubSyncable(ENSURE_MCP).sync(ctxFor(db), cachedLogin());

    await expect(run).rejects.toBeInstanceOf(RateLimitError);
    await expect(run).rejects.toThrow("GitHub pull detail: rate limited (429)");
    db.close();
  });

  test("a rate limit on PR changed files is not swallowed: it ends the sync", async () => {
    const db = createMemoryIndexDb();
    // A real title and stats: not an enrichment candidate, only a changed-file candidate.
    seedPr(db, "o/r#7", "Add retries", { additions: 3 });
    mock.respondWithText("GET", FILES_RE, "slow down", { status: 429 });

    const run = createGithubSyncable(ENSURE_MCP).sync(ctxFor(db), cachedLogin());

    await expect(run).rejects.toBeInstanceOf(RateLimitError);
    await expect(run).rejects.toThrow("GitHub pull files: rate limited (429)");
    db.close();
  });

  test("a stored PR id with no numeric suffix costs no files request and stays uncovered", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "o/r#x", "Odd id", { additions: 1 });
    const { logger, lines } = capturingLogger();

    const r = await createGithubSyncable(ENSURE_MCP).sync({ ...ctxFor(db), logger }, cachedLogin());

    expect(r.itemsUpserted).toBe(0);
    expect(mock.calls.map((c) => c.url)).toEqual([EVENTS_URL]);
    const covered = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(covered.c).toBe(0);
    expect(
      lines().some((l) => l.level === WARN && l.msg.startsWith("PR changed-file page unavailable")),
    ).toBe(true);
    db.close();
  });

  test("any other failure of the changed-file pass is logged and the sync still succeeds", async () => {
    const db = createMemoryIndexDb();
    const { logger, lines } = capturingLogger();
    const ctx: SyncContext = {
      ...ctxFor(db),
      logger,
      prFileCandidates: () => {
        throw new Error("disk I/O error");
      },
    };

    const r = await createGithubSyncable(ENSURE_MCP).sync(ctx, cachedLogin());

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor?.startsWith(CURSOR_PREFIX)).toBe(true);
    const warned = lines().filter(
      (l) => l.level === WARN && l.msg === "PR changed-file pass failed (non-fatal)",
    );
    expect(warned).toHaveLength(1);
    expect(String(warned[0]?.["err"])).toContain("disk I/O error");
    db.close();
  });
});

describe("githubFetchOneUrlIsSupported", () => {
  test.each([
    ["https://github.com/o/r/pull/7", true],
    ["https://github.example.com/team/svc/pull/1234", true],
    ["https://github.com/o/r/pull/7/files", false],
    ["https://github.com/o/r/issues/7", false],
    ["https://github.com/../r/pull/7", false],
    ["https://github.com/o/.../pull/7", false],
  ])("%s → %p", (url, supported) => {
    expect(githubFetchOneUrlIsSupported(url)).toBe(supported);
  });
});
