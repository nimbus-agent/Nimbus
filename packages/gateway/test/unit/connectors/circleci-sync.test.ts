import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCircleciSyncable } from "../../../src/connectors/circleci-sync.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureCircleciMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-cci1:";

const PIPELINES_URL_RE =
  /^https:\/\/circleci\.com\/api\/v2\/project\/[^/]+\/[^/]+\/[^/]+\/pipeline$/;

const PIPELINES_URL_ACME_REPO_A = "https://circleci.com/api/v2/project/gh/acme/repo-a/pipeline";
const PIPELINES_URL_ACME_REPO_B = "https://circleci.com/api/v2/project/gh/acme/repo-b/pipeline";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorJson(c: string): unknown {
  return JSON.parse(Buffer.from(c.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
}

function seedGithubRepo(ctx: SyncContext, fullName: string): void {
  const now = Date.now();
  ctx.upsertItem({
    service: "github",
    type: "repository",
    externalId: `repo:${fullName}`,
    title: fullName,
    bodyPreview: "",
    url: null,
    canonicalUrl: null,
    modifiedAt: now,
    authorId: null,
    metadata: { repo: fullName },
    pinned: false,
    syncedAt: now,
  });
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

describe("circleci-sync — credential short-circuits", () => {
  test("returns noop when api_token vault key is missing", async () => {
    await withIsolatedFixture(async (iso) => {
      seedGithubRepo(iso.createSyncContext("circleci"), "acme/repo-a");
      const syncable = createCircleciSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("circleci"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when api_token is empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("circleci.api_token", "");
      seedGithubRepo(iso.createSyncContext("circleci"), "acme/repo-a");
      const syncable = createCircleciSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("circleci"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });
  });

  test("returns noop when api_token is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("circleci.api_token", "   ");
      seedGithubRepo(iso.createSyncContext("circleci"), "acme/repo-a");
      const syncable = createCircleciSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("circleci"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when no github repos are indexed (even with valid token)", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("circleci.api_token", "circleci-stub-token");
      const syncable = createCircleciSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("circleci"), "preserved-cursor");
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("circleci-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("circleci.api_token", "circleci-stub-token");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request paths", () => {
    test("sends Circle-Token header on pipelines URL", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      await createCircleciSyncable(ENSURE_MCP).sync(fixture.createSyncContext("circleci"), null);
      expect(fixture.fetchMock.firstCall().headers["circle-token"]).toBe("circleci-stub-token");
    });

    test("sends Accept: application/json on pipelines URL", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      await createCircleciSyncable(ENSURE_MCP).sync(fixture.createSyncContext("circleci"), null);
      expect(fixture.fetchMock.firstCall().headers["accept"]).toBe("application/json");
    });

    test("URL contains correctly slug-encoded gh/<owner>/<repo>", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme-org/repo.name");
      fixture.fetchMock.respond("GET", PIPELINES_URL_RE, { items: [] });
      await createCircleciSyncable(ENSURE_MCP).sync(fixture.createSyncContext("circleci"), null);
      expect(fixture.fetchMock.firstCall().url).toBe(
        "https://circleci.com/api/v2/project/gh/acme-org/repo.name/pipeline",
      );
    });

    test("5xx for one repo → 0 upserts for that repo, sibling repo continues", async () => {
      const syncCtx = fixture.createSyncContext("circleci");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      fixture.fetchMock.respond(
        "GET",
        PIPELINES_URL_ACME_REPO_A,
        { error: "boom" },
        { status: 500 },
      );
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_B, {
        items: [{ number: 5, created_at: recentTs, state: "success" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'circleci'",
        )
        .get();
      expect(row?.external_id).toBe("gh/acme/repo-b#p5");
    });

    test("invalid JSON for one repo → bails for that repo (0 upserts)", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respondWithText("GET", PIPELINES_URL_ACME_REPO_A, "<html>not json</html>");
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
    });

    test("non-array `items` field → bails for that repo (0 upserts)", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: "not-an-array" });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });
  });

  describe("cursor decode", () => {
    test("null cursor → starts fresh with empty projects map", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.cursor).not.toBeNull();
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects).toEqual({ "gh/acme/repo-a": 0 });
    });

    test("wrong-prefix cursor → starts fresh", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        "nimbus-other:abc",
      );
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects).toEqual({ "gh/acme/repo-a": 0 });
    });

    test("non-record cursor payload → starts fresh", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        encodeCursor([1, 2, 3]),
      );
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects).toEqual({ "gh/acme/repo-a": 0 });
    });

    test("non-object `projects` field → falls back to empty projects map", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        encodeCursor({ projects: "not-a-record" }),
      );
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects).toEqual({ "gh/acme/repo-a": 0 });
    });
  });

  describe("pipeline filters", () => {
    test("pipeline number <= lastSeen → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          { number: 3, created_at: recentTs, state: "success" },
          { number: 4, created_at: recentTs, state: "success" },
        ],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        encodeCursor({ projects: { "gh/acme/repo-a": 4 } }),
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("pipeline created_at < floorMs (14d) → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const wayOldTs = new Date(Date.now() - 30 * 86_400_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 1, created_at: wayOldTs, state: "success" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("pipeline state missing/empty → title is bare `Pipeline #N`", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 7, created_at: recentTs }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'circleci'")
        .get();
      expect(row?.title).toBe("Pipeline #7");
    });

    test("pipeline state present → title appends ' — <state>'", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 9, created_at: recentTs, state: "failed" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'circleci'")
        .get();
      expect(row?.title).toBe("Pipeline #9 — failed");
    });

    test("non-record vcs field → branch/revision metadata null", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 11, created_at: recentTs, vcs: "not-a-record" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'circleci'")
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.branch).toBeNull();
      expect(meta.revision).toBeNull();
    });

    test("vcs record with branch + revision → metadata populated; missing branch falls back to tag", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          {
            number: 12,
            created_at: recentTs,
            vcs: { revision: "abc123", tag: "v1.0.0" },
          },
        ],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'circleci'")
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.branch).toBe("v1.0.0");
      expect(meta.revision).toBe("abc123");
    });

    test("non-record pipeline entry → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [42, "string", null, { number: 5, created_at: recentTs, state: "success" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("missing `number` field → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          { created_at: recentTs, state: "success" },
          { number: 8, created_at: recentTs, state: "success" },
        ],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("created_at unparseable / missing → upserts with modifiedAt = now (not skipped)", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          { number: 13, created_at: "garbage-not-iso", state: "success" },
          { number: 14, state: "success" }, // created_at missing entirely
        ],
      });
      const before = Date.now();
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      const after = Date.now();
      expect(res.itemsUpserted).toBe(2);
      const rows = fixture.db
        .query<{ external_id: string; modified_at: number }, []>(
          "SELECT external_id, modified_at FROM item WHERE service = 'circleci' ORDER BY external_id",
        )
        .all();
      for (const row of rows) {
        expect(row.modified_at).toBeGreaterThanOrEqual(before);
        expect(row.modified_at).toBeLessThanOrEqual(after);
      }
    });
  });

  describe("project slug derivation", () => {
    // Anything githubRepoToCircleProjectSlug maps to null is skipped before any HTTP call.
    test.each([
      ["owner-only (no `/`)", "no-slash-here"],
      ["trailing slash", "acme/"],
      ["leading slash", "/repo-a"],
    ])("%s → skipped, no fetch", async (_label, repo) => {
      seedGithubRepo(fixture.createSyncContext("circleci"), repo);
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(fixture.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });
  });

  describe("multi-project cursor", () => {
    test("two repos with pipelines → cursor.projects keys are slugs not repo names", async () => {
      const syncCtx = fixture.createSyncContext("circleci");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 11, created_at: recentTs, state: "success" }],
      });
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_B, {
        items: [{ number: 22, created_at: recentTs, state: "success" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(2);
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects).toEqual({
        "gh/acme/repo-a": 11,
        "gh/acme/repo-b": 22,
      });
    });

    test("second sync uses prior maxNum as lastSeen → older pipelines skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          { number: 5, created_at: recentTs, state: "success" },
          { number: 6, created_at: recentTs, state: "success" },
          { number: 7, created_at: recentTs, state: "success" },
        ],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        encodeCursor({ projects: { "gh/acme/repo-a": 6 } }),
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'circleci'",
        )
        .get();
      expect(row?.external_id).toBe("gh/acme/repo-a#p7");
      const decoded = decodeCursorJson(res.cursor!) as { projects: Record<string, number> };
      expect(decoded.projects["gh/acme/repo-a"]).toBe(7);
    });

    test("repo absent from incoming cursor → treated as lastSeen=0", async () => {
      const syncCtx = fixture.createSyncContext("circleci");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [{ number: 1, created_at: recentTs, state: "success" }],
      });
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_B, {
        items: [{ number: 100, created_at: recentTs, state: "success" }],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        encodeCursor({ projects: { "gh/acme/repo-a": 50 } }),
      );
      expect(res.itemsUpserted).toBe(1);
    });
  });

  describe("full-cycle", () => {
    test("2 repos × 2 pipelines each → external_id is `<slug>#p<num>`; gh-backed url populated", async () => {
      const syncCtx = fixture.createSyncContext("circleci");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, {
        items: [
          { number: 1, created_at: recentTs, state: "success" },
          { number: 2, created_at: recentTs, state: "failed" },
        ],
      });
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_B, {
        items: [
          { number: 1, created_at: recentTs, state: "success" },
          { number: 2, created_at: recentTs, state: "running" },
        ],
      });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.itemsUpserted).toBe(4);
      const rows = fixture.db
        .query<{ external_id: string; url: string | null }, []>(
          "SELECT external_id, url FROM item WHERE service = 'circleci' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r) => r.external_id)).toEqual([
        "gh/acme/repo-a#p1",
        "gh/acme/repo-a#p2",
        "gh/acme/repo-b#p1",
        "gh/acme/repo-b#p2",
      ]);
      for (const row of rows) {
        expect(row.url).toMatch(
          /^https:\/\/app\.circleci\.com\/pipelines\/github\/acme\/repo-[ab]\/\d+$/,
        );
      }
    });

    test("emits no notifications", async () => {
      seedGithubRepo(fixture.createSyncContext("circleci"), "acme/repo-a");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      await createCircleciSyncable(ENSURE_MCP).sync(fixture.createSyncContext("circleci"), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });

    test("bytesTransferred sums response body lengths across repos", async () => {
      const syncCtx = fixture.createSyncContext("circleci");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_A, { items: [] });
      fixture.fetchMock.respond("GET", PIPELINES_URL_ACME_REPO_B, { items: [] });
      const res = await createCircleciSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("circleci"),
        null,
      );
      expect(res.bytesTransferred).toBe(24);
    });
  });
});
