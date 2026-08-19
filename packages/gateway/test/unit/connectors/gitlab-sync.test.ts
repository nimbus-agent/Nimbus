import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";

import { createGitlabSyncable } from "../../../src/connectors/gitlab-sync.ts";
import { dbRun } from "../../../src/db/write.ts";
import { RateLimitError } from "../../../src/sync/types.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const ENSURE_MCP = { ensureGitlabMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-glab1:";

const DEFAULT_API_BASE = "https://gitlab.com/api/v4";
const EVENTS_PREFIX_DEFAULT = "https://gitlab.com/api/v4/events?";
const EVENTS_RE_DEFAULT = /^https:\/\/gitlab\.com\/api\/v4\/events\?/;
/** Host-agnostic, for the self-hosted `api_base` cases. */
const EVENTS_RE_ANY_HOST = /\/api\/v4\/events\?/;
const PIPELINES_RE_ANY = /\/api\/v4\/projects\/[^/]+\/pipelines\?/;
const MR_DIFFS_RE_ANY = /\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/diffs\?/;

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor<T>(cursor: string): T {
  const body = cursor.slice(CURSOR_PREFIX.length);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
}

/**
 * A pino logger that captures its output, for asserting what a code path DOES and DOES NOT log.
 * The fixture's own logger is `level: "silent"`, which cannot be inspected.
 */
function capturingLogger(sink: string[]): Logger {
  return pino(
    { level: "trace" },
    {
      write(line: string): void {
        sink.push(line);
      },
    },
  );
}

/** Seed a gitlab PR row with an arbitrary external id, for the id-parsing edge cases. */
function seedGitlabPr(fixture: ConnectorSyncFixture, externalId: string): void {
  const id = `gitlab:${externalId}`;
  dbRun(
    fixture.db,
    `INSERT INTO item (
      id, service, type, external_id, title, body_preview, url, canonical_url,
      modified_at, author_id, metadata, synced_at, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "gitlab",
      "pr",
      externalId,
      `seed for ${externalId}`,
      `seed for ${externalId}`,
      null,
      null,
      Date.now(),
      null,
      "{}",
      Date.now(),
      0,
    ],
  );
}

function seedGitlabIndexProject(fixture: ConnectorSyncFixture, projectPath: string): void {
  const externalId = `${projectPath}!1`;
  const id = `gitlab:${externalId}`;
  const meta = JSON.stringify({ project: projectPath, iid: 1, action: "opened" });
  dbRun(
    fixture.db,
    `INSERT INTO item (
      id, service, type, external_id, title, body_preview, url, canonical_url,
      modified_at, author_id, metadata, synced_at, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "gitlab",
      "pr",
      externalId,
      `seed for ${projectPath}`,
      `seed for ${projectPath}`,
      null,
      null,
      Date.now(),
      null,
      meta,
      Date.now(),
      0,
    ],
  );
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
  await fixture.vault.set("gitlab.pat", "gitlab-stub-pat");
});

afterEach(() => {
  fixture.cleanup();
});

describe("gitlab-sync — credential short-circuits", () => {
  test("returns noop when gitlab.pat is not set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createGitlabSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(res.itemsUpserted).toBe(0);
      expect(res.itemsDeleted).toBe(0);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when gitlab.pat is the empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("gitlab.pat", "");
      const syncable = createGitlabSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("api_base missing defaults to https://gitlab.com/api/v4", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url.startsWith(`${DEFAULT_API_BASE}/events?`)).toBe(true);
  });
});

function stageEmptyEvents(): void {
  fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
}

describe("gitlab-sync — cursor decode", () => {
  test("v2 cursor round-trips (happy path)", async () => {
    stageEmptyEvents();
    const v2 = encodeCursor({ v: 2, after: "2026-04-01T00:00:00.000Z", page: 1, pipelines: {} });
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), v2);
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("after=2026-04-01T00%3A00%3A00.000Z");
  });

  test("v1 cursor upgrades to v2 (preserves after + page; pipelines map is empty)", async () => {
    stageEmptyEvents();
    const v1 = encodeCursor({ after: "2026-03-15T00:00:00.000Z", page: 2 });
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), v1);
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("after=2026-03-15T00%3A00%3A00.000Z");
    expect(eventCalls[0].url).toContain("page=2");
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("expected cursor after v1 upgrade");
    const decoded = decodeCursor<{ v: number; pipelines: Record<string, number> }>(res.cursor);
    expect(decoded.v).toBe(2);
    expect(decoded.pipelines).toEqual({});
  });

  test("null cursor falls back to default initial-since (events fetched at default base)", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("page=1");
  });

  test("empty string cursor falls back to default", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
  });

  test("wrong-prefix cursor falls back to default", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      "nimbus-other:abc",
    );
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("page=1");
  });

  test("non-base64 / garbage cursor body falls back to default", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      `${CURSOR_PREFIX}!!!not-base64!!!`,
    );
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
  });

  test("cursor JSON parses to array → falls back", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor([1, 2, 3]),
    );
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("page=1");
  });

  test("v=2 with empty after → falls back to default", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ v: 2, after: "", page: 1, pipelines: {} }),
    );
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("page=1");
  });

  test("v=2 with page < 1 → clamps to 1 (page validator)", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({ v: 2, after: "2026-04-01T00:00:00.000Z", page: 0, pipelines: {} }),
    );
    expect(res.hasMore).toBe(false);
    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].url).toContain("page=1");
  });

  test("pipelines map: non-finite values are dropped, finite values preserved", async () => {
    stageEmptyEvents();
    const res = await createGitlabSyncable(ENSURE_MCP).sync(
      fixture.createSyncContext(),
      encodeCursor({
        v: 2,
        after: "2026-04-01T00:00:00.000Z",
        page: 1,
        pipelines: { "acme/app": 42, "acme/bad": null },
      }),
    );
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("expected cursor");
    const decoded = decodeCursor<{ pipelines: Record<string, number> }>(res.cursor);
    expect(decoded.pipelines["acme/app"]).toBe(42);
    expect("acme/bad" in decoded.pipelines).toBe(false);
  });
});

describe("gitlab-sync — HTTP request paths (events)", () => {
  test("sends PRIVATE-TOKEN header on events fetch", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0].headers["private-token"]).toBe("gitlab-stub-pat");
  });

  test("events URL carries after, sort=asc, per_page=100, page parameters", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    const v2 = encodeCursor({
      v: 2,
      after: "2026-04-01T00:00:00.000Z",
      page: 3,
      pipelines: {},
    });
    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), v2);

    const eventCalls = fixture.fetchMock.calls.filter((c) =>
      c.url.startsWith(EVENTS_PREFIX_DEFAULT),
    );
    expect(eventCalls).toHaveLength(1);
    const url = eventCalls[0].url;
    expect(url).toContain("after=2026-04-01T00%3A00%3A00.000Z");
    expect(url).toContain("sort=asc");
    expect(url).toContain("per_page=100");
    expect(url).toContain("page=3");
  });

  test("429 with retry-after header → penalises rate limiter, throws", async () => {
    fixture.fetchMock.respond(
      "GET",
      EVENTS_RE_DEFAULT,
      { message: "too many" },
      { status: 429, headers: { "retry-after": "30" } },
    );
    await expect(
      createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitLab events 429/);
  });

  test("non-200 non-429 throws with status code surfaced", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, { error: "server" }, { status: 500 });
    await expect(
      createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitLab events 500/);
  });

  test("invalid JSON in events response body throws", async () => {
    fixture.fetchMock.respondWithText("GET", EVENTS_RE_DEFAULT, "<html>not json</html>");
    await expect(
      createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toThrow(/GitLab events: invalid JSON/);
  });
});

describe("gitlab-sync — HTTP request paths (pipelines)", () => {
  test("pipelines URL has per_page=25, order_by=id, sort=desc", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const pipelineCalls = fixture.fetchMock.calls.filter((c) => PIPELINES_RE_ANY.test(c.url));
    expect(pipelineCalls).toHaveLength(1);
    const url = pipelineCalls[0].url;
    expect(url).toContain("per_page=25");
    expect(url).toContain("order_by=id");
    expect(url).toContain("sort=desc");
  });

  test("project name is URL-encoded as group%2Fproject (not group/project)", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const pipelineCalls = fixture.fetchMock.calls.filter((c) => PIPELINES_RE_ANY.test(c.url));
    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0].url).toContain("/projects/acme%2Fapp/pipelines?");
    expect(/\/projects\/acme\/app\/pipelines/.test(pipelineCalls[0].url)).toBe(false);
  });

  test("pipelines 429 → logs warning, does NOT throw (asymmetric handling vs events)", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond(
      "GET",
      PIPELINES_RE_ANY,
      { error: "too many" },
      { status: 429, headers: { "retry-after": "30" } },
    );

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.hasMore).toBe(false);
  });

  test("pipelines invalid JSON → does NOT throw, returns zero upserts (asymmetric)", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respondWithText("GET", PIPELINES_RE_ANY, "<html>not json</html>");

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.hasMore).toBe(false);
  });
});

describe("gitlab-sync — events branch (indexing)", () => {
  test("MergeRequestEvent with target_type=MergeRequest → upserts as 'pr'", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 101,
        action_name: "opened",
        target_iid: 4,
        target_type: "MergeRequest",
        target_title: "Add feature",
        created_at: "2026-04-01T12:00:00.000Z",
        author_username: "dev1",
        author_name: "Dev One",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; type: string }, []>(
        "SELECT external_id, type FROM item WHERE service = 'gitlab'",
      )
      .get();
    expect(row?.external_id).toBe("acme/app!4");
    expect(row?.type).toBe("pr");
  });

  test("IssueEvent with target_type=Issue → upserts as 'issue'", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 102,
        action_name: "opened",
        target_iid: 7,
        target_type: "Issue",
        target_title: "Bug report",
        created_at: "2026-04-02T12:00:00.000Z",
        author_username: "dev2",
        author_name: "Dev Two",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; type: string }, []>(
        "SELECT external_id, type FROM item WHERE service = 'gitlab'",
      )
      .get();
    expect(row?.external_id).toBe("acme/app#7");
    expect(row?.type).toBe("issue");
  });

  test("event missing target_iid is silently skipped", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 103,
        action_name: "opened",
        target_type: "MergeRequest",
        target_title: "no iid",
        created_at: "2026-04-01T12:00:00.000Z",
        project: { path_with_namespace: "acme/app" },
      },
      {
        id: 104,
        action_name: "opened",
        target_iid: 10,
        target_type: "MergeRequest",
        target_title: "kept",
        created_at: "2026-04-01T12:00:00.000Z",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'gitlab'")
      .get();
    expect(row?.external_id).toBe("acme/app!10");
  });

  test("event missing project.path_with_namespace is silently skipped", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 105,
        action_name: "opened",
        target_iid: 11,
        target_type: "MergeRequest",
        target_title: "no project path",
        created_at: "2026-04-01T12:00:00.000Z",
        // project omitted entirely
      },
      {
        id: 106,
        action_name: "opened",
        target_iid: 12,
        target_type: "MergeRequest",
        target_title: "kept",
        created_at: "2026-04-01T12:00:00.000Z",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'gitlab'")
      .get();
    expect(row?.external_id).toBe("acme/app!12");
  });

  test("event with unknown target_type is silently skipped", async () => {
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 107,
        action_name: "opened",
        target_iid: 13,
        target_type: "WikiPage", // not handled
        target_title: "unknown type",
        created_at: "2026-04-01T12:00:00.000Z",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    const rows = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'gitlab'")
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe("gitlab-sync — pipelines branch (indexing)", () => {
  test("pipeline with id > lastSeen → upserted as 'ci_run' with metadata", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 555,
        status: "success",
        ref: "main",
        web_url: "https://gitlab.com/acme/app/-/pipelines/555",
        duration: 120,
        sha: "deadbeef",
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      },
    ]);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(1);
    const row = fixture.db
      .query<{ external_id: string; type: string; metadata: string }, []>(
        "SELECT external_id, type, metadata FROM item WHERE service = 'gitlab' AND type = 'ci_run'",
      )
      .get();
    expect(row?.external_id).toBe("acme/app#pipeline-555");
    expect(row?.type).toBe("ci_run");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["status"]).toBe("success");
    expect(meta["ref"]).toBe("main");
    expect(meta["duration"]).toBe(120);
    expect(meta["sha"]).toBe("deadbeef");
    expect(meta["pipelineId"]).toBe(555);
    expect(meta["project"]).toBe("acme/app");
  });

  test("pipeline id <= lastSeen → loop break (no further upserts for that project)", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 101,
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      },
      {
        id: 50,
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 120 * 1000).toISOString(),
      },
      {
        id: 200, // ignored — break already fired
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 30 * 1000).toISOString(),
      },
    ]);

    const v2 = encodeCursor({
      v: 2,
      after: "2026-04-01T00:00:00.000Z",
      page: 1,
      pipelines: { "acme/app": 100 },
    });
    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), v2);
    expect(res.itemsUpserted).toBe(1);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'gitlab' AND type = 'ci_run'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("acme/app#pipeline-101");
  });

  test("pipeline with created_at < floor is skipped (time-window guard)", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    const longAgoIso = new Date(Date.now() - 90 * 86_400_000).toISOString();
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 600,
        status: "success",
        ref: "main",
        created_at: longAgoIso,
      },
    ]);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(0);
    const rows = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'gitlab' AND type = 'ci_run'",
      )
      .all();
    expect(rows).toHaveLength(0);
  });

  test("pipeline metadata includes status, ref, duration, sha — null when source field missing", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 777,
        ref: "feature/branch",
        sha: "abc123",
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      },
    ]);
    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    const row = fixture.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'gitlab' AND external_id = 'acme/app#pipeline-777'",
      )
      .get();
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["ref"]).toBe("feature/branch");
    expect(meta["sha"]).toBe("abc123");
    expect(meta["status"]).toBeNull();
    expect(meta["duration"]).toBeNull();
  });

  test("per-project lastPipelineId watermark advances in returned cursor on success", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 901,
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      },
      {
        id: 905,
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 50 * 1000).toISOString(),
      },
    ]);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("expected cursor");
    const decoded = decodeCursor<{ pipelines: Record<string, number> }>(res.cursor);
    expect(decoded.pipelines["acme/app"]).toBe(905);
  });
});

describe("gitlab-sync — phase machine + cycle", () => {
  test("one cycle: events + pipelines merged into single result", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, [
      {
        id: 1,
        action_name: "opened",
        target_iid: 100,
        target_type: "MergeRequest",
        target_title: "Feature MR",
        created_at: "2026-04-10T12:00:00.000Z",
        project: { path_with_namespace: "acme/app" },
      },
    ]);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, [
      {
        id: 1001,
        status: "success",
        ref: "main",
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      },
      {
        id: 1002,
        status: "running",
        ref: "main",
        created_at: new Date(Date.now() - 30 * 1000).toISOString(),
      },
    ]);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.itemsUpserted).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });

  test("events x-next-page header advances page across multi-page events fetch", async () => {
    let pageCalls = 0;
    let pipelineCalls = 0;
    fixture.fetchMock.restore();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const u = requestUrl(input);
      if (/[&?]page=1(&|$)/.test(u) && /\/events\?/.test(u)) {
        pageCalls += 1;
        return new Response(
          JSON.stringify([
            {
              id: 1,
              action_name: "opened",
              target_iid: 1,
              target_type: "MergeRequest",
              target_title: "p1",
              created_at: "2026-04-10T12:00:00.000Z",
              project: { path_with_namespace: "acme/app" },
            },
          ]),
          { status: 200, headers: { "x-next-page": "2" } },
        );
      }
      if (/[&?]page=2(&|$)/.test(u) && /\/events\?/.test(u)) {
        pageCalls += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (PIPELINES_RE_ANY.test(u)) {
        pipelineCalls += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected request: ${u}`);
    };

    try {
      const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      expect(pageCalls).toBe(2);
      expect(pipelineCalls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("all events drained AND all projects covered → returns hasMore=false", async () => {
    seedGitlabIndexProject(fixture, "acme/app");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);
    expect(res.itemsUpserted).toBe(0);
    expect(res.itemsDeleted).toBe(0);
    expect(fixture.notifications.emitted).toHaveLength(0);
  });
});

/**
 * End-to-end wiring for the PR changed-file pass, driven through the real syncable rather than
 * through `runPrFilePass` with a hand-written `fetchPage`. GitHub has five such tests; GitLab and
 * Bitbucket had none, so nothing would have caught the pass being dropped from either sync flow.
 */
describe("gitlab-sync — PR changed-file pass (end-to-end)", () => {
  test("fetches MR diffs for an uncovered MR and writes its coverage row", async () => {
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    fixture.fetchMock.respond("GET", MR_DIFFS_RE_ANY, [
      { old_path: "src/a.ts", new_path: "src/a.ts" },
      { old_path: "docs/old.md", new_path: "docs/new.md", renamed_file: true },
    ]);

    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const diffCalls = fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url));
    expect(diffCalls).toHaveLength(1);
    const diffCall = diffCalls[0];
    if (diffCall === undefined) throw new Error("expected exactly one MR diffs request");
    // The group path is URL-encoded as ONE segment, and the iid comes from after the LAST `!`.
    expect(diffCall.url).toContain("/projects/grp%2Fproj/merge_requests/1/diffs?");
    expect(diffCall.url).toContain("per_page=100");
    expect(diffCall.url).toContain("page=1");
    expect(diffCall.headers["private-token"]).toBe("gitlab-stub-pat");

    const state = fixture.db
      .query<{ stored_count: number; truncated: number }, []>(
        "SELECT stored_count, truncated FROM pr_files_state WHERE item_id = 'gitlab:grp/proj!1'",
      )
      .get();
    // A rename writes BOTH paths, so "does not touch docs/old.md" cannot match this MR.
    expect(state?.stored_count).toBe(3);
    expect(state?.truncated).toBe(0);

    const paths = fixture.db
      .query<{ path: string }, []>(
        "SELECT path FROM pr_changed_file WHERE item_id = 'gitlab:grp/proj!1' ORDER BY path",
      )
      .all()
      .map((r) => r.path);
    expect(paths).toEqual(["docs/new.md", "docs/old.md", "src/a.ts"]);
  });

  test("a non-ok MR diffs response leaves the MR uncovered and does not fail the sync", async () => {
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    fixture.fetchMock.respond(
      "GET",
      MR_DIFFS_RE_ANY,
      { message: "404 Not found" },
      { status: 404 },
    );

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);

    // Assert the request HAPPENED before asserting nothing was written — otherwise "zero coverage
    // rows" is equally true of a pass that never ran, and the test proves nothing.
    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(1);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);
  });

  test("a rejecting fetch is swallowed: no coverage row, no throw, and the api_base never logged", async () => {
    // A SELF-HOSTED api_base — the whole point. It is a Vault-stored value, and a DNS/TLS/connect
    // rejection can carry the request URL (which embeds it) in its message. `MockFetch` throws
    // exactly that shape for an unstubbed URL: `no stub matched GET <url>`. So this test is a real
    // reproduction rather than a synthetic one — leaving the MR-diffs route unstubbed IS the
    // rejecting fetch, and the thrown message genuinely contains the host.
    const host = "gitlab.internal.example.com";
    await fixture.vault.set("gitlab.api_base", `https://${host}/api/v4`);
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_ANY_HOST, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    // NOTE: no MR_DIFFS stub — that fetch rejects.

    const lines: string[] = [];
    const ctx = { ...fixture.createSyncContext(), logger: capturingLogger(lines) };
    // Must not throw: the rejection is caught in the closure, `null` flows to the driver as an
    // ordinary "page unavailable", and the best-effort wrapper is never reached.
    const res = await createGitlabSyncable(ENSURE_MCP).sync(ctx, null);
    expect(res.hasMore).toBe(false);

    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(1);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);

    // The assertion the fix exists for. Without the try/catch the rejection reaches
    // `runPrFilePass`'s catch, which logs `err: String(err)` — and that string contains the URL,
    // hence the host. Assert on the LOG OUTPUT, not on the absence of a throw: the sync resolves
    // either way, so "did not throw" alone would pass against the unfixed code.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes(host))).toBe(false);
  });

  test("a 429 on MR diffs raises RateLimitError out of the sync and penalises the provider", async () => {
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    fixture.fetchMock.respond(
      "GET",
      MR_DIFFS_RE_ANY,
      { message: "Too Many Requests" },
      { status: 429, headers: { "retry-after": "120" } },
    );

    // Rate limiting is the ONE failure the best-effort wrapper deliberately re-raises, so the
    // scheduler can honour the backoff instead of the pass hammering a limited API.
    await expect(
      createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null),
    ).rejects.toBeInstanceOf(RateLimitError);

    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);

    // The penalty is the half a caller would not notice was missing: the throw alone ends THIS
    // tick, but without `penalise` the next tick would walk straight back into the same 429.
    // `tryAcquire` reports `false` while a provider is inside its penalty window.
    expect(await fixture.rateLimiter.tryAcquire("gitlab")).toBe(false);
  });

  test("an unparseable MR diffs body leaves the MR uncovered and does not fail the sync", async () => {
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    fixture.fetchMock.respondWithText("GET", MR_DIFFS_RE_ANY, "not json{{{");

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);

    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(1);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);
  });

  test("a full-length page requests a second page; a short second page ends pagination", async () => {
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    // `hasMore` is derived from page LENGTH here (unlike Bitbucket's `next` URL), so a full page
    // must ask for another and a short one must stop. Anchor on `?page=N`, never a bare `page=N`:
    // `mrDiffsUrl` emits `?page=1&per_page=100`, and `per_page=100` contains "page=1" as a prefix
    // of "page=100", so `.includes("page=1")` matches EVERY request regardless of its real page.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      old_path: `src/f${String(i)}.ts`,
      new_path: `src/f${String(i)}.ts`,
    }));
    fixture.fetchMock.respond("GET", /merge_requests\/\d+\/diffs\?page=1(&|$)/, fullPage);
    fixture.fetchMock.respond("GET", /merge_requests\/\d+\/diffs\?page=2(&|$)/, [
      { old_path: "src/last.ts", new_path: "src/last.ts" },
    ]);

    await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);

    const diffCalls = fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url));
    expect(diffCalls.some((c) => c.url.includes("?page=1&"))).toBe(true);
    expect(diffCalls.some((c) => c.url.includes("?page=2&"))).toBe(true);
    expect(diffCalls).toHaveLength(2);

    const state = fixture.db
      .query<{ stored_count: number; truncated: number }, []>(
        "SELECT stored_count, truncated FROM pr_files_state WHERE item_id = 'gitlab:grp/proj!1'",
      )
      .get();
    expect(state?.stored_count).toBe(101);
    // Pagination ENDED on the short page, so the full path set is held — not truncated.
    expect(state?.truncated).toBe(0);
  });

  test("an external id with no '!' is skipped without a request", async () => {
    // `selectPrFileCandidates` splits on the last `#` OR `!`, so a `#`-keyed row is a legitimate
    // gitlab candidate that this connector's own closure cannot parse — it looks for `!` only.
    seedGitlabPr(fixture, "grp/proj#9");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);

    // No request at all — the malformed id is rejected before any network call.
    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(0);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);
  });

  test("a non-numeric iid is skipped without a request", async () => {
    seedGitlabPr(fixture, "grp/proj!notanumber");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    expect(res.hasMore).toBe(false);

    // `Number("notanumber")` is NaN. Without the `Number.isFinite` guard the URL would carry
    // `merge_requests/NaN/diffs` — a request that can only ever fail.
    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(0);
    const covered = fixture.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM pr_files_state")
      .get();
    expect(covered?.c).toBe(0);
  });

  test("a failure INSIDE the pass is warned, not fatal, and the sync still returns", async () => {
    // Exercises the wrapper's warn arm (as against its `RateLimitError` rethrow arm above). The
    // driver's own per-candidate catch handles fetch failures, so reaching the wrapper needs a
    // failure OUTSIDE that loop — `selectPrFileCandidates` querying a table that is not there.
    seedGitlabIndexProject(fixture, "grp/proj");
    fixture.fetchMock.respond("GET", EVENTS_RE_DEFAULT, []);
    fixture.fetchMock.respond("GET", PIPELINES_RE_ANY, []);
    fixture.db.exec("DROP TABLE pr_files_state");

    const res = await createGitlabSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
    // The events sync's own result survives: the changed-file pass is best-effort by design.
    expect(res.hasMore).toBe(false);
    expect(fixture.fetchMock.calls.filter((c) => MR_DIFFS_RE_ANY.test(c.url))).toHaveLength(0);
  });
});
