import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGithubSyncable } from "../../../src/connectors/github-sync.ts";
import { RateLimitError, UnauthenticatedError } from "../../../src/sync/types.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureGithubMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-ghub1:";

const USER_URL = "https://api.github.com/user";
const EVENTS_RE = /^https:\/\/api\.github\.com\/users\/[^/]+\/events\?per_page=100$/;

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor<T>(cursor: string): T {
  const body = cursor.slice(CURSOR_PREFIX.length);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
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
  await fixture.vault.set("github.pat", "github-stub-pat");
});

afterEach(() => {
  fixture.cleanup();
});

describe("github-sync — credential short-circuits", () => {
  test("returns noop when github.pat is not set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createGithubSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when github.pat is the empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("github.pat", "");
      const syncable = createGithubSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("syncNoopResult preserves the incoming cursor on credential miss", async () => {
    await withIsolatedFixture(async (iso) => {
      const incomingCursor = "nimbus-ghub1:opaque-cursor-value";
      const syncable = createGithubSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), incomingCursor);
      expect(res.cursor).toBe(incomingCursor);
    });
  });
});

function stageHappyPath(): void {
  fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
  fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e1"' } });
}

describe("github-sync — cursor decode failures", () => {
  test("null cursor falls back to default; fetches /user then events", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0].url).toBe(USER_URL);
    expect(fixture.fetchMock.calls[1].url).toMatch(EVENTS_RE);
  });

  test("empty string cursor falls back to default", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("non-base64 / garbage cursor body falls back to default", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("cursor JSON parses to array → falls back", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("cursor JSON parses to null → falls back", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor(null),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls).toHaveLength(2);
  });

  test("cursor missing login (legacy shape) re-resolves via /user", async () => {
    stageHappyPath();
    const res = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ etag: '"legacy"' }),
    );
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls[0].url).toBe(USER_URL);
    expect(fixture.fetchMock.calls[1].url).toMatch(EVENTS_RE);
    expect(fixture.fetchMock.calls[1].headers["if-none-match"]).toBeUndefined();
  });
});

describe("github-sync — HTTP request paths", () => {
  test("sends Bearer Authorization header on /user and events", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e1"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0].headers["authorization"]).toBe("Bearer github-stub-pat");
    expect(fixture.fetchMock.calls[1].headers["authorization"]).toBe("Bearer github-stub-pat");
  });

  test("sends Accept: application/vnd.github+json on both requests", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e1"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    for (const call of fixture.fetchMock.calls) {
      expect(call.headers["accept"]).toBe("application/vnd.github+json");
    }
  });

  test("passes prior etag via If-None-Match on subsequent events fetch", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"first"' } });
    const first = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(first.cursor).not.toBeNull();
    if (first.cursor === null) throw new Error("expected cursor after first sync");

    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"second"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), first.cursor);

    const eventCalls = fixture.fetchMock.calls.filter((c) => EVENTS_RE.test(c.url));
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[1].headers["if-none-match"]).toBe('"first"');
  });

  test("304 returns noop with preserved etag and no items", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"keep"' } });
    const first = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    if (first.cursor === null) throw new Error("expected cursor after first sync");

    fixture.fetchMock.respondWithText("GET", EVENTS_RE, "", { status: 304 });
    const second = await createGithubSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      first.cursor,
    );
    expect(second.itemsUpserted).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  test("401 on events throws UnauthenticatedError", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, { message: "bad creds" }, { status: 401 });
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test("401 on /user throws UnauthenticatedError", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { message: "bad creds" }, { status: 401 });
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test("403 with x-ratelimit-remaining=0 throws RateLimitError with retry-after", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      { message: "rate limit" },
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "90" },
      },
    );
    try {
      await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(RateLimitError);
      const rl = e as RateLimitError;
      const delta = rl.retryAfter.getTime() - Date.now();
      expect(delta).toBeGreaterThanOrEqual(90_000 - 1000);
      expect(delta).toBeLessThanOrEqual(90_000 + 1000);
    }
  });

  test("403 with x-ratelimit-remaining > 0 is treated as non-rate-limit; falls through to !res.ok throw", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      { message: "forbidden" },
      { status: 403, headers: { "x-ratelimit-remaining": "5" } },
    );
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub events 403/);
  });

  test("429 throws RateLimitError honoring retry-after", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      { message: "too many" },
      { status: 429, headers: { "retry-after": "30" } },
    );
    try {
      await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(RateLimitError);
      const rl = e as RateLimitError;
      const delta = rl.retryAfter.getTime() - Date.now();
      expect(delta).toBeGreaterThanOrEqual(30_000 - 1000);
      expect(delta).toBeLessThanOrEqual(30_000 + 1000);
    }
  });

  test("non-200 non-304 non-401 non-429 throws with status code surfaced", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, { error: "server" }, { status: 500 });
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub events 500/);
  });

  test("invalid JSON in events response body throws", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respondWithText("GET", EVENTS_RE, "<html>not json</html>");
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub events: invalid JSON/);
  });

  test("non-array body on events response throws", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, { not: "an-array" });
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub events: expected array/);
  });

  test("/user response missing login throws", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { id: 1 });
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub \/user: response missing login/);
  });

  test("/user invalid JSON throws", async () => {
    fixture.fetchMock.respondWithText("GET", USER_URL, "<html>not json</html>");
    await expect(
      createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitHub \/user: invalid JSON/);
  });
});

describe("github-sync — login resolution", () => {
  test("first sync resolves login from /user before fetching events", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e1"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    expect(fixture.fetchMock.calls).toHaveLength(2);
    expect(fixture.fetchMock.calls[0].url).toBe(USER_URL);
    expect(fixture.fetchMock.calls[1].url).toContain("/users/octocat/events");
  });

  test("subsequent sync with cached login skips /user", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e1"' } });
    const first = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    if (first.cursor === null) throw new Error("expected cursor after first sync");

    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"e2"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), first.cursor);

    const userCalls = fixture.fetchMock.calls.filter((c) => c.url === USER_URL);
    expect(userCalls).toHaveLength(1);
    const eventCalls = fixture.fetchMock.calls.filter((c) => EVENTS_RE.test(c.url));
    expect(eventCalls).toHaveLength(2);
  });
});

describe("github-sync — event filtering", () => {
  test("PullRequestEvent with full payload upserts as 'pr'", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e1",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {
            pull_request: {
              number: 9,
              title: "Fix sync",
              html_url: "https://github.com/acme/app/pull/9",
              updated_at: "2026-04-01T12:00:00Z",
              state: "open",
              user: { login: "alice" },
            },
          },
        },
      ],
      { headers: { etag: '"e1"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; type: string }, []>(
        "SELECT external_id, type FROM item WHERE service = 'github'",
      )
      .get();
    expect(row?.external_id).toBe("acme/app#9");
    expect(row?.type).toBe("pr");
  });

  test("IssuesEvent without pull_request key upserts as 'issue'", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e2",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: {
            issue: {
              number: 11,
              title: "Bug report",
              html_url: "https://github.com/acme/app/issues/11",
              updated_at: "2026-04-02T12:00:00Z",
              state: "open",
              user: { login: "bob" },
            },
          },
        },
      ],
      { headers: { etag: '"e2"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; type: string }, []>(
        "SELECT external_id, type FROM item WHERE service = 'github'",
      )
      .get();
    expect(row?.external_id).toBe("acme/app#issue-11");
    expect(row?.type).toBe("issue");
  });

  test("PullRequestEvent with payload missing pull_request → skipped", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e3",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {}, // no pull_request → processPullRequestPayload returns false
        },
        {
          id: "e4",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {
            pull_request: { number: 20, title: "kept" },
          },
        },
      ],
      { headers: { etag: '"e3"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("acme/app#20");
  });

  test("PR with missing number inside pull_request is dropped at upsertPr", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e5",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {
            pull_request: { title: "no-number" }, // missing number
          },
        },
      ],
      { headers: { etag: '"e5"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .all();
    expect(rows).toHaveLength(0);
  });

  test("IssuesEvent whose issue carries pull_request key is skipped (PR-masquerade defense)", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e6",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: {
            issue: {
              number: 30,
              title: "masquerade",
              pull_request: { url: "https://api.github.com/repos/acme/app/pulls/30" },
            },
          },
        },
        {
          id: "e7",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: { issue: { number: 31, title: "real issue" } },
        },
      ],
      { headers: { etag: '"e6"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .get();
    expect(row?.external_id).toBe("acme/app#issue-31");
  });

  test("event missing repo, full_name, or payload is silently dropped", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        { id: "x1", type: "PullRequestEvent", payload: { pull_request: { number: 1 } } },
        {
          id: "x2",
          type: "IssuesEvent",
          repo: {},
          payload: { issue: { number: 2 } },
        },
        {
          id: "x3",
          type: "PullRequestEvent",
          repo: { full_name: "" },
          payload: { pull_request: { number: 3 } },
        },
        { id: "x4", type: "PullRequestEvent", repo: { full_name: "acme/app" } },
        "garbage",
        {
          id: "x5",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 99, title: "real" } },
        },
      ],
      { headers: { etag: '"e7"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .get();
    expect(row?.external_id).toBe("acme/app#99");
  });

  test("repo with name fallback (no full_name) is accepted", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e8",
          type: "PullRequestEvent",
          repo: { name: "fallback-team/fallback-repo" },
          payload: { pull_request: { number: 50, title: "fallback name" } },
        },
      ],
      { headers: { etag: '"e8"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .get();
    expect(row?.external_id).toBe("fallback-team/fallback-repo#50");
  });
});

describe("github-sync — item indexing", () => {
  test("title fallback when PR title is missing", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e10",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 7 } },
        },
        {
          id: "e11",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: { issue: { number: 8 } },
        },
      ],
      { headers: { etag: '"t1"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const pr = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'github' AND external_id = 'acme/app#7'",
      )
      .get();
    const iss = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'github' AND external_id = 'acme/app#issue-8'",
      )
      .get();
    expect(pr?.title).toBe("PR #7");
    expect(iss?.title).toBe("Issue #8");
  });

  test("title >512 chars is sliced to 512 for PRs and issues", async () => {
    const longTitle = "x".repeat(600);
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e12",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 100, title: longTitle } },
        },
        {
          id: "e13",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: { issue: { number: 101, title: longTitle } },
        },
      ],
      { headers: { etag: '"t2"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const pr = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'github' AND external_id = 'acme/app#100'",
      )
      .get();
    const iss = fixture.db
      .query<{ title: string }, []>(
        "SELECT title FROM item WHERE service = 'github' AND external_id = 'acme/app#issue-101'",
      )
      .get();
    expect(pr?.title).toHaveLength(512);
    expect(iss?.title).toHaveLength(512);
  });

  test("bodyPreview is truncated at 512 characters", async () => {
    const longBody = "y".repeat(900);
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e14",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 200, title: "big body", body: longBody } },
        },
      ],
      { headers: { etag: '"t3"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const row = fixture.db
      .query<{ body_preview: string }, []>(
        "SELECT body_preview FROM item WHERE service = 'github' AND external_id = 'acme/app#200'",
      )
      .get();
    expect(row?.body_preview).toHaveLength(512);
  });

  test("missing updated_at and created_at on a PR → modifiedAt falls back to now()", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e15",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 300, title: "no-timestamps" } },
        },
      ],
      { headers: { etag: '"t4"' } },
    );
    const beforeMs = Date.now();
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const afterMs = Date.now();
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'github' AND external_id = 'acme/app#300'",
      )
      .get();
    expect(row?.modified_at).toBeGreaterThanOrEqual(beforeMs);
    expect(row?.modified_at).toBeLessThanOrEqual(afterMs);
  });

  test("malformed updated_at falls back to created_at when present", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e16",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {
            pull_request: {
              number: 301,
              title: "fallback-created",
              updated_at: "garbage",
              created_at: "2026-04-15T08:30:00Z",
            },
          },
        },
      ],
      { headers: { etag: '"t5"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const row = fixture.db
      .query<{ modified_at: number }, []>(
        "SELECT modified_at FROM item WHERE service = 'github' AND external_id = 'acme/app#301'",
      )
      .get();
    expect(row?.modified_at).toBe(Date.parse("2026-04-15T08:30:00Z"));
  });

  test("PR with email-bearing author resolves a person row", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e17",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: {
            pull_request: {
              number: 400,
              title: "with-email",
              user: { login: "alice", email: "ALICE@Example.COM" },
            },
          },
        },
      ],
      { headers: { etag: '"t6"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'github' AND external_id = 'acme/app#400'",
      )
      .get();
    expect(row?.author_id).not.toBeNull();
  });

  test("PR without user → author_id is null", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "e18",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 401, title: "no-user" } },
        },
      ],
      { headers: { etag: '"t7"' } },
    );
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const row = fixture.db
      .query<{ author_id: string | null }, []>(
        "SELECT author_id FROM item WHERE service = 'github' AND external_id = 'acme/app#401'",
      )
      .get();
    expect(row?.author_id).toBeNull();
  });
});

describe("github-sync — full-cycle integration", () => {
  test("empty events array → noop with preserved etag (no items, hasMore=false)", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"empty1"' } });
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.itemsDeleted).toBe(0);
    expect(res.hasMore).toBe(false);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("expected cursor after empty sync");
    const decoded = decodeCursor<{ etag: string | null; login: string | null }>(res.cursor);
    expect(decoded.etag).toBe('"empty1"');
    expect(decoded.login).toBe("octocat");
  });

  test("multi-event mixed response: 1 PR + 1 issue + 1 dropped → 2 upserts, cursor advances", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        {
          id: "m1",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 500, title: "pr-500" } },
        },
        {
          id: "m2",
          type: "PushEvent", // dropped
          repo: { full_name: "acme/app" },
          payload: { commits: [] },
        },
        {
          id: "m3",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: { issue: { number: 501, title: "issue-501" } },
        },
      ],
      { headers: { etag: '"mixed1"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(2);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'github' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual([
      "acme/app#500",
      "acme/app#issue-501",
    ]);
    if (res.cursor === null) throw new Error("expected cursor after multi-event sync");
    const decoded = decodeCursor<{ etag: string | null; login: string | null }>(res.cursor);
    expect(decoded.etag).toBe('"mixed1"');
    expect(decoded.login).toBe("octocat");
  });

  test("notifications log records nothing — github-sync emits no notifications", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond("GET", EVENTS_RE, [], { headers: { etag: '"n1"' } });
    await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(fixture.notifications.emitted).toHaveLength(0);
  });
});

describe("github-sync — non-event-type drops", () => {
  test("PushEvent in the response array is silently dropped", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        { id: "p1", type: "PushEvent", repo: { full_name: "acme/app" }, payload: {} },
        { id: "p2", type: "PushEvent", repo: { full_name: "acme/app" }, payload: {} },
      ],
      { headers: { etag: '"push1"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'github'")
      .all();
    expect(rows).toHaveLength(0);
  });

  test("mixed ForkEvent / WatchEvent / CreateEvent are dropped; surrounding PR/Issue events still process", async () => {
    fixture.fetchMock.respond("GET", USER_URL, { login: "octocat" });
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE,
      [
        { id: "f1", type: "ForkEvent", repo: { full_name: "acme/app" }, payload: {} },
        {
          id: "pr1",
          type: "PullRequestEvent",
          repo: { full_name: "acme/app" },
          payload: { pull_request: { number: 700, title: "pr-700" } },
        },
        { id: "w1", type: "WatchEvent", repo: { full_name: "acme/app" }, payload: {} },
        {
          id: "iss1",
          type: "IssuesEvent",
          repo: { full_name: "acme/app" },
          payload: { issue: { number: 701, title: "issue-701" } },
        },
        { id: "c1", type: "CreateEvent", repo: { full_name: "acme/app" }, payload: {} },
      ],
      { headers: { etag: '"mix2"' } },
    );
    const res = await createGithubSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(2);
    const rows = fixture.db
      .query<{ external_id: string; type: string }, []>(
        "SELECT external_id, type FROM item WHERE service = 'github' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0].external_id).toBe("acme/app#700");
    expect(rows[0].type).toBe("pr");
    expect(rows[1].external_id).toBe("acme/app#issue-701");
    expect(rows[1].type).toBe("issue");
  });
});
