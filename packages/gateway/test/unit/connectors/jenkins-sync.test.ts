import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createJenkinsSyncable } from "../../../src/connectors/jenkins-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureJenkinsMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-jnk1:";
const BASE_URL = "https://jenkins.example.com";

// Jenkins endpoints carry query strings (the depth-4 jobs tree, and the
// per-job builds tree). MockFetch's string matcher is exact, so all URL
// matchers are RegExp patterns anchored on the path prefix; the encoded
// `tree` parameter varies between the two endpoints and is not asserted
// against here (see the targeted "URL contains tree=" tests for that).
const JOBS_LIST_RE = /^https:\/\/jenkins\.example\.com\/api\/json\?tree=/;
const BUILDS_LIST_RE_ANY = /^https:\/\/jenkins\.example\.com\/job\/[^?]+\/api\/json\?tree=/;

// Per-job builds-list URLs — production code joins fullName segments with
// `/job/` and URL-encodes each segment. Anchor on the resulting path so
// per-job stubs can be registered before the catch-all builds-list stub.
const BUILDS_LIST_RE_BUILD_A =
  /^https:\/\/jenkins\.example\.com\/job\/team\/job\/build-a\/api\/json\?tree=/;
const BUILDS_LIST_RE_BUILD_B =
  /^https:\/\/jenkins\.example\.com\/job\/team\/job\/build-b\/api\/json\?tree=/;

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorJson(c: string): unknown {
  return JSON.parse(Buffer.from(c.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
}

const BASIC_AUTH = `Basic ${Buffer.from("jenkins-stub-user:jenkins-stub-token", "utf8").toString(
  "base64",
)}`;

/**
 * One-shot fixture for tests that need precise control over the vault state
 * (typically credential short-circuit assertions). The caller seeds the
 * vault inside `fn`; cleanup is guaranteed. No outer beforeEach.
 */
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

describe("jenkins-sync — credential short-circuits", () => {
  test("returns noop when no vault keys are set", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.cursor).toBeNull();
    });
  });

  test("returns noop when only base_url is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.base_url", BASE_URL);
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });
  });

  test("returns noop when only username is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.username", "jenkins-stub-user");
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
      expect(res.itemsUpserted).toBe(0);
    });
  });

  test("returns noop when only api_token is set", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.api_token", "jenkins-stub-token");
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when base_url / username / api_token are whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.base_url", "   ");
      await iso.vault.set("jenkins.username", "jenkins-stub-user");
      await iso.vault.set("jenkins.api_token", "jenkins-stub-token");
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.base_url", BASE_URL);
      await iso.vault.set("jenkins.username", "   ");
      await iso.vault.set("jenkins.api_token", "jenkins-stub-token");
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("jenkins.base_url", BASE_URL);
      await iso.vault.set("jenkins.username", "jenkins-stub-user");
      await iso.vault.set("jenkins.api_token", "   ");
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext(), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createJenkinsSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext(), "preserved-cursor");
      expect(res.cursor).toBe("preserved-cursor");
    });
  });
});

// All shared-fixture tests live under this outer describe so the
// `beforeEach`/`afterEach` are scoped to it (mirrors datadog-sync.test.ts).
describe("jenkins-sync — with shared fixture", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("jenkins.base_url", BASE_URL);
    await fixture.vault.set("jenkins.username", "jenkins-stub-user");
    await fixture.vault.set("jenkins.api_token", "jenkins-stub-token");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  describe("cursor decode", () => {
    test("null cursor → starts fresh with empty jobs map", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.cursor).not.toBeNull();
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({});
    });

    test("empty-string cursor → starts fresh", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), "");
      expect(res.cursor).not.toBeNull();
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({});
    });

    test("wrong-prefix cursor → starts fresh", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        "nimbus-other:abc",
      );
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({});
    });

    test("non-base64 garbage body → starts fresh", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        `${CURSOR_PREFIX}!!!not-base64!!!`,
      );
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({});
    });

    test("non-record jobs field → falls back to empty jobs map", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ jobs: "not-a-record" }),
      );
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({});
    });

    test("non-finite numeric values in jobs are dropped; finite numbers are retained via Math.floor", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({
          jobs: {
            "team/finite": 12.7,
            "team/inf": Number.POSITIVE_INFINITY,
            "team/nan": Number.NaN,
            "team/string": "not-a-number",
          },
        }),
      );
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({ "team/finite": 12 });
    });
  });

  describe("HTTP request paths", () => {
    test("sends basic auth header on jobs-list URL", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.fetchMock.firstCall().headers["authorization"]).toBe(BASIC_AUTH);
    });

    test("sends Accept: application/json on jobs-list URL", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.fetchMock.firstCall().headers["accept"]).toBe("application/json");
    });

    test("sends basic auth + Accept on builds-list URL", async () => {
      // Per-job stub first, then the broad jobs-list stub.
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, { builds: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const buildsCalls = fixture.fetchMock.calls.filter((c) => BUILDS_LIST_RE_ANY.test(c.url));
      expect(buildsCalls).toHaveLength(1);
      expect(buildsCalls[0].headers["authorization"]).toBe(BASIC_AUTH);
      expect(buildsCalls[0].headers["accept"]).toBe("application/json");
    });

    test("strips trailing slash from base_url before constructing URLs", async () => {
      await fixture.vault.set("jenkins.base_url", `${BASE_URL}/`);
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const url = fixture.fetchMock.firstCall().url;
      // No double-slash between host and `/api/json`.
      expect(url.startsWith(`${BASE_URL}/api/json?tree=`)).toBe(true);
      expect(url).not.toContain("//api/json");
    });

    test("jobs-list 5xx → cursor preserves previous {jobs} state and returns 0 upserts hasMore=false", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { error: "boom" }, { status: 500 });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ jobs: { "team/prior": 7 } }),
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(res.cursor).not.toBeNull();
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({ "team/prior": 7 });
    });

    test("jobs-list invalid JSON → bails (0 upserts)", async () => {
      fixture.fetchMock.respondWithText("GET", JOBS_LIST_RE, "<html>not json</html>");
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).not.toBeNull();
    });

    test("jobs-list non-object root (array) → bails", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, [1, 2, 3]);
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      // Only the jobs-list call should have fired — no per-job follow-ups.
      expect(fixture.fetchMock.calls).toHaveLength(1);
    });

    test("builds-list 5xx for one job → that job skipped, other jobs proceed", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          { name: "build-a", fullName: "team/build-a" },
          { name: "build-b", fullName: "team/build-b" },
        ],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, { error: "boom" }, { status: 500 });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_B, {
        builds: [{ number: 5, timestamp: recentTs, result: "SUCCESS" }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      // Only build-b's one build was upserted.
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'jenkins'",
        )
        .get();
      expect(row?.external_id).toBe("team/build-b#5");
    });
  });

  describe("job flattening", () => {
    test("flat list of jobs → all listed (each triggers a builds-list fetch)", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          { name: "build-a", fullName: "team/build-a" },
          { name: "build-b", fullName: "team/build-b" },
        ],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_ANY, { builds: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const buildsCalls = fixture.fetchMock.calls.filter((c) => BUILDS_LIST_RE_ANY.test(c.url));
      expect(buildsCalls).toHaveLength(2);
    });

    test("nested folder (jobs containing jobs) → depth-first flattened, all per-leaf builds fetched", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          {
            name: "folder1",
            fullName: "folder1",
            jobs: [
              {
                name: "sub",
                fullName: "folder1/sub",
                jobs: [{ name: "x", fullName: "folder1/sub/x" }],
              },
            ],
          },
        ],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_ANY, { builds: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      const buildsCalls = fixture.fetchMock.calls.filter((c) => BUILDS_LIST_RE_ANY.test(c.url));
      // Three entries: folder1, folder1/sub, folder1/sub/x (flattener
      // emits every node with a displayable name).
      expect(buildsCalls).toHaveLength(3);
      // The leaf path uses nested /job/ segments.
      const leafCall = buildsCalls.find((c) => c.url.includes("/job/folder1/job/sub/job/x/"));
      expect(leafCall).toBeDefined();
    });

    test("jobs-list with non-array jobs field → bails on flatten, 0 upserts", async () => {
      // jobs is not an array; production passes `undefined` to flattener.
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: "not-an-array" });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
      // Only the jobs-list call fired.
      expect(fixture.fetchMock.calls).toHaveLength(1);
    });
  });

  describe("build upsert filters", () => {
    test("build with number <= lastSeen → skipped", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [
          { number: 3, timestamp: recentTs, result: "SUCCESS" },
          { number: 4, timestamp: recentTs, result: "SUCCESS" },
        ],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        // Pretend we already saw build 4 — only 4 is at-or-below, so only it
        // gets skipped while 3 is below as well. Actually the predicate is
        // `num <= lastSeen`, so with lastSeen=4 BOTH 3 and 4 are skipped.
        encodeCursor({ jobs: { "team/build-a": 4 } }),
      );
      expect(res.itemsUpserted).toBe(0);
    });

    test("build with timestamp < floorMs → skipped", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const wayOldTs = Date.now() - 30 * 86_400_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [{ number: 1, timestamp: wayOldTs, result: "SUCCESS" }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("building:true + no result → title includes ' (running)' suffix", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [{ number: 7, timestamp: recentTs, building: true }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'jenkins'")
        .get();
      expect(row?.title).toBe("team/build-a #7 (running)");
    });

    test("result non-empty → title appends ' — <result>'", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [{ number: 9, timestamp: recentTs, result: "FAILURE" }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'jenkins'")
        .get();
      expect(row?.title).toBe("team/build-a #9 — FAILURE");
    });

    test("neither result nor building → bare title (no suffix)", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [{ number: 11, timestamp: recentTs }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ title: string }, []>("SELECT title FROM item WHERE service = 'jenkins'")
        .get();
      expect(row?.title).toBe("team/build-a #11");
    });

    test("builds-list missing 'builds' array → 0 upserts", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, { somethingElse: true });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(0);
    });

    test("non-record build entry → skipped", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [42, "string", null, { number: 5, timestamp: recentTs, result: "SUCCESS" }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
    });

    test("build without `number` field → skipped", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [
          { timestamp: recentTs, result: "SUCCESS" },
          { number: 8, timestamp: recentTs, result: "SUCCESS" },
        ],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
    });
  });

  describe("multi-job cursor", () => {
    test("two jobs, one build each → cursor.jobs has both entries with their numbers", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          { name: "build-a", fullName: "team/build-a" },
          { name: "build-b", fullName: "team/build-b" },
        ],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [{ number: 11, timestamp: recentTs, result: "SUCCESS" }],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_B, {
        builds: [{ number: 22, timestamp: recentTs, result: "SUCCESS" }],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(2);
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs).toEqual({ "team/build-a": 11, "team/build-b": 22 });
    });

    test("second sync with cursor → uses recorded lastSeen as floor; older builds skipped", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [{ name: "build-a", fullName: "team/build-a" }],
      });
      const recentTs = Date.now() - 60_000;
      // Returned builds: 5, 6, 7. We already saw 6 — only 7 should upsert.
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [
          { number: 5, timestamp: recentTs, result: "SUCCESS" },
          { number: 6, timestamp: recentTs, result: "SUCCESS" },
          { number: 7, timestamp: recentTs, result: "SUCCESS" },
        ],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(
        fixture.createSyncContext(),
        encodeCursor({ jobs: { "team/build-a": 6 } }),
      );
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'jenkins'",
        )
        .get();
      expect(row?.external_id).toBe("team/build-a#7");
      const decoded = decodeCursorJson(res.cursor!) as { jobs: Record<string, number> };
      expect(decoded.jobs["team/build-a"]).toBe(7);
    });

    test("builds with duration + url populate metadata correctly", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          {
            name: "build-a",
            fullName: "team/build-a",
            url: "https://jenkins.example.com/job/team/job/build-a/",
          },
        ],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [
          {
            number: 42,
            timestamp: recentTs,
            result: "SUCCESS",
            duration: 12_345,
            url: "https://jenkins.example.com/job/team/job/build-a/42/",
          },
        ],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(1);
      const row = fixture.db
        .query<{ metadata: string; url: string | null }, []>(
          "SELECT metadata, url FROM item WHERE service = 'jenkins'",
        )
        .get();
      expect(row?.url).toBe("https://jenkins.example.com/job/team/job/build-a/42/");
      const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.jobName).toBe("team/build-a");
      expect(meta.buildNumber).toBe(42);
      expect(meta.result).toBe("SUCCESS");
      expect(meta.building).toBe(false);
      expect(meta.duration_ms).toBe(12_345);
    });
  });

  describe("full-cycle", () => {
    test("2 jobs × 2 builds each → 4 upserts in ascending external_id order", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, {
        jobs: [
          { name: "build-a", fullName: "team/build-a" },
          { name: "build-b", fullName: "team/build-b" },
        ],
      });
      const recentTs = Date.now() - 60_000;
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_A, {
        builds: [
          { number: 1, timestamp: recentTs, result: "SUCCESS" },
          { number: 2, timestamp: recentTs, result: "FAILURE" },
        ],
      });
      fixture.fetchMock.respond("GET", BUILDS_LIST_RE_BUILD_B, {
        builds: [
          { number: 1, timestamp: recentTs, result: "SUCCESS" },
          { number: 2, timestamp: recentTs, result: "ABORTED" },
        ],
      });
      const res = await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(res.itemsUpserted).toBe(4);
      // external_id values are lowercase: SQLite default collation is case-sensitive.
      const rows = fixture.db
        .query<{ external_id: string }, []>(
          "SELECT external_id FROM item WHERE service = 'jenkins' ORDER BY external_id",
        )
        .all();
      expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual([
        "team/build-a#1",
        "team/build-a#2",
        "team/build-b#1",
        "team/build-b#2",
      ]);
    });

    test("emits no notifications", async () => {
      fixture.fetchMock.respond("GET", JOBS_LIST_RE, { jobs: [] });
      await createJenkinsSyncable(ENSURE_MCP).sync(fixture.createSyncContext(), null);
      expect(fixture.notifications.emitted).toHaveLength(0);
    });
  });
});
