import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createGithubSyncable } from "./github-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-ghub1:";
const MIN = 60_000;
const ENSURE_MCP = { ensureGithubMcpRunning: async (): Promise<void> => {} };
const EVENTS = "https://api.github.com/users/octo/events?per_page=100";
const SEARCH = "https://api.github.com/search/issues?";

const QUERIES = {
  assigned: "is:open is:issue assignee:@me",
  review_requested: "is:open is:pr review-requested:@me",
  authored_open: "is:open is:pr author:@me",
} as const;

const realFetch = globalThis.fetch;
let seen: string[] = [];
let handler: (url: string) => Response;

beforeEach(() => {
  seen = [];
  handler = () => new Response("[]", { status: 200, headers: { etag: '"e"' } });
  globalThis.fetch = ((input: unknown) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    seen.push(url);
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup(vaultExtra: Record<string, string> = {}) {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "github.pat": "pat-test", ...vaultExtra });
  const logs: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const log =
    (level: string) =>
    (obj: unknown): void => {
      if (typeof obj === "object" && obj !== null) {
        logs.push({ level, obj: obj as Record<string, unknown> });
      }
    };
  const extras = silentSyncContextExtras();
  const acquired: string[] = [];
  const realAcquire = extras.rateLimiter.acquire.bind(extras.rateLimiter);
  extras.rateLimiter.acquire = ((p: Parameters<typeof realAcquire>[0]) => {
    acquired.push(`acquire:${p}@${String(seen.length)}`);
    return realAcquire(p);
  }) as typeof extras.rateLimiter.acquire;
  const ctx = {
    db,
    vault,
    ...extras,
    ...boundTestCapabilities(db, vault, "github"),
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
  } as unknown as Parameters<ReturnType<typeof createGithubSyncable>["sync"]>[0];
  return { db, ctx, logs, acquired };
}

const cursor = (extra: Record<string, unknown> = {}): string =>
  encodeNimbusJsonCursor(PREFIX, { etag: null, login: "octo", ...extra });

function queryOf(url: string): string {
  return new URL(url).searchParams.get("q") ?? "";
}

function hit(
  kind: "issue" | "pr",
  num: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: num,
    title: `${kind} ${String(num)}`,
    html_url: `https://github.com/o/r/${kind === "pr" ? "pull" : "issues"}/${String(num)}`,
    state: "open",
    repository_url: "https://api.github.com/repos/o/r",
    user: { login: "octo" },
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    ...(kind === "pr" ? { pull_request: { url: "x" }, draft: false, labels: [] } : {}),
    ...extra,
  };
}

function search(items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ total_count: items.length, incomplete_results: false, items, ...extra }),
    { status: 200 },
  );
}

/** Routes: events -> `[]`, each search by its decoded q. */
function route(by: Partial<Record<keyof typeof QUERIES, () => Response>>): void {
  handler = (url) => {
    if (url.startsWith(SEARCH) || url.includes("/search/issues?")) {
      const q = queryOf(url);
      for (const [rel, text] of Object.entries(QUERIES)) {
        if (q === text) return by[rel as keyof typeof QUERIES]?.() ?? search([]);
      }
      return new Response("{}", { status: 404 });
    }
    return new Response("[]", { status: 200, headers: { etag: '"e"' } });
  };
}

function rows(db: ReturnType<typeof createMemoryIndexDb>, relation: string): string[] {
  return (
    db
      .query(
        "SELECT i.external_id AS k FROM work_snapshot w JOIN item i ON i.id = w.item_id WHERE w.service = 'github' AND w.relation = ? ORDER BY i.external_id",
      )
      .all(relation) as Array<{ k: string }>
  ).map((r) => r.k);
}

describe("github my-open-work snapshot", () => {
  test("three searches follow the events call, each acquired first, with the exact queries", async () => {
    const { ctx, acquired } = setup();
    route({});
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(seen[0]).toBe(EVENTS);
    const searches = seen.slice(1);
    expect(searches).toHaveLength(3);
    expect(searches.map(queryOf)).toEqual(Object.values(QUERIES));
    for (const u of searches) {
      const url = new URL(u);
      expect(url.origin + url.pathname).toBe("https://api.github.com/search/issues");
      expect(url.searchParams.get("per_page")).toBe("100");
      expect(url.searchParams.get("sort")).toBe("updated");
      expect(url.searchParams.get("order")).toBe("desc");
    }
    // events acquire at 0 requests made, then one acquire before each search
    expect(acquired).toEqual([
      "acquire:github@0",
      "acquire:github@1",
      "acquire:github@2",
      "acquire:github@3",
    ]);
  });

  test("against a GHES base every search goes to that instance, never api.github.com", async () => {
    const { ctx } = setup({ "github.api_base": "https://ghe.example.com" });
    route({});
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(seen.length).toBeGreaterThan(1);
    for (const u of seen) expect(new URL(u).origin).toBe("https://ghe.example.com");
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(3);
    expect(seen.some((u) => u.includes("/api/v3/search/issues"))).toBe(true);
  });

  test("hits become issue and pr rows with their depth and land under their relations", async () => {
    const { db, ctx } = setup();
    route({
      assigned: () =>
        search([
          hit("issue", 5, { milestone: { title: "v2", due_on: "2026-11-20T08:00:00Z" } }),
          hit("issue", 6),
        ]),
      review_requested: () => search([hit("pr", 9)]),
      authored_open: () => search([hit("pr", 9), hit("pr", 10)]),
    });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toEqual(["o/r#issue-5", "o/r#issue-6"]);
    // a PR in both PR searches is in both relations
    expect(rows(db, "review_requested")).toEqual(["o/r#9"]);
    expect(rows(db, "authored_open")).toEqual(["o/r#10", "o/r#9"]);
    const meta = (ext: string) =>
      JSON.parse(
        (
          db.query("SELECT metadata FROM item WHERE external_id = ?").get(ext) as {
            metadata: string;
          }
        ).metadata,
      ) as Record<string, unknown>;
    expect(meta("o/r#issue-5")).toMatchObject({
      meta_v: 1,
      due_at_ms: Date.parse("2026-11-20T08:00:00Z"),
      milestone: "v2",
    });
    expect(meta("o/r#issue-6").due_at_ms).toBeUndefined();
    expect(meta("o/r#9")).toMatchObject({ meta_v: 3 });
    const type = db.query("SELECT type FROM item WHERE external_id = 'o/r#9'").get();
    expect(type).toEqual({ type: "pr" });
  });

  test("the 304 path still runs the snapshot when due, and not inside the interval", async () => {
    const { ctx } = setup();
    handler = (url) =>
      url === EVENTS ? new Response(null, { status: 304 }) : search([hit("issue", 1)]);
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor({ etag: '"e1"' }));
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(3);
    seen = [];
    const r = await createGithubSyncable(ENSURE_MCP).sync(
      ctx,
      cursor({ etag: '"e1"', snapAt: Date.now() - 5 * MIN }),
    );
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(0);
    expect(typeof decodeNimbusJsonCursorObject(r.cursor, PREFIX)?.["snapAt"]).toBe("number");
    seen = [];
    await createGithubSyncable({ ...ENSURE_MCP, snapshotIntervalMinutes: () => 5 }).sync(
      ctx,
      cursor({ etag: '"e1"', snapAt: Date.now() - 6 * MIN }),
    );
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(3);
  });

  test("a relation that fails keeps its old set while the others still replace", async () => {
    const { db, ctx, logs } = setup();
    route({
      assigned: () => search([hit("issue", 1)]),
      review_requested: () => search([hit("pr", 3)]),
      authored_open: () => search([hit("pr", 4)]),
    });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    // Now two relations fail (incomplete results, HTTP 500) and one succeeds: the relations are
    // independent, so the failing two keep their sets and the good one replaces its own.
    route({
      assigned: () => search([hit("issue", 2)], { incomplete_results: true }),
      review_requested: () => new Response("x", { status: 500 }),
      authored_open: () => search([hit("pr", 40)]),
    });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toEqual(["o/r#issue-1"]);
    expect(rows(db, "review_requested")).toEqual(["o/r#3"]);
    expect(rows(db, "authored_open")).toEqual(["o/r#40"]);
    expect(logs.filter((l) => l.obj["snapshot_partial"] === true).length).toBeGreaterThanOrEqual(2);
  });

  test("a hit with an unparseable repository_url is skipped and counted, not partial", async () => {
    const { db, ctx, logs } = setup();
    route({
      assigned: () => search([hit("issue", 1), hit("issue", 2, { repository_url: "nonsense" })]),
    });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toEqual(["o/r#issue-1"]);
    expect(logs.some((l) => l.level === "warn" && l.obj["skipped"] === 1)).toBe(true);
    expect(
      logs.some((l) => l.obj["relation"] === "assigned" && l.obj["snapshot_partial"] === true),
    ).toBe(false);
  });

  test("total_count above the page is capped, not partial", async () => {
    const { db, ctx, logs } = setup();
    route({
      assigned: () =>
        search(
          Array.from({ length: 100 }, (_, i) => hit("issue", i + 1)),
          { total_count: 340 },
        ),
    });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toHaveLength(100);
    const info = logs.find((l) => l.level === "info" && l.obj["relation"] === "assigned");
    expect(info?.obj).toMatchObject({ snapshot_capped: true, total: 340, stored: 100 });
  });

  test("a 403 with no quota left penalises github, does not fail the sync and stops further searches", async () => {
    const { ctx } = setup();
    handler = (url) =>
      url === EVENTS
        ? new Response("[]", { status: 200, headers: { etag: '"e"' } })
        : new Response("limit", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "retry-after": "1" },
          });
    const r = await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(r.cursor).toContain(PREFIX);
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(1);
  });

  test("a stored api_base that no longer validates makes no request at all", async () => {
    const { ctx } = setup({ "github.api_base": "http://not-https.example.com" });
    handler = () => new Response("[]", { status: 200 });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(seen).toEqual([]);
  });

  test("the cursor round-trips snapAt; an old {etag, login} cursor decodes and snapshots", async () => {
    const { ctx } = setup();
    route({});
    const r = await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(3);
    const rec = decodeNimbusJsonCursorObject(r.cursor, PREFIX);
    expect(rec?.["login"]).toBe("octo");
    expect(typeof rec?.["snapAt"]).toBe("number");
    seen = [];
    await createGithubSyncable(ENSURE_MCP).sync(ctx, r.cursor);
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(0);
  });

  test("a non-finite snapAt is ignored", async () => {
    const { ctx } = setup();
    route({});
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor({ snapAt: "x" }));
    expect(seen.filter((u) => u.includes("/search/issues"))).toHaveLength(3);
  });

  test("a hit with no number and a non-object hit are skipped", async () => {
    const { db, ctx } = setup();
    route({ assigned: () => search([{ ...hit("issue", 1), number: undefined }, hit("issue", 2)]) });
    // a raw string item is not an object
    handler = ((prev) => (url: string) => {
      const res = prev(url);
      return url.includes("search") && queryOf(url) === QUERIES.assigned
        ? new Response(
            JSON.stringify({
              total_count: 3,
              incomplete_results: false,
              items: ["junk", { ...hit("issue", 1), number: undefined }, hit("issue", 2)],
            }),
            { status: 200 },
          )
        : res;
    })(handler);
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toEqual(["o/r#issue-2"]);
  });

  test("a search body without an items array is partial", async () => {
    const { db, ctx, logs } = setup();
    route({ assigned: () => new Response(JSON.stringify({ total_count: 0 }), { status: 200 }) });
    await createGithubSyncable(ENSURE_MCP).sync(ctx, cursor());
    expect(rows(db, "assigned")).toEqual([]);
    expect(logs.some((l) => l.obj["snapshot_partial"] === true)).toBe(true);
  });
});
