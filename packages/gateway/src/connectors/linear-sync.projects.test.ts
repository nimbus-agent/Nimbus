import { expect, test } from "bun:test";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { PROJECTS_MAX_PAGES, PROJECTS_QUERY } from "./linear-projects.ts";
import { createLinearSyncable } from "./linear-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-lnr1:";
const SINCE = "2026-04-01T00:00:00.000Z";

type Req = { query: string; variables: Record<string, unknown> };
type Db = ReturnType<typeof createMemoryIndexDb>;

function project(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `proj-${String(n)}`,
    name: `Project ${String(n)}`,
    description: "",
    content: null,
    slugId: `slug${String(n)}`,
    url: `https://linear.app/x/project/p-${String(n)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-02-01T00:00:00.000Z",
    canceledAt: null,
    archivedAt: null,
    targetDate: null,
    status: { type: "completed", name: "Completed" },
    ...extra,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): Response {
  return new Response(
    JSON.stringify({ data: { projects: { nodes, pageInfo: { hasNextPage, endCursor } } } }),
    { status: 200 },
  );
}

function setup() {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "linear.api_key": "key" });
  const warns: string[] = [];
  const extras = silentSyncContextExtras();
  const ctx = {
    db,
    vault,
    ...extras,
    ...boundTestCapabilities(db, vault, "linear"),
    logger: {
      info: () => undefined,
      warn: (_o: unknown, m?: string) => warns.push(String(m)),
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as Parameters<ReturnType<typeof createLinearSyncable>["sync"]>[0];
  // A limiter that never waits: this file tests the listing, not the token bucket.
  (ctx as { rateLimiter: unknown }).rateLimiter = {
    acquire: async () => undefined,
    tryAcquire: async () => true,
    penalise: () => undefined,
  };
  return { db, ctx, warns };
}

const isProjects = (r: Req): boolean => r.query === PROJECTS_QUERY;

function fakeFetch(reqs: Req[], projects: (req: Req, n: number) => Response): typeof fetch {
  let n = 0;
  return (async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as Req;
    reqs.push(req);
    if (isProjects(req)) {
      n += 1;
      return projects(req, n);
    }
    return new Response(
      JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const syncable = () => createLinearSyncable({ ensureLinearMcpRunning: async () => {} });

// A cursor whose snapshot is fresh, so only the issue and project requests are made.
const cursor = (extra: Record<string, unknown> = {}): string =>
  encodeNimbusJsonCursor(PREFIX, { since: SINCE, snapAt: Date.now(), ...extra });

function projectIds(db: Db): string[] {
  return (
    db
      .query(
        "SELECT external_id AS k FROM item WHERE service='linear' AND type='project' ORDER BY 1",
      )
      .all() as Array<{ k: string }>
  ).map((r) => r.k);
}

function projAtOf(c: string | null): unknown {
  return decodeNimbusJsonCursorObject(c, PREFIX)?.["projAt"];
}

describeWithFetchRestore("linear project pass", () => {
  test("a complete listing upserts, then deletes a project absent from it and keeps issues", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch(reqs, () => page([project(1), project(2)]));
    await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-1", "proj-2"]);
    ctx.upsertItem({
      service: "linear",
      type: "issue",
      externalId: "ENG-1",
      title: "t",
      body: "",
      url: null,
      canonicalUrl: null,
      modifiedAt: 1,
      authorId: null,
      metadata: {},
      pinned: false,
      syncedAt: 1,
    });
    globalThis.fetch = fakeFetch(reqs, () => page([project(2)]));
    await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-2"]);
    expect(
      (db.query("SELECT count(*) AS c FROM item WHERE type='issue'").get() as { c: number }).c,
    ).toBe(1);
  });

  test("an archived project is kept", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () =>
      page([project(1, { archivedAt: "2026-03-05T00:00:00.000Z" })]),
    );
    await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-1"]);
  });

  test("page 2 fails after page 1 parsed: page 1 kept, nothing deleted, projAt set", async () => {
    const { db, ctx, warns } = setup();
    globalThis.fetch = fakeFetch([], () => page([project(9)]));
    await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-9"]);
    globalThis.fetch = fakeFetch([], (_r, n) =>
      n === 1 ? page([project(1)], true, "c2") : new Response("boom", { status: 502 }),
    );
    const r = await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-1", "proj-9"]);
    expect(typeof projAtOf(r.cursor)).toBe("number");
    expect(warns.some((w) => w.includes("nothing deleted"))).toBe(true);
  });

  test("a failing first page writes nothing, sets projAt and does not fail the sync", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () => new Response("boom", { status: 500 }));
    const r = await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual([]);
    expect(r.cursor).toContain(PREFIX);
    expect(typeof projAtOf(r.cursor)).toBe("number");
  });

  test("a page that does not parse is unwritten, earlier pages kept, nothing deleted", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () => page([project(9)]));
    await syncable().sync(ctx, cursor());
    globalThis.fetch = fakeFetch([], (_r, n) =>
      n === 1 ? page([project(1)], true, "c2") : page([project(2), { name: "no id" }]),
    );
    await syncable().sync(ctx, cursor());
    expect(projectIds(db)).toEqual(["proj-1", "proj-9"]);
  });

  test("a listing capped at the page limit keeps the rows read and deletes nothing", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () => page([project(900)]));
    await syncable().sync(ctx, cursor());
    let seen = 0;
    globalThis.fetch = fakeFetch([], (_r, n) => {
      seen = n;
      return page([project(n)], true, `c${String(n)}`);
    });
    await syncable().sync(ctx, cursor());
    expect(seen).toBe(PROJECTS_MAX_PAGES);
    expect(projectIds(db)).toContain("proj-900");
    expect(projectIds(db)).toHaveLength(PROJECTS_MAX_PAGES + 1);
  });

  test("a 429 does not fail the issue sync and deletes nothing", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () => page([project(1)]));
    await syncable().sync(ctx, cursor());
    globalThis.fetch = fakeFetch([], () => new Response("slow", { status: 429 }));
    const r = await syncable().sync(ctx, cursor());
    expect(r.cursor).toContain(PREFIX);
    expect(projectIds(db)).toEqual(["proj-1"]);
  });

  test("a canceled project with only canceledAt gets resolved_at_ms", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () =>
      page([
        project(1, {
          completedAt: null,
          canceledAt: "2026-02-20T00:00:00.000Z",
          status: { type: "canceled", name: "Canceled" },
        }),
      ]),
    );
    await syncable().sync(ctx, cursor());
    const row = db.query("SELECT metadata FROM item WHERE type='project'").get() as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)).toMatchObject({
      status_category: "canceled",
      resolved_at_ms: Date.parse("2026-02-20T00:00:00.000Z"),
    });
  });

  test("a status of an unknown type is unknown, in no closed set", async () => {
    const { db, ctx } = setup();
    globalThis.fetch = fakeFetch([], () =>
      page([project(1, { status: { type: "archivedish", name: "?" } })]),
    );
    await syncable().sync(ctx, cursor());
    const row = db.query("SELECT metadata FROM item WHERE type='project'").get() as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)["status_category"]).toBe("unknown");
  });

  test("cadence: no projAt fetches once and writes it; a fresh projAt fetches none", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch(reqs, () => page([project(1)]));
    const r = await syncable().sync(ctx, cursor());
    expect(reqs.filter(isProjects)).toHaveLength(1);
    expect(typeof projAtOf(r.cursor)).toBe("number");
    await syncable().sync(ctx, cursor({ projAt: Date.now() }));
    expect(reqs.filter(isProjects)).toHaveLength(1);
  });

  test("an old cursor still decodes, issues use the same since, and a project pass never moves it", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch(reqs, () => page([project(1)]));
    const r = await syncable().sync(ctx, cursor());
    const issueReq = reqs.find((q) => !isProjects(q) && q.query.includes("LinearSync"));
    expect(issueReq?.variables["gt"]).toBe(SINCE);
    expect(decodeNimbusJsonCursorObject(r.cursor, PREFIX)?.["since"]).toBe(SINCE);
  });

  test("the projects query asks for canceledAt and status type and name", () => {
    expect(PROJECTS_QUERY).toContain("canceledAt");
    expect(PROJECTS_QUERY).toMatch(/status \{\s+type\s+name\s+\}/);
  });
});
