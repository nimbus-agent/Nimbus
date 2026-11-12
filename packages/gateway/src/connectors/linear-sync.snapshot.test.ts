import { expect, test } from "bun:test";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createLinearSyncable, ISSUE_FIELDS, SNAPSHOT_QUERY } from "./linear-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-lnr1:";
const MIN = 60_000;

type Req = { query: string; variables: Record<string, unknown> };

function node(identifier: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `t ${identifier}`,
    updatedAt: "2026-04-01T12:00:00.000Z",
    url: `https://linear.app/x/issue/${identifier}`,
    state: { name: "In Progress", type: "started" },
    ...extra,
  };
}

function setup() {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "linear.api_key": "key" });
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
    acquired.push(`acquire:${p}`);
    return realAcquire(p);
  }) as typeof extras.rateLimiter.acquire;
  const ctx = {
    db,
    vault,
    ...extras,
    ...boundTestCapabilities(db, vault, "linear"),
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
  } as unknown as Parameters<ReturnType<typeof createLinearSyncable>["sync"]>[0];
  return { db, ctx, logs, acquired };
}

function snapRows(db: ReturnType<typeof createMemoryIndexDb>): string[] {
  return (
    db
      .query(
        "SELECT i.external_id AS k FROM work_snapshot w JOIN item i ON i.id = w.item_id WHERE w.service = 'linear' AND w.relation = 'assigned' ORDER BY i.external_id",
      )
      .all() as Array<{ k: string }>
  ).map((r) => r.k);
}

const isSnapshot = (r: Req): boolean => r.query === SNAPSHOT_QUERY;

function fakeFetch(opts: { snap: (req: Req) => Response; reqs: Req[] }): typeof fetch {
  return (async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as Req;
    opts.reqs.push(req);
    if (isSnapshot(req)) return opts.snap(req);
    return new Response(
      JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function snapPage(
  nodes: Array<Record<string, unknown>>,
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return new Response(
    JSON.stringify({
      data: { viewer: { assignedIssues: { nodes, pageInfo: { hasNextPage, endCursor } } } },
    }),
    { status: 200 },
  );
}

const syncable = (minutes?: number) =>
  createLinearSyncable({
    ensureLinearMcpRunning: async () => {},
    ...(minutes === undefined ? {} : { snapshotIntervalMinutes: () => minutes }),
  });

describeWithFetchRestore("linear my-open-work snapshot", () => {
  test("the snapshot query is a viewer.assignedIssues query on open states, newest first, sharing the issue fields", async () => {
    expect(SNAPSHOT_QUERY).toContain("viewer");
    expect(SNAPSHOT_QUERY).toContain("assignedIssues(first: 100");
    expect(SNAPSHOT_QUERY).toContain('state: { type: { nin: ["completed", "canceled"] } }');
    expect(SNAPSHOT_QUERY).toContain("orderBy: updatedAt");
    expect(SNAPSHOT_QUERY).toContain(ISSUE_FIELDS);
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => snapPage([]) });
    await syncable().sync(ctx, null);
    const [inc] = reqs as [Req];
    expect(inc.query).toContain(ISSUE_FIELDS);
  });

  test("members are mapped like synced issues and stored under assigned", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () => snapPage([node("ENG-1", { dueDate: "2026-11-20" }), node("ENG-2")]),
    });
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual(["ENG-1", "ENG-2"]);
    const row = db.query("SELECT metadata FROM item WHERE external_id = 'ENG-1'").get() as {
      metadata: string;
    };
    expect(JSON.parse(row.metadata)).toMatchObject({
      due_at_ms: Date.parse("2026-11-20"),
      status_category: "in_progress",
      meta_v: 1,
    });
  });

  test("interval gating runs through the cursor's snapAt", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => snapPage([node("ENG-1")]) });
    const now = Date.now();
    const at = (age: number) =>
      encodeNimbusJsonCursor(PREFIX, { since: "2026-04-01T00:00:00.000Z", snapAt: now - age });
    await syncable(5).sync(ctx, at(4 * MIN));
    expect(reqs.filter(isSnapshot)).toHaveLength(0);
    await syncable(5).sync(ctx, at(6 * MIN));
    expect(reqs.filter(isSnapshot)).toHaveLength(1);
  });

  test.each([
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    [
      "GraphQL errors",
      () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
    ],
    ["a 429", () => new Response("slow", { status: 429 })],
    ["an unexpected shape", () => new Response(JSON.stringify({ data: {} }), { status: 200 })],
  ])(
    "a snapshot that fails with %s keeps the old set and does not fail the sync",
    async (_l, bad) => {
      const { db, ctx, logs } = setup();
      const reqs: Req[] = [];
      let mode: "good" | "bad" = "good";
      globalThis.fetch = fakeFetch({
        reqs,
        snap: () => (mode === "good" ? snapPage([node("ENG-1")]) : bad()),
      });
      await syncable().sync(ctx, null);
      mode = "bad";
      const r = await syncable().sync(ctx, null);
      expect(r.cursor).toContain(PREFIX);
      expect(snapRows(db)).toEqual(["ENG-1"]);
      expect(logs.some((l) => l.level === "warn" && l.obj["snapshot_partial"] === true)).toBe(true);
      expect(typeof decodeNimbusJsonCursorObject(r.cursor, PREFIX)?.["snapAt"]).toBe("number");
    },
  );

  test("a page-2 failure keeps the old set", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    let fail = false;
    globalThis.fetch = fakeFetch({
      reqs,
      snap: (req) => {
        if (!fail) return snapPage([node("ENG-1")]);
        return req.variables["after"] === undefined
          ? snapPage([node("ENG-9")], true, "c2")
          : new Response("x", { status: 502 });
      },
    });
    await syncable().sync(ctx, null);
    fail = true;
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual(["ENG-1"]);
  });

  test("the cap is 3 pages: hasNextPage still true is capped, stores 300 and never asks for a 4th", async () => {
    const { db, ctx, logs, acquired } = setup();
    const reqs: Req[] = [];
    let n = 0;
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () => {
        const base = n * 100;
        n += 1;
        return snapPage(
          Array.from({ length: 100 }, (_, i) => node(`ENG-${String(base + i)}`)),
          true,
          `c${String(n)}`,
        );
      },
    });
    await syncable().sync(ctx, null);
    expect(reqs.filter(isSnapshot)).toHaveLength(3);
    expect(snapRows(db)).toHaveLength(300);
    const info = logs.find((l) => l.level === "info" && l.obj["relation"] === "assigned");
    expect(info?.obj).toMatchObject({ snapshot_capped: true, stored: 300 });
    // 1 incremental page + 3 snapshot pages, each acquired first
    expect(acquired).toEqual(Array.from({ length: 4 }, () => "acquire:linear"));
  });

  test("an old {since} cursor decodes and triggers a snapshot; the incremental since is unaffected", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () => snapPage([node("ENG-1", { updatedAt: "2030-01-01T00:00:00.000Z" })]),
    });
    const old = encodeNimbusJsonCursor(PREFIX, { since: "2026-04-15T08:00:00.000Z" });
    const r = await syncable().sync(ctx, old);
    expect(reqs.some(isSnapshot)).toBe(true);
    const rec = decodeNimbusJsonCursorObject(r.cursor, PREFIX);
    expect(rec?.["since"]).toBe("2026-04-15T08:00:00.000Z");
    expect(typeof rec?.["snapAt"]).toBe("number");
  });

  test("a non-finite snapAt is ignored", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => snapPage([]) });
    const bad = encodeNimbusJsonCursor(PREFIX, { since: "2026-04-15T08:00:00.000Z", snapAt: "x" });
    await syncable().sync(ctx, bad);
    expect(reqs.some(isSnapshot)).toBe(true);
  });

  test("a snapshot request that never answers times out as a partial: old set kept, cursor kept", async () => {
    const { db, ctx, logs } = setup();
    const reqs: Req[] = [];
    let hang = false;
    const inner = fakeFetch({ reqs, snap: () => snapPage([node("ENG-1")]) });
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Req;
      if (hang && isSnapshot(body)) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return (inner as unknown as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;
    const fast = () =>
      createLinearSyncable({ ensureLinearMcpRunning: async () => {}, snapshotTimeoutMs: 20 });
    await fast().sync(ctx, null);
    expect(snapRows(db)).toEqual(["ENG-1"]);
    hang = true;
    const r = await fast().sync(ctx, null);
    expect(snapRows(db)).toEqual(["ENG-1"]);
    expect(logs.some((l) => l.level === "warn" && l.obj["snapshot_partial"] === true)).toBe(true);
    expect(typeof decodeNimbusJsonCursorObject(r.cursor, PREFIX)?.["snapAt"]).toBe("number");
  });

  test.each([
    ["hasNextPage missing", { endCursor: null }],
    ["hasNextPage not a boolean", { hasNextPage: "true", endCursor: "c" }],
    ["hasNextPage true without endCursor", { hasNextPage: true }],
    ["hasNextPage true with an empty endCursor", { hasNextPage: true, endCursor: "" }],
  ])("a malformed pageInfo (%s) is partial and keeps the old set", async (_l, pageInfo) => {
    const { db, ctx, logs } = setup();
    const reqs: Req[] = [];
    let bad = false;
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () =>
        bad
          ? new Response(
              JSON.stringify({
                data: { viewer: { assignedIssues: { nodes: [node("ENG-9")], pageInfo } } },
              }),
              { status: 200 },
            )
          : snapPage([node("ENG-1")]),
    });
    await syncable().sync(ctx, null);
    bad = true;
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual(["ENG-1"]);
    expect(logs.some((l) => l.obj["snapshot_partial"] === true)).toBe(true);
  });
});
