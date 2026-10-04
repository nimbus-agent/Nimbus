/**
 * Edge paths of the Bitbucket connector that `bitbucket-sync.test.ts` and
 * `test/unit/connectors/bitbucket-sync.test.ts` do not reach: non-object list and page bodies,
 * PR links without a usable href, a uuid-only author, malformed pending repos, a resumed repo that
 * outlasts the per-repo page cap, the changed-file pass's failure modes, and the URL pre-check.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { RateLimitError, type SyncContext } from "../sync/types.ts";
import { bitbucketFetchOneUrlIsSupported, createBitbucketSyncable } from "./bitbucket-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-bbkt1:";
const API = "https://api.bitbucket.org/2.0";
const ENSURE_MCP = { ensureBitbucketMcpRunning: async (): Promise<void> => {} };
const WORKSPACE_URL = `${API}/repositories?role=member&pagelen=30`;
const PR_LIST_RE =
  /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\?/;
const DIFFSTAT_RE = /\/diffstat\?/;
const WARN = 40;

type CursorShape = {
  since: string;
  pendingRepos: string[];
  reposNext: string | null;
  activeRepo: string | null;
  prNext: string | null;
  repositoryPagesExhausted: boolean;
};

/** A cursor for a cycle with nothing left to list or scan: the sync makes no list/PR request. */
const SETTLED: CursorShape = {
  since: "2026-04-01T00:00:00.000Z",
  pendingRepos: [],
  reposNext: null,
  activeRepo: null,
  prNext: null,
  repositoryPagesExhausted: true,
};

function cursorWith(c: CursorShape): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decoded(cursor: string | null): CursorShape {
  return decodeNimbusJsonCursorPayload(cursor ?? "", CURSOR_PREFIX) as CursorShape;
}

function ctxFor(db: Database): SyncContext {
  return syncTestContext(
    db,
    createStubVault({ "bitbucket.username": "u", "bitbucket.app_password": "p" }),
    "bitbucket",
  );
}

type LogLine = { level: number; msg: string; [k: string]: unknown };

function capturingLogger(): { logger: Logger; lines: () => LogLine[] } {
  const raw: string[] = [];
  const logger = pino({ level: "debug" }, { write: (s: string) => raw.push(s) });
  return { logger, lines: () => raw.map((s) => JSON.parse(s) as LogLine) };
}

function seedPr(db: Database, externalId: string): void {
  upsertIndexedItem(db, {
    service: "bitbucket",
    type: "pr",
    externalId,
    title: `PR ${externalId}`,
    bodyPreview: "",
    url: null,
    canonicalUrl: null,
    modifiedAt: 1000,
    metadata: {},
    syncedAt: 1000,
  });
}

function prRows(db: Database): { external_id: string; url: string | null }[] {
  return db
    .query("SELECT external_id, url FROM item WHERE service = 'bitbucket' ORDER BY external_id")
    .all() as { external_id: string; url: string | null }[];
}

let mock: StubFetch;

beforeEach(() => {
  mock = new StubFetch();
  mock.install();
});

afterEach(() => {
  mock.restore();
});

describe("listing and paging edge bodies", () => {
  test.each([
    ["is a JSON array, not an object", []],
    // An array merely has no `values`; `null` throws on any property read, so it is the case
    // that shows the object guard runs before the body is read.
    ["is JSON null", null],
    // An object, not a string: iterating a string would just yield characters with no
    // `full_name`, so only a non-iterable value shows the array guard doing its job.
    ["has a non-array values", { values: { full_name: "ws/repo" } }],
  ])("a repository list that %s yields no repos and closes the cycle", async (_label, body) => {
    mock.respond("GET", WORKSPACE_URL, body);
    const db = createMemoryIndexDb();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(ctxFor(db), null);

    expect(mock.calls.map((c) => c.url)).toEqual([WORKSPACE_URL]);
    expect(r.hasMore).toBe(false);
    expect(r.itemsUpserted).toBe(0);
    const next = decoded(r.cursor);
    expect(next.pendingRepos).toEqual([]);
    expect(next.reposNext).toBeNull();
    db.close();
  });

  test.each([
    ["is a JSON array, not an object", []],
    ["is JSON null", null],
    ["has a non-array values", { values: { id: 1 } }],
  ])("a PR page that %s upserts nothing and ends that repo", async (_label, body) => {
    mock.respond("GET", PR_LIST_RE, body);
    const db = createMemoryIndexDb();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      ctxFor(db),
      cursorWith({ ...SETTLED, pendingRepos: ["ws/repo"] }),
    );

    expect(mock.calls.filter((c) => PR_LIST_RE.test(c.url))).toHaveLength(1);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(prRows(db)).toEqual([]);
    db.close();
  });

  test("a PR with no html link, or an html link without href, is indexed with a null url", async () => {
    const href = "https://bitbucket.org/ws/repo/pull-requests/3";
    mock.respond("GET", PR_LIST_RE, {
      values: [
        { id: 1, title: "no html", links: { self: { href: `${API}/x` } } },
        { id: 2, title: "html without href", links: { html: {} } },
        { id: 3, title: "control", links: { html: { href } } },
      ],
    });
    const db = createMemoryIndexDb();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      ctxFor(db),
      cursorWith({ ...SETTLED, pendingRepos: ["ws/repo"] }),
    );

    expect(r.itemsUpserted).toBe(3);
    expect(prRows(db)).toEqual([
      { external_id: "ws/repo#1", url: null },
      { external_id: "ws/repo#2", url: null },
      { external_id: "ws/repo#3", url: href },
    ]);
    db.close();
  });

  test("an author with a uuid but no display_name is resolved under its normalized uuid", async () => {
    mock.respond("GET", PR_LIST_RE, {
      values: [{ id: 4, title: "uuid only", author: { uuid: "{ABC-123}" } }],
    });
    const db = createMemoryIndexDb();
    const seen: PersonSyncHints[] = [];
    const ctx: SyncContext = {
      ...ctxFor(db),
      resolvePerson: (hints) => {
        seen.push(hints);
        return "person-1";
      },
    };

    await createBitbucketSyncable(ENSURE_MCP).sync(
      ctx,
      cursorWith({ ...SETTLED, pendingRepos: ["ws/repo"] }),
    );

    expect(seen).toEqual([{ bitbucketUuid: "abc-123", displayName: "abc-123" }]);
    const row = db.query("SELECT author_id FROM item WHERE external_id = 'ws/repo#4'").get() as {
      author_id: string | null;
    };
    expect(row.author_id).toBe("person-1");
    db.close();
  });

  test("pending repos with an empty workspace or slug are skipped without a request", async () => {
    const db = createMemoryIndexDb();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      ctxFor(db),
      cursorWith({ ...SETTLED, pendingRepos: ["ws/", "/slug"] }),
    );

    expect(mock.calls).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(decoded(r.cursor).pendingRepos).toEqual([]);
    db.close();
  });

  test("a resumed repo that still has pages after the per-repo cap stays active for the next tick", async () => {
    const page = (n: number): string =>
      `${API}/repositories/ws/repo/pullrequests?page=${String(n)}`;
    for (let n = 1; n <= 6; n++) {
      mock.respond("GET", page(n), {
        values: [{ id: n, title: `pr ${String(n)}`, updated_on: "2026-05-01T00:00:00Z" }],
        next: page(n + 1),
      });
    }
    mock.respond("GET", DIFFSTAT_RE, { values: [] });
    const db = createMemoryIndexDb();
    // Six pages exceed Bitbucket's default burst (5), and a default limiter would really sleep
    // ~1s for the sixth token. A wider burst keeps the test instant without touching the code
    // under test, which acquires a token per page either way.
    const rateLimiter = new ProviderRateLimiter({
      bitbucket: { requestsPerMinute: 60, burstSize: 10 },
    });

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      { ...ctxFor(db), rateLimiter },
      cursorWith({ ...SETTLED, activeRepo: "ws/repo", prNext: page(1) }),
    );

    // Exactly the six capped pages, no workspace listing, and page 7 is left for next time.
    // (The changed-file pass then spends the spare tokens on diffstats for the new PRs; those
    // are stubbed above and are not what this test is about.)
    const listCalls = mock.calls.filter((c) => c.url.includes("/pullrequests?page="));
    expect(listCalls.map((c) => c.url)).toEqual([1, 2, 3, 4, 5, 6].map(page));
    expect(mock.calls.some((c) => c.url === WORKSPACE_URL)).toBe(false);
    expect(r.hasMore).toBe(true);
    expect(r.itemsUpserted).toBe(6);
    const next = decoded(r.cursor);
    expect(next.activeRepo).toBe("ws/repo");
    expect(next.prNext).toBe(page(7));
    db.close();
  });
});

describe("the changed-file pass", () => {
  test("a 429 on a PR diffstat is not swallowed: it ends the sync with a rate-limit error", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "ws/repo#5");
    mock.respondWithText("GET", DIFFSTAT_RE, "slow down", { status: 429 });

    const run = createBitbucketSyncable(ENSURE_MCP).sync(ctxFor(db), cursorWith(SETTLED));

    await expect(run).rejects.toBeInstanceOf(RateLimitError);
    await expect(run).rejects.toThrow("Bitbucket PR diffstat: rate limited (429)");
    db.close();
  });

  test("an unparseable diffstat leaves the PR uncovered and the sync still succeeds", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "ws/repo#5");
    mock.respondWithText("GET", DIFFSTAT_RE, "<html>not json</html>");
    const { logger, lines } = capturingLogger();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      { ...ctxFor(db), logger },
      cursorWith(SETTLED),
    );

    expect(r.hasMore).toBe(false);
    expect(mock.calls.filter((c) => DIFFSTAT_RE.test(c.url))).toHaveLength(1);
    const covered = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(covered.c).toBe(0);
    expect(
      lines().filter(
        (l) => l.level === WARN && l.msg.startsWith("PR changed-file page unavailable"),
      ),
    ).toHaveLength(1);
    db.close();
  });

  test("stored ids with no '#' or a non-numeric suffix make no diffstat request", async () => {
    const db = createMemoryIndexDb();
    seedPr(db, "ws/repo!5");
    seedPr(db, "ws/repo#x");
    const { logger, lines } = capturingLogger();

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(
      { ...ctxFor(db), logger },
      cursorWith(SETTLED),
    );

    expect(r.hasMore).toBe(false);
    expect(mock.calls).toEqual([]);
    expect(
      lines().filter(
        (l) => l.level === WARN && l.msg.startsWith("PR changed-file page unavailable"),
      ),
    ).toHaveLength(2);
    db.close();
  });

  test("any other failure of the pass is logged and the sync still succeeds", async () => {
    const db = createMemoryIndexDb();
    const { logger, lines } = capturingLogger();
    const ctx: SyncContext = {
      ...ctxFor(db),
      logger,
      prFileCandidates: () => {
        throw new Error("database is locked");
      },
    };

    const r = await createBitbucketSyncable(ENSURE_MCP).sync(ctx, cursorWith(SETTLED));

    expect(r.hasMore).toBe(false);
    const warned = lines().filter(
      (l) => l.level === WARN && l.msg === "PR changed-file pass failed (non-fatal)",
    );
    expect(warned).toHaveLength(1);
    expect(String(warned[0]?.["err"])).toContain("database is locked");
    db.close();
  });
});

describe("bitbucketFetchOneUrlIsSupported", () => {
  test.each([
    ["https://bitbucket.org/ws/repo/pull-requests/7", true],
    ["https://bitbucket.example.com/team/svc/pull-requests/1234", true],
    ["https://bitbucket.org/ws/repo/pull-requests/7/diff", false],
    ["https://bitbucket.org/ws/repo/pull/7", false],
    ["https://bitbucket.org/../repo/pull-requests/7", false],
    ["https://bitbucket.org/ws/.../pull-requests/7", false],
  ])("%s → %p", (url, supported) => {
    expect(bitbucketFetchOneUrlIsSupported(url)).toBe(supported);
  });
});
