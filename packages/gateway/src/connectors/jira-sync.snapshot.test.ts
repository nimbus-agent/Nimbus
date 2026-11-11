import { expect, test } from "bun:test";

import {
  boundTestCapabilities,
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  silentSyncContextExtras,
} from "./connector-sync-test-helpers.ts";
import { createJiraSyncable, JIRA_SNAPSHOT_JQL } from "./jira-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const PREFIX = "nimbus-jra1:";
const MIN = 60_000;

type Req = { jql: string; startAt: number; maxResults: number; fields: unknown };

function issue(key: string, due?: string): Record<string, unknown> {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `s ${key}`,
      updated: "2026-04-01T12:00:00.000+0000",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      ...(due === undefined ? {} : { duedate: due }),
    },
  };
}

function setup() {
  const db = createMemoryIndexDb();
  const vault = createStubVault({
    "jira.email": "u@example.com",
    "jira.api_token": "tok",
    "jira.base_url": "https://example.atlassian.net",
  });
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
    ...boundTestCapabilities(db, vault, "jira"),
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
  } as unknown as Parameters<ReturnType<typeof createJiraSyncable>["sync"]>[0];
  return { db, ctx, logs, acquired };
}

function snapRows(db: ReturnType<typeof createMemoryIndexDb>): string[] {
  return (
    db
      .query(
        "SELECT i.external_id AS k FROM work_snapshot w JOIN item i ON i.id = w.item_id WHERE w.service = 'jira' AND w.relation = 'assigned' ORDER BY i.external_id",
      )
      .all() as Array<{ k: string }>
  ).map((r) => r.k);
}

/** A fetch answering the incremental request with `inc` and the snapshot with `snap`. */
function fakeFetch(opts: {
  inc?: Array<Record<string, unknown>>;
  snap: (req: Req) => Response;
  reqs: Req[];
}): typeof fetch {
  return (async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as Req;
    opts.reqs.push(req);
    if (req.jql === JIRA_SNAPSHOT_JQL) return opts.snap(req);
    const inc = opts.inc ?? [];
    return new Response(JSON.stringify({ issues: inc, startAt: 0, total: inc.length }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

const page = (issues: Array<Record<string, unknown>>, total = issues.length): Response =>
  new Response(JSON.stringify({ issues, startAt: 0, total }), { status: 200 });

const syncable = (minutes?: number) =>
  createJiraSyncable({
    ensureJiraMcpRunning: async () => {},
    ...(minutes === undefined ? {} : { snapshotIntervalMinutes: () => minutes }),
  });

describeWithFetchRestore("jira my-open-work snapshot", () => {
  test("a first sync issues the incremental search and the snapshot search, then stores the members", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () => page([issue("A-1", "2026-11-20"), issue("A-2")]),
    });
    await syncable().sync(ctx, null);
    expect(reqs).toHaveLength(2);
    const [inc, snap] = reqs as [Req, Req];
    expect(inc.jql).toContain("updated");
    expect(snap.jql).toBe(
      "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC",
    );
    expect(snap.maxResults).toBe(100);
    expect(snap.startAt).toBe(0);
    expect(snap.fields).toEqual(inc.fields);
    expect(snapRows(db)).toEqual(["A-1", "A-2"]);
    const meta = db.query("SELECT metadata FROM item WHERE external_id = 'A-1'").get() as {
      metadata: string;
    };
    expect(JSON.parse(meta.metadata)).toMatchObject({
      due_at_ms: Date.parse("2026-11-20"),
    });
  });

  test("a second sync inside the interval makes no snapshot request; after it, one", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page([issue("A-1")]) });
    const now = Date.now();
    const at = (ageMs: number) =>
      encodeNimbusJsonCursor(PREFIX, { v: 1, floorJql: null, snapAt: now - ageMs });
    await syncable(5).sync(ctx, at(4 * MIN));
    expect(reqs.filter((r) => r.jql === JIRA_SNAPSHOT_JQL)).toHaveLength(0);
    await syncable(5).sync(ctx, at(6 * MIN));
    expect(reqs.filter((r) => r.jql === JIRA_SNAPSHOT_JQL)).toHaveLength(1);
  });

  test("a stale member leaves the snapshot but its item stays", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    let members = [issue("A-1"), issue("A-2")];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page(members) });
    await syncable().sync(ctx, null);
    members = [issue("A-2")];
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual(["A-2"]);
    expect(db.query("SELECT count(*) AS n FROM item WHERE external_id = 'A-1'").get()).toEqual({
      n: 1,
    });
  });

  test.each([
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["invalid JSON", () => new Response("{not json", { status: 200 })],
  ])(
    "a snapshot that fails with %s keeps the old set, succeeds the sync and advances snapAt",
    async (_l, bad) => {
      const { db, ctx, logs } = setup();
      const reqs: Req[] = [];
      let mode: "good" | "bad" = "good";
      globalThis.fetch = fakeFetch({
        reqs,
        snap: () => (mode === "good" ? page([issue("A-1")]) : bad()),
      });
      await syncable().sync(ctx, null);
      mode = "bad";
      const before = Date.now();
      const r = await syncable().sync(ctx, null);
      expect(r.itemsUpserted).toBe(0);
      expect(snapRows(db)).toEqual(["A-1"]);
      expect(logs.some((l) => l.level === "warn" && l.obj["snapshot_partial"] === true)).toBe(true);
      const rec = decodeNimbusJsonCursorObject(r.cursor, PREFIX);
      expect(Number(rec?.["snapAt"])).toBeGreaterThanOrEqual(before);
    },
  );

  test("a snapshot whose page 2 fails keeps the old set", async () => {
    const { db, ctx, logs } = setup();
    const reqs: Req[] = [];
    let fail = false;
    const hundred = Array.from({ length: 100 }, (_, i) => issue(`B-${String(i)}`));
    globalThis.fetch = fakeFetch({
      reqs,
      snap: (req) => {
        if (!fail) return page([issue("A-1")]);
        return req.startAt === 0 ? page(hundred, 250) : new Response("x", { status: 502 });
      },
    });
    await syncable().sync(ctx, null);
    fail = true;
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual(["A-1"]);
    expect(logs.some((l) => l.obj["snapshot_partial"] === true)).toBe(true);
  });

  test("a 429 on the snapshot does not fail the sync and leaves the snapshot empty", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({
      reqs,
      snap: () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    });
    const r = await syncable().sync(ctx, null);
    expect(r.cursor).toContain(PREFIX);
    expect(snapRows(db)).toEqual([]);
  });

  test("the cap is 3 pages of 100: 450 reported stores 300, logs capped, never asks for a 4th page", async () => {
    const { db, ctx, logs } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({
      reqs,
      snap: (req) =>
        page(
          Array.from({ length: 100 }, (_, i) => issue(`C-${String(req.startAt + i)}`)),
          450,
        ),
    });
    await syncable().sync(ctx, null);
    const snapReqs = reqs.filter((r) => r.jql === JIRA_SNAPSHOT_JQL);
    expect(snapReqs.map((r) => r.startAt)).toEqual([0, 100, 200]);
    expect(snapRows(db)).toHaveLength(300);
    const info = logs.find((l) => l.level === "info" && l.obj["relation"] === "assigned");
    expect(info?.obj).toMatchObject({ snapshot_capped: true, total: 450, stored: 300 });
  });

  test("an old cursor without snapAt decodes and triggers a snapshot; snapAt round-trips", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page([issue("A-1")]) });
    const old = encodeNimbusJsonCursor(PREFIX, { v: 1, floorJql: "2026/04/01 12:00" });
    const r = await syncable().sync(ctx, old);
    expect(reqs.some((q) => q.jql === JIRA_SNAPSHOT_JQL)).toBe(true);
    const rec = decodeNimbusJsonCursorObject(r.cursor, PREFIX);
    expect(rec?.["floorJql"]).toBe("2026/04/01 12:00");
    expect(typeof rec?.["snapAt"]).toBe("number");
    const reqs2: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs: reqs2, snap: () => page([]) });
    await syncable().sync(ctx, r.cursor);
    expect(reqs2.some((q) => q.jql === JIRA_SNAPSHOT_JQL)).toBe(false);
  });

  test("every snapshot request is preceded by a jira rate-limiter acquire", async () => {
    const { ctx, acquired } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page([issue("A-1")]) });
    await syncable().sync(ctx, null);
    // one for the incremental page, one for the snapshot page
    expect(acquired).toEqual(["acquire:jira", "acquire:jira"]);
  });

  test("a malformed (non-finite) snapAt in a cursor is ignored", async () => {
    const { ctx } = setup();
    const reqs: Req[] = [];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page([]) });
    const bad = encodeNimbusJsonCursor(PREFIX, { v: 1, floorJql: null, snapAt: "soon" });
    await syncable().sync(ctx, bad);
    expect(reqs.some((q) => q.jql === JIRA_SNAPSHOT_JQL)).toBe(true);
  });

  test("a snapshot that returns no issues clears the set", async () => {
    const { db, ctx } = setup();
    const reqs: Req[] = [];
    let members = [issue("A-1")];
    globalThis.fetch = fakeFetch({ reqs, snap: () => page(members) });
    await syncable().sync(ctx, null);
    members = [];
    await syncable().sync(ctx, null);
    expect(snapRows(db)).toEqual([]);
  });
});
