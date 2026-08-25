import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createGithubActionsSyncable } from "../../../src/connectors/github-actions-sync.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureGithubMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-gha1:";

const RUNS_URL_ACME_REPO_A =
  /^https:\/\/api\.github\.com\/repos\/acme\/repo-a\/actions\/runs(?:\?.*)?$/;
const RUNS_URL_ACME_REPO_B =
  /^https:\/\/api\.github\.com\/repos\/acme\/repo-b\/actions\/runs(?:\?.*)?$/;

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

describe("github-actions-sync — credential short-circuits", () => {
  test("returns noop when pat vault key is missing", async () => {
    await withIsolatedFixture(async (iso) => {
      seedGithubRepo(iso.createSyncContext("github_actions"), "acme/repo-a");
      const syncable = createGithubActionsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("github_actions"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when pat is empty string", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("github.pat", "");
      seedGithubRepo(iso.createSyncContext("github_actions"), "acme/repo-a");
      const syncable = createGithubActionsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("github_actions"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when pat is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("github.pat", "   ");
      seedGithubRepo(iso.createSyncContext("github_actions"), "acme/repo-a");
      const syncable = createGithubActionsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("github_actions"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when no github repos are indexed (even with valid pat)", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("github.pat", "github-stub-pat");
      const syncable = createGithubActionsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("github_actions"), "preserved-cursor");
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

describe("github-actions-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("github.pat", "github-stub-pat");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("HTTP request paths", () => {
    test("sends Authorization: Bearer <pat>, Accept and X-GitHub-Api-Version headers", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const h = fixture.fetchMock.firstCall().headers;
      expect(h["authorization"]).toBe("Bearer github-stub-pat");
      expect(h["accept"]).toBe("application/vnd.github+json");
      expect(h["x-github-api-version"]).toBe("2022-11-28");
    });

    test("URL contains owner + repo segments and per_page=30", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const url = fixture.fetchMock.firstCall().url;
      expect(url.startsWith("https://api.github.com/repos/acme/repo-a/actions/runs")).toBe(true);
      expect(url).toContain("per_page=30");
    });

    test("non-200 non-403 → 0 upserts for that repo, sibling continues", async () => {
      const syncCtx = fixture.createSyncContext("github_actions");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { message: "boom" }, { status: 500 });
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_B, {
        workflow_runs: [{ id: 5, created_at: recentTs, conclusion: "success" }],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'github_actions'",
        )
        .get();
      expect(row?.external_id).toBe("acme/repo-b#run-5");
    });

    test("invalid JSON for one repo → bails for that repo (0 upserts)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respondWithText("GET", RUNS_URL_ACME_REPO_A, "<html>not json</html>");
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
    });

    test("non-record root (array) → bails for that repo", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, [1, 2, 3]);
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("missing workflow_runs field → bails for that repo", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { otherField: "value" });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });
  });

  describe("403 rate-limit penalty", () => {
    test("403 + x-ratelimit-remaining: 0 + retry-after: 30 → rateLimiter.penalise(github, 30_000)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond(
        "GET",
        RUNS_URL_ACME_REPO_A,
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "retry-after": "30",
          },
        },
      );
      const penaliseSpy = spyOn(fixture.rateLimiter, "penalise");
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(penaliseSpy).toHaveBeenCalledTimes(1);
      expect(penaliseSpy).toHaveBeenCalledWith("github", 30_000);
    });

    test("403 + x-ratelimit-remaining: 0 with missing retry-after → penalise(github, 60_000)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond(
        "GET",
        RUNS_URL_ACME_REPO_A,
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
          },
        },
      );
      const penaliseSpy = spyOn(fixture.rateLimiter, "penalise");
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(penaliseSpy).toHaveBeenCalledTimes(1);
      expect(penaliseSpy).toHaveBeenCalledWith("github", 60_000);
    });

    test("403 + x-ratelimit-remaining: 0 + non-numeric retry-after → penalise(github, 60_000)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond(
        "GET",
        RUNS_URL_ACME_REPO_A,
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "retry-after": "garbage-not-a-number",
          },
        },
      );
      const penaliseSpy = spyOn(fixture.rateLimiter, "penalise");
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(penaliseSpy).toHaveBeenCalledTimes(1);
      expect(penaliseSpy).toHaveBeenCalledWith("github", 60_000);
    });

    test("non-403 status (200) → penalise NOT called", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      const penaliseSpy = spyOn(fixture.rateLimiter, "penalise");
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(penaliseSpy).not.toHaveBeenCalled();
    });

    test("403 with x-ratelimit-remaining > 0 → penalise NOT called (regular 403, not rate-limit)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond(
        "GET",
        RUNS_URL_ACME_REPO_A,
        { message: "Forbidden" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "100",
          },
        },
      );
      const penaliseSpy = spyOn(fixture.rateLimiter, "penalise");
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(penaliseSpy).not.toHaveBeenCalled();
    });
  });

  describe("run filters", () => {
    test("id <= lastSeen → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          { id: 3, created_at: recentTs, conclusion: "success" },
          { id: 4, created_at: recentTs, conclusion: "success" },
        ],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        encodeCursor({ repos: { "acme/repo-a": 4 } }),
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("created_at < floorMs (14d) → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const wayOldTs = new Date(Date.now() - 30 * 86_400_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [{ id: 1, created_at: wayOldTs, conclusion: "success" }],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("missing id field → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          { created_at: recentTs, conclusion: "success" },
          { id: 8, created_at: recentTs, conclusion: "success" },
        ],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });

    test("non-finite / missing created_at → modifiedAt = now (not skipped)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          { id: 13, created_at: "garbage-not-iso", conclusion: "success" },
          { id: 14, conclusion: "success" }, // missing created_at entirely
        ],
      });
      const before = Date.now();
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const after = Date.now();
      expect(res.itemsUpserted).toBe(2);
      const rows = fixture.db
        .query<{ modified_at: number }, []>(
          "SELECT modified_at FROM item WHERE service = 'github_actions'",
        )
        .all();
      for (const row of rows) {
        expect(row.modified_at).toBeGreaterThanOrEqual(before);
        expect(row.modified_at).toBeLessThanOrEqual(after);
      }
    });

    test("missing optional fields → metadata fields are null", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [{ id: 42, created_at: recentTs }],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ metadata: string; url: string | null }, []>(
          "SELECT metadata, url FROM item WHERE service = 'github_actions'",
        )
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.workflowName).toBeNull();
      expect(meta.event).toBeNull();
      expect(meta.conclusion).toBeNull();
      expect(meta.headSha).toBeNull();
      expect(meta.headBranch).toBeNull();
      expect(meta.status).toBeNull();
      expect(row?.url).toBeNull();
    });

    test("non-record run entry → skipped", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [42, "string", null, { id: 5, created_at: recentTs, conclusion: "success" }],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
    });
  });

  describe("title building", () => {
    test("display_title present → used as title base; conclusion appended", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          {
            id: 1,
            created_at: recentTs,
            display_title: "Fix flaky test",
            name: "CI",
            conclusion: "success",
          },
        ],
      });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'github_actions'")
        .get();
      expect(row?.title).toBe("Fix flaky test — success");
    });

    test("display_title missing → falls back to name", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          { id: 2, created_at: recentTs, name: "CI Workflow", conclusion: "failure" },
        ],
      });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'github_actions'")
        .get();
      expect(row?.title).toBe("CI Workflow — failure");
    });

    test("no conclusion + status present → ' (<status>)' suffix", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [{ id: 3, created_at: recentTs, name: "CI", status: "in_progress" }],
      });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'github_actions'")
        .get();
      expect(row?.title).toBe("CI (in_progress)");
    });

    test("no name + no display_title + no conclusion + no status → bare `Run <id>`", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [{ id: 99, created_at: recentTs }],
      });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'github_actions'")
        .get();
      expect(row?.title).toBe("Run 99");
    });
  });

  describe("cursor decode", () => {
    test("null cursor → starts fresh with empty repos map", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const decoded = decodeCursorJson(res.cursor!) as { repos: Record<string, number> };
      expect(decoded.repos).toEqual({ "acme/repo-a": 0 });
    });

    test("wrong-prefix cursor → starts fresh", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        "nimbus-other:abc",
      );
      const decoded = decodeCursorJson(res.cursor!) as { repos: Record<string, number> };
      expect(decoded.repos).toEqual({ "acme/repo-a": 0 });
    });

    test("non-record cursor payload → starts fresh", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        encodeCursor([1, 2, 3]),
      );
      const decoded = decodeCursorJson(res.cursor!) as { repos: Record<string, number> };
      expect(decoded.repos).toEqual({ "acme/repo-a": 0 });
    });

    test("non-object `repos` field → falls back to empty repos map", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        encodeCursor({ repos: "not-a-record" }),
      );
      const decoded = decodeCursorJson(res.cursor!) as { repos: Record<string, number> };
      expect(decoded.repos).toEqual({ "acme/repo-a": 0 });
    });
  });

  describe("multi-repo + integration", () => {
    test("two repos → cursor.repos keys are full names; external_id is `<full>#run-<id>`", async () => {
      const syncCtx = fixture.createSyncContext("github_actions");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          {
            id: 100,
            created_at: recentTs,
            conclusion: "success",
            html_url: "https://github.com/acme/repo-a/actions/runs/100",
          },
        ],
      });
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_B, {
        workflow_runs: [
          {
            id: 200,
            created_at: recentTs,
            conclusion: "success",
            html_url: "https://github.com/acme/repo-b/actions/runs/200",
          },
        ],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(res.itemsUpserted).toBe(2);
      const decoded = decodeCursorJson(res.cursor!) as { repos: Record<string, number> };
      expect(decoded.repos).toEqual({
        "acme/repo-a": 100,
        "acme/repo-b": 200,
      });
      const rows = fixture.db
        .query<{ external_id: string; url: string | null }, []>(
          "SELECT external_id, url FROM item WHERE service = 'github_actions' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r) => r.external_id)).toEqual([
        "acme/repo-a#run-100",
        "acme/repo-b#run-200",
      ]);
      expect(rows[0]?.url).toBe("https://github.com/acme/repo-a/actions/runs/100");
      expect(rows[1]?.url).toBe("https://github.com/acme/repo-b/actions/runs/200");
    });

    test("second sync with cursor skips runs at or below recorded lastSeen", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          { id: 5, created_at: recentTs, conclusion: "success" },
          { id: 6, created_at: recentTs, conclusion: "success" },
          { id: 7, created_at: recentTs, conclusion: "success" },
        ],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        encodeCursor({ repos: { "acme/repo-a": 6 } }),
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'github_actions'",
        )
        .get();
      expect(row?.external_id).toBe("acme/repo-a#run-7");
    });

    test("owner-only (no `/`) → repo skipped (no HTTP call)", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "no-slash-here");
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(fixture.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });

    test("durationMs computed from run_started_at + updated_at", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      const createdIso = new Date(Date.now() - 60_000).toISOString();
      const startedIso = new Date(Date.now() - 50_000).toISOString();
      const updatedIso = new Date(Date.now() - 40_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [
          {
            id: 1,
            created_at: createdIso,
            run_started_at: startedIso,
            updated_at: updatedIso,
            conclusion: "success",
          },
        ],
      });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      const row = fixture.db
        .query<{ metadata: string }, []>(
          "SELECT metadata FROM item WHERE service = 'github_actions'",
        )
        .get();
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.durationMs).toBeGreaterThanOrEqual(9_000);
      expect(meta.durationMs).toBeLessThanOrEqual(11_000);
    });

    test("emits no notifications", async () => {
      seedGithubRepo(fixture.createSyncContext("github_actions"), "acme/repo-a");
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, { workflow_runs: [] });
      await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        null,
      );
      expect(fixture.notifications.emitted).toHaveLength(0);
    });

    test("repo absent from incoming cursor → treated as lastSeen=0", async () => {
      const syncCtx = fixture.createSyncContext("github_actions");
      seedGithubRepo(syncCtx, "acme/repo-a");
      seedGithubRepo(syncCtx, "acme/repo-b");
      const recentTs = new Date(Date.now() - 60_000).toISOString();
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_A, {
        workflow_runs: [{ id: 1, created_at: recentTs, conclusion: "success" }],
      });
      fixture.fetchMock.respond("GET", RUNS_URL_ACME_REPO_B, {
        workflow_runs: [{ id: 100, created_at: recentTs, conclusion: "success" }],
      });
      const res = await createGithubActionsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext("github_actions"),
        encodeCursor({ repos: { "acme/repo-a": 50 } }),
      );
      expect(res.itemsUpserted).toBe(1);
    });
  });
});
