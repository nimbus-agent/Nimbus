import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBitbucketSyncable } from "../../../src/connectors/bitbucket-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureBitbucketMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-bbkt1:";

const WORKSPACE_RE = /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\?[^/]*role=member[^/]*$/;
const PR_LIST_RE_ANY =
  /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\?/;
const DIFFSTAT_RE_ANY =
  /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\/\d+\/diffstat\?/;

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function authHeaderForUserPass(user: string, pass: string): string {
  const creds = `${user}:${pass}`;
  return `Basic ${Buffer.from(creds, "utf8").toString("base64")}`;
}

async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

let fixture: ConnectorSyncFixture;

beforeEach(async () => {
  fixture = createConnectorSyncFixture();
  fixture.fetchMock.install();
  await fixture.vault.set("bitbucket.username", "bitbucket-stub-username");
  await fixture.vault.set("bitbucket.app_password", "bitbucket-stub-pass");
});

afterEach(() => {
  fixture.cleanup();
});

describe("bitbucket-sync — credential short-circuits", () => {
  test("returns noop when neither vault key is set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createBitbucketSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("bitbucket"), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when username is set but app_password is missing", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("bitbucket.username", "bitbucket-stub-username");
      const syncable = createBitbucketSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("bitbucket"), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when username is empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("bitbucket.username", "");
      await iso.vault.set("bitbucket.app_password", "bitbucket-stub-pass");
      const syncable = createBitbucketSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("bitbucket"), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when app_password is empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("bitbucket.username", "bitbucket-stub-username");
      await iso.vault.set("bitbucket.app_password", "");
      const syncable = createBitbucketSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("bitbucket"), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("syncNoopResult preserves the incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const incomingCursor = "nimbus-bbkt1:opaque-cursor-value";
      const syncable = createBitbucketSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("bitbucket"), incomingCursor);
      expect(res.cursor).toBe(incomingCursor);
    });
  });
});

function stageEmptyWorkspace(): void {
  fixture.fetchMock.respond("GET", WORKSPACE_RE, { values: [], next: null });
}

describe("bitbucket-sync — cursor decode failures", () => {
  test("null cursor falls back to default sync state and fetches workspace", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
    expect(fixture.fetchMock.calls[0].url).toMatch(WORKSPACE_RE);
  });

  test("empty string cursor falls back to default", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      "",
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("non-base64 cursor body falls back to default", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("cursor JSON parses to array → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor JSON parses to primitive (string) → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor("plain-string"),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor JSON parses to null → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor(null),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor missing required since → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({ pendingRepos: [] }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-string since → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({ since: 42, pendingRepos: [] }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with empty since → falls back", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({ since: "", pendingRepos: [] }),
    );
    expect(res.hasMore).toBe(false);
  });

  test("cursor with non-array pendingRepos → falls back to empty list (decodes successfully)", async () => {
    stageEmptyWorkspace();
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({ since: "2026-04-01T00:00:00.000Z", pendingRepos: "not-an-array" }),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(1);
  });

  test("cursor pendingRepos array filters non-string / no-slash entries", async () => {
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({
        since: "2026-04-01T00:00:00.000Z",
        pendingRepos: [42, "no-slash", null, { foo: "bar" }],
        reposNext: null,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: true,
      }),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(0);
  });
});

describe("bitbucket-sync — HTTP request paths", () => {
  test("sends basic auth header on workspace list", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);

    expect(fixture.fetchMock.calls).toHaveLength(1);
    const expectedAuth = authHeaderForUserPass("bitbucket-stub-username", "bitbucket-stub-pass");
    expect(fixture.fetchMock.calls[0].headers["authorization"]).toBe(expectedAuth);
  });

  test("workspace list URL contains role=member and pagelen=30", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const url = fixture.fetchMock.calls[0].url;
    expect(url).toContain("role=member");
    expect(url).toContain("pagelen=30");
  });

  test("PR list URL contains pagelen=50, sort=-updated_on, and q=updated_on>", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(1);
    const url = prCalls[0].url;
    expect(url).toContain("pagelen=50");
    expect(url).toContain("sort=-updated_on");
    expect(url).toContain("q=updated_on");
    expect(url).toContain("updated_on%3E");
  });

  test("PR list URL encodes workspace and repo slug components", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "my-team/my-repo" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0].url).toContain("/repositories/my-team/my-repo/pullrequests");
  });

  test("429 with Retry-After header → penalises rate limiter and throws", async () => {
    fixture.fetchMock.respond(
      "GET",
      WORKSPACE_RE,
      { error: { message: "Too many requests" } },
      { status: 429, headers: { "retry-after": "120" } },
    );
    await expect(
      createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null),
    ).rejects.toThrow(/Bitbucket 429/);
  });

  test("429 with missing Retry-After header → uses default 60s and throws", async () => {
    fixture.fetchMock.respond(
      "GET",
      WORKSPACE_RE,
      { error: { message: "Too many requests" } },
      { status: 429 },
    );
    await expect(
      createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null),
    ).rejects.toThrow(/Bitbucket 429/);
  });

  test("429 with non-numeric Retry-After header → falls back to 60_000ms penalty", async () => {
    fixture.fetchMock.respond(
      "GET",
      WORKSPACE_RE,
      { error: "too many" },
      { status: 429, headers: { "retry-after": "later" } },
    );
    await expect(
      createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null),
    ).rejects.toThrow(/Bitbucket 429/);
  });

  test("non-200 non-429 throws with status code surfaced", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, { error: "server" }, { status: 500 });
    await expect(
      createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null),
    ).rejects.toThrow(/Bitbucket 500/);
  });

  test("invalid JSON in response body throws", async () => {
    fixture.fetchMock.respondWithText("GET", WORKSPACE_RE, "<html>not json</html>");
    await expect(
      createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null),
    ).rejects.toThrow(/Bitbucket: invalid JSON/);
  });
});

describe("bitbucket-sync — indexing skip paths", () => {
  test("pull request with missing id is skipped (no upsert)", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [
        { title: "no id", state: "OPEN" }, // missing id → skipped inside upsertFromPullRequest
        { id: 1, title: "kept" }, // valid
      ],
      next: null,
    });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'bitbucket'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("acme/app#1");
    expect(res.hasMore).toBe(false);

    expect(res.itemsUpserted).toBe(1);
  });

  test("pull request with malformed full_name (no slash) is filtered out at workspace parse", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [
        { full_name: "no-slash-name" }, // dropped
        { full_name: "" }, // dropped (no slash)
        { full_name: 42 }, // not a string → dropped
        {}, // no full_name → dropped
        "not-a-record", // not a record → dropped
        { full_name: "acme/app" }, // kept
      ],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0].url).toContain("/repositories/acme/app/pullrequests");
  });

  test("pull request with missing author still upserts; row has author_id null", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 5, title: "no-author", state: "OPEN" }],
      next: null,
    });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'bitbucket' AND external_id = 'acme/app#5'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.author_id).toBeNull();
  });

  test("pull request with empty uuid author → authorId null (uuid is empty string)", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [
        {
          id: 6,
          title: "empty uuid",
          state: "OPEN",
          author: { display_name: "Ghost", uuid: "" },
        },
      ],
      next: null,
    });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'bitbucket' AND external_id = 'acme/app#6'",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });

  test("non-record entry in PR values array is skipped", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: ["string-entry", 42, null, { id: 10, title: "kept" }],
      next: null,
    });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'bitbucket'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("acme/app#10");
  });

  test("title >512 chars is sliced; missing title falls back to 'PR #<id>'", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    const longTitle = "x".repeat(600);
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 11, title: longTitle }, { id: 12 }],
      next: null,
    });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const long = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'bitbucket' AND external_id = 'acme/app#11'",
      )
      .get();
    const fallback = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'bitbucket' AND external_id = 'acme/app#12'",
      )
      .get();
    expect(long?.title).toHaveLength(512);
    expect(fallback?.title).toBe("PR #12");
  });

  test("malformed updated_on → modifiedAt falls back to now", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 13, title: "bad date", updated_on: "totally-not-a-date" }],
      next: null,
    });
    const beforeMs = Date.now();
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    const afterMs = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'bitbucket' AND external_id = 'acme/app#13'",
      )
      .get();
    expect(row?.modified_at).toBeGreaterThanOrEqual(beforeMs);
    expect(row?.modified_at).toBeLessThanOrEqual(afterMs);
  });
});

describe("bitbucket-sync — phase machine transitions", () => {
  test("first sync (null cursor) → workspace then PR scan, returns hasMore=false when all repos drain in one call", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }, { full_name: "acme/lib" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(false);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(2);
  });

  test("cursor with activeRepo + prNext resumes mid-pagination (no workspace fetch)", async () => {
    const resumeUrl = "https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests?page=2";
    fixture.fetchMock.respond("GET", resumeUrl, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({
        since: "2026-04-01T00:00:00.000Z",
        pendingRepos: [],
        reposNext: null,
        activeRepo: "acme/app",
        prNext: resumeUrl,
        repositoryPagesExhausted: true,
      }),
    );
    expect(res.hasMore).toBe(false);
    const calls = fixture.fetchMock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(resumeUrl);
  });

  test("cursor with pending repos + exhausted=true skips workspace fetch", async () => {
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({
        since: "2026-04-01T00:00:00.000Z",
        pendingRepos: ["acme/app"],
        reposNext: null,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: true,
      }),
    );
    expect(res.hasMore).toBe(false);
    const wsCalls = fixture.fetchMock.calls.filter((c) => WORKSPACE_RE.test(c.url));
    expect(wsCalls).toHaveLength(0);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(1);
  });

  test("MAX_REPOS_PER_SYNC enforced — pending count > 3 returns hasMore=true with the overflow preserved", async () => {
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({
        since: "2026-04-01T00:00:00.000Z",
        pendingRepos: ["a/1", "a/2", "a/3", "a/4", "a/5"],
        reposNext: null,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: true,
      }),
    );
    expect(res.hasMore).toBe(true);
    const prCalls = fixture.fetchMock.calls.filter((c) => PR_LIST_RE_ANY.test(c.url));
    expect(prCalls).toHaveLength(3);
  });

  test("MAX_PR_PAGES_PER_REPO reached → returns hasMore=true with activeRepo + prNext preserved", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    let pageCount = 0;
    for (let i = 1; i <= 7; i++) {
      const next = i < 7 ? `https://api.bitbucket.org/2.0/pr-page-${String(i + 1)}` : null;
      fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next });
      pageCount++;
    }
    for (let i = 2; i <= 7; i++) {
      fixture.fetchMock.respond("GET", `https://api.bitbucket.org/2.0/pr-page-${String(i)}`, {
        values: [],
        next: i < 7 ? `https://api.bitbucket.org/2.0/pr-page-${String(i + 1)}` : null,
      });
    }
    expect(pageCount).toBe(7);
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(true);
    const raw = res.cursor!.slice(CURSOR_PREFIX.length);
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      activeRepo: string | null;
      prNext: string | null;
    };
    expect(decoded.activeRepo).toBe("acme/app");
    expect(decoded.prNext).toBe("https://api.bitbucket.org/2.0/pr-page-7");
  });

  test("cycle-complete advances `since` to maxUpdated when newer than start", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 100, title: "pr-100", updated_on: "2099-01-01T00:00:00.000000+00:00" }],
      next: null,
    });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(false);
    const decoded = JSON.parse(
      Buffer.from(res.cursor!.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { since: string };
    expect(decoded.since >= "2099-01-01T00:00:00.000000+00:00").toBe(true);
  });

  test("workspace list with next page → reposNext preserved, repositoryPagesExhausted=false", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: "https://api.bitbucket.org/2.0/repositories?page=2",
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(res.cursor!.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { reposNext: string | null; repositoryPagesExhausted: boolean };
    expect(decoded.reposNext).toBe("https://api.bitbucket.org/2.0/repositories?page=2");
    expect(decoded.repositoryPagesExhausted).toBe(false);
  });

  test("workspace list with empty workspace → next link null sets repositoryPagesExhausted=true", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, { values: [], next: null });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(false);
    const decoded = JSON.parse(
      Buffer.from(res.cursor!.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { repositoryPagesExhausted: boolean };
    expect(decoded.repositoryPagesExhausted).toBe(false);
  });

  test("cursor with workspace next page link in reposNext uses that URL directly", async () => {
    const customNextUrl = "https://api.bitbucket.org/2.0/repositories?cursor=abc";
    fixture.fetchMock.respond("GET", customNextUrl, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      encodeCursor({
        since: "2026-04-01T00:00:00.000Z",
        pendingRepos: [],
        reposNext: customNextUrl,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: false,
      }),
    );
    const calls = fixture.fetchMock.calls;
    expect(calls[0].url).toBe(customNextUrl);
  });
});

describe("bitbucket-sync — cycle-completion and integration", () => {
  test("end-to-end: 2 repos × 1 PR each → 2 items upserted; cursor advances", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }, { full_name: "acme/lib" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [
        {
          id: 200,
          title: "PR-200",
          state: "OPEN",
          updated_on: "2026-04-15T10:00:00.000000+00:00",
          author: {
            display_name: "Dev",
            uuid: "{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}",
          },
          links: { html: { href: "https://bitbucket.org/acme/x/pull-requests/200" } },
        },
      ],
      next: null,
    });
    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.hasMore).toBe(false);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'bitbucket' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0].external_id).toBe("acme/app#200");
    expect(rows[1].external_id).toBe("acme/lib#200");
    const authorRow = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE external_id = 'acme/app#200'",
      )
      .get();
    expect(authorRow?.author_id).not.toBeNull();
  });

  test("multi-call: workspace page-1 → workspace page-2 → drain via state preservation", async () => {
    const page2Url = "https://api.bitbucket.org/2.0/repositories?page=2";
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app1" }],
      next: page2Url,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, { values: [], next: null });

    const r1 = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(r1.hasMore).toBe(true);
    const decoded1 = JSON.parse(
      Buffer.from(r1.cursor!.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { reposNext: string | null };
    expect(decoded1.reposNext).toBe(page2Url);

    fixture.fetchMock.respond("GET", page2Url, {
      values: [{ full_name: "acme/app2" }],
      next: null,
    });
    const r2 = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      r1.cursor,
    );
    expect(r2.hasMore).toBe(false);
  });

  test("notifications log records nothing — bitbucket-sync emits no notifications", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, { values: [], next: null });
    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);
    expect(fixture.notifications.emitted).toHaveLength(0);
  });
});

/**
 * End-to-end wiring for the PR changed-file pass, driven through the real syncable rather than
 * through `runPrFilePass` with a hand-written `fetchPage`. GitHub has five such tests; GitLab and
 * Bitbucket had none, so nothing would have caught the pass being dropped from either sync flow.
 *
 * Bitbucket's is the one most worth pinning: the pass runs inside `syncResult`, an async helper
 * every `return` in the sync body awaits, so it fires on all four exits rather than at one call
 * site. Nothing else in this file exercises that.
 */
describe("bitbucket-sync — PR changed-file pass (end-to-end)", () => {
  test("fetches the PR diffstat for an uncovered PR and writes its coverage row", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 42, title: "add a rate limiter" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", DIFFSTAT_RE_ANY, {
      values: [
        { status: "modified", old: { path: "src/a.ts" }, new: { path: "src/a.ts" } },
        // An added file has no `old` side at all — reading `.path` off it is how an empty-path
        // row would be written.
        { status: "added", old: null, new: { path: "src/b.ts" } },
      ],
      next: null,
    });

    await createBitbucketSyncable(ENSURE_MCP).sync(fixture.createSyncContext("bitbucket"), null);

    const diffstatCalls = fixture.fetchMock.calls.filter((c) => DIFFSTAT_RE_ANY.test(c.url));
    expect(diffstatCalls).toHaveLength(1);
    const diffstatCall = diffstatCalls[0];
    if (diffstatCall === undefined) throw new Error("expected exactly one diffstat request");
    expect(diffstatCall.url).toContain("/repositories/acme/app/pullrequests/42/diffstat?");
    // Bitbucket's page-size parameter is `pagelen`, not GitHub/GitLab's `per_page`.
    expect(diffstatCall.url).toContain("pagelen=100");
    expect(diffstatCall.url).toContain("page=1");
    expect(diffstatCall.headers["authorization"]).toBe(
      authHeaderForUserPass("bitbucket-stub-username", "bitbucket-stub-pass"),
    );

    const state = fixture.db
      .query<{ stored_count: number; truncated: number }, []>(
        "SELECT stored_count, truncated FROM pr_files_state WHERE item_id = 'bitbucket:acme/app#42'",
      )
      .get();
    expect(state?.stored_count).toBe(2);
    expect(state?.truncated).toBe(0);

    const paths = fixture.db
      .query<{ path: string }, []>(
        "SELECT path FROM pr_changed_file WHERE item_id = 'bitbucket:acme/app#42' ORDER BY path",
      )
      .all()
      .map((r) => r.path);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a non-ok diffstat response leaves the PR uncovered and does not fail the sync", async () => {
    fixture.fetchMock.respond("GET", WORKSPACE_RE, {
      values: [{ full_name: "acme/app" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", PR_LIST_RE_ANY, {
      values: [{ id: 42, title: "add a rate limiter" }],
      next: null,
    });
    fixture.fetchMock.respond("GET", DIFFSTAT_RE_ANY, { type: "error" }, { status: 404 });

    const res = await createBitbucketSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext("bitbucket"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);

    // Assert the request HAPPENED before asserting nothing was written — otherwise "zero coverage
    // rows" is equally true of a pass that never ran, and the test proves nothing.
    expect(fixture.fetchMock.calls.filter((c) => DIFFSTAT_RE_ANY.test(c.url))).toHaveLength(1);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);
  });
});
