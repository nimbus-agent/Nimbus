import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import {
  JSM_MAX_SCHEDULES,
  JSM_OPS_ROOT,
  JSM_UNAVAILABLE_BACKOFF_MS,
  type JsmCreds,
  parseParticipants,
  parseSchedules,
  runJsmOncall,
} from "./jsm-oncall.ts";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const CID = "0123abcd-0123-4abc-8abc-0123456789ab";
const SITE = "https://acme.atlassian.net";
const CREDS: JsmCreds = { token: "tok", email: "me@acme.com", baseUrl: SITE };
const OPS = `${JSM_OPS_ROOT}/${CID}/v1`;

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { url: string; init?: RequestInit };

function install(handler: (url: string) => Reply | undefined): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlFromFetchInput(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const r = handler(url);
    if (r === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls };
}

function ctxFor(db: Database, secrets: Record<string, string> = {}): SyncContext {
  return {
    ...syncTestContext(db, createStubVault(secrets), "jira"),
    rateLimiter: new ProviderRateLimiter({ jira: { requestsPerMinute: 60_000, burstSize: 100 } }),
  };
}

function happy(over: Record<string, Reply> = {}): (url: string) => Reply | undefined {
  return (url) => {
    const hit = over[url];
    if (hit !== undefined) return hit;
    if (url === `${SITE}/rest/api/3/myself`) return { body: { accountId: "acc-1" } };
    if (url === `${OPS}/schedules`) {
      return { body: { values: [{ id: "sch1", name: "Primary rotation" }] } };
    }
    if (url === `${OPS}/schedules/sch1/on-calls`) {
      return {
        body: {
          data: {
            onCallParticipants: [
              { id: "acc-1", name: "Alice Ng", type: "user" },
              { id: "t1", name: "Team", type: "team" },
            ],
          },
        },
      };
    }
    if (url === `${OPS}/schedules/sch1/next-on-calls`) {
      return {
        body: { nextOnCallParticipants: [{ id: "acc-2", name: "bob@acme.com", type: "user" }] },
      };
    }
    return undefined;
  };
}

function rows(
  db: Database,
): Array<{ external_id: string; title: string; meta: Record<string, unknown> }> {
  return (
    db
      .query(
        "SELECT external_id, title, metadata FROM item WHERE service = 'jira' AND type = 'oncall_shift' ORDER BY external_id",
      )
      .all() as Array<{ external_id: string; title: string; metadata: string }>
  ).map((r) => ({
    external_id: r.external_id,
    title: r.title,
    meta: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

describeWithFetchRestore("jsm oncall refresh", () => {
  test("a stored cloud id: no tenant_info request, ops requests pinned to the fixed host, redirect manual", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(happy());
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome).toEqual({ complete: true, upserted: 2, deleted: 0 });
      expect(calls.map((c) => c.url)).toEqual([
        `${SITE}/rest/api/3/myself`,
        `${OPS}/schedules`,
        `${OPS}/schedules/sch1/on-calls`,
        `${OPS}/schedules/sch1/next-on-calls`,
      ]);
      for (const c of calls) {
        expect(c.init?.redirect).toBe("manual");
        expect(new URL(c.url).search).toBe("");
        const auth = (c.init?.headers as Record<string, string> | undefined)?.["Authorization"];
        expect(auth).toBe(`Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`);
      }
      for (const c of calls.filter((x) => !x.url.startsWith(SITE))) {
        expect(c.url.startsWith(`${JSM_OPS_ROOT}/${CID}/v1/`)).toBe(true);
      }
      expect(run.fields).toMatchObject({ ocAt: NOW, cid: CID, cidSite: SITE });
    } finally {
      db.close();
    }
  });

  test("maps current and next participants; skips non-users; is_me by accountId; e-mail-looking name", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      const r = rows(db);
      expect(r.map((x) => x.title)).toEqual([
        "On call: Alice Ng — Primary rotation",
        "Next on call: bob@acme.com — Primary rotation",
      ]);
      const alice = r.find((x) => x.meta["user_name"] === "Alice Ng");
      expect(alice?.meta).toMatchObject({ shift: "current", is_me: true, source: "jsm" });
      expect("start_ms" in (alice?.meta ?? {})).toBe(false);
      const bob = r.find((x) => x.meta["user_name"] === "bob@acme.com");
      expect(bob?.meta).toMatchObject({ shift: "next", is_me: false, user_email: "bob@acme.com" });
      expect(r.map((x) => x.external_id).every((id) => id.startsWith("oncall:jsm:sch1:"))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  test("is_me is false when /myself fails", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy({ [`${SITE}/rest/api/3/myself`]: { status: 403 } }));
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(rows(db).every((r) => r.meta["is_me"] === false)).toBe(true);
      install(happy({ [`${SITE}/rest/api/3/myself`]: { body: { accountId: "" } } }));
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(rows(db).every((r) => r.meta["is_me"] === false)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("tenant_info: one lookup, cached in the cursor, invalidated by a changed site", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(
        happy({ [`${SITE}/_edge/tenant_info`]: { body: { cloudId: CID } } }),
      );
      const first = await runJsmOncall(ctxFor(db), CREDS, {}, NOW);
      expect(calls.filter((c) => c.url.endsWith("/_edge/tenant_info"))).toHaveLength(1);
      expect(first.fields).toMatchObject({ cid: CID, cidSite: SITE });
      calls.length = 0;
      await runJsmOncall(ctxFor(db), CREDS, first.fields, NOW + 1);
      expect(calls.some((c) => c.url.endsWith("/_edge/tenant_info"))).toBe(false);
      calls.length = 0;
      const other = "https://other.atlassian.net";
      install((url) =>
        url === `${other}/_edge/tenant_info` ? { body: { cloudId: CID } } : happy()(url),
      );
      const run = await runJsmOncall(
        ctxFor(db),
        { ...CREDS, baseUrl: other },
        first.fields,
        NOW + 2,
      );
      expect(run.fields.cidSite).toBe(other);
    } finally {
      db.close();
    }
  });

  test("a bad tenant_info reply stops the step: no ops request, nothing written", async () => {
    const db = createMemoryIndexDb();
    try {
      for (const reply of [
        { body: { cloudId: "../../etc" } },
        { body: { cloudId: `${CID}/x` } },
        { text: "not json" },
        { status: 302 },
        { body: {} },
      ] as Reply[]) {
        const { calls } = install((url) =>
          url === `${SITE}/_edge/tenant_info` ? reply : undefined,
        );
        const run = await runJsmOncall(ctxFor(db), CREDS, {}, NOW);
        expect(run.outcome).toBeNull();
        expect(calls).toHaveLength(1);
      }
      expect(rows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a Data Center or proxied base with no stored id makes no request at all", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(() => undefined);
      for (const baseUrl of [
        "https://jira.corp.example",
        "http://acme.atlassian.net",
        "not a url",
      ]) {
        const run = await runJsmOncall(ctxFor(db), { ...CREDS, baseUrl }, {}, NOW);
        expect(run.outcome).toBeNull();
      }
      expect(calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a stored malformed cloud id is treated as absent", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(() => undefined);
      await runJsmOncall(
        ctxFor(db, { "jira.cloud_id": "evil/../id" }),
        { ...CREDS, baseUrl: "https://jira.corp.example" },
        {},
        NOW,
      );
      expect(calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a reply carrying an absolute URL does not redirect any request", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(
        happy({
          [`${OPS}/schedules`]: {
            body: {
              values: [{ id: "sch1", name: "P", url: "https://evil.example/x" }],
              next: "https://evil.example/n",
            },
          },
        }),
      );
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(calls.some((c) => c.url.includes("evil"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a schedule id that fails the pattern is skipped, never requested, and blocks the replace", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(
        happy({
          [`${OPS}/schedules`]: {
            body: {
              values: [
                { id: "a/b", name: "bad" },
                { id: "sch1", name: "P" },
              ],
            },
          },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(calls.some((c) => c.url.includes("a%2Fb") || c.url.includes("a/b"))).toBe(false);
      expect(run.outcome?.complete).toBe(false);
    } finally {
      db.close();
    }
  });

  test("more than 50 schedules: only 50 read, partial, nothing replaced", async () => {
    const db = createMemoryIndexDb();
    try {
      const values = Array.from({ length: 60 }, (_, i) => ({
        id: `s${String(i)}`,
        name: `S${String(i)}`,
      }));
      const { calls } = install((url) => {
        if (url === `${SITE}/rest/api/3/myself`) return { body: { accountId: "x" } };
        if (url === `${OPS}/schedules`) return { body: { values } };
        if (url.endsWith("/on-calls")) return { body: { onCallParticipants: [] } };
        if (url.endsWith("/next-on-calls")) return { body: { nextOnCallParticipants: [] } };
        return undefined;
      });
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
      expect(calls.filter((c) => c.url.endsWith("/on-calls"))).toHaveLength(JSM_MAX_SCHEDULES);
    } finally {
      db.close();
    }
  });

  test("a failing per-schedule request leaves the others upserted and no replace", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy({ [`${OPS}/schedules/sch1/next-on-calls`]: { status: 500 } }));
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome).toEqual({ complete: false, upserted: 1, deleted: 0 });
      expect(rows(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("an exhausted 60 s budget stops reading and is partial", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        happy({
          [`${OPS}/schedules`]: {
            body: {
              values: [
                { id: "sch1", name: "A" },
                { id: "sch2", name: "B" },
              ],
            },
          },
          [`${OPS}/schedules/sch2/on-calls`]: { body: { onCallParticipants: [] } },
        }),
      );
      let t = 0;
      const clock = (): number => {
        t += 40_000;
        return t;
      };
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW, clock);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
    } finally {
      db.close();
    }
  });

  test("401, 403 and 404 on the schedule list back off six hours and write nothing", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      for (const status of [401, 403, 404]) {
        install(happy({ [`${OPS}/schedules`]: { status } }));
        const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
        expect(run.fields.ocUntil).toBe(NOW + 1 + JSM_UNAVAILABLE_BACKOFF_MS);
        expect(run.outcome).toEqual({ complete: false, upserted: 0, deleted: 0 });
      }
      expect(rows(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("429 penalises jira and sets no backoff; an unparseable list is partial", async () => {
    const db = createMemoryIndexDb();
    try {
      const penalised: string[] = [];
      const ctx = ctxFor(db, { "jira.cloud_id": CID });
      ctx.rateLimiter.penalise = (p) => {
        penalised.push(p);
      };
      install(happy({ [`${OPS}/schedules`]: { status: 429 } }));
      const run = await runJsmOncall(ctx, CREDS, { ocUntil: 5 }, NOW);
      expect(penalised).toEqual(["jira"]);
      expect(run.fields.ocUntil).toBe(5);
      install(happy({ [`${OPS}/schedules`]: { text: "{nope" } }));
      const bad = await runJsmOncall(ctx, CREDS, { ocUntil: 5 }, NOW);
      expect(bad.outcome?.complete).toBe(false);
      expect("ocUntil" in bad.fields).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a complete refresh replaces its set and leaves Jira issues alone; an empty list deletes all", async () => {
    const db = createMemoryIndexDb();
    try {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
         VALUES ('jira:K-1', 'jira', 'issue', 'K-1', 't', 1, 1)`,
      );
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      install(
        happy({
          [`${OPS}/schedules/sch1/next-on-calls`]: { body: { nextOnCallParticipants: [] } },
        }),
      );
      const second = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
      expect(second.outcome).toEqual({ complete: true, upserted: 1, deleted: 1 });
      install(happy({ [`${OPS}/schedules`]: { body: { values: [] } } }));
      const third = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 2);
      expect(third.outcome).toEqual({ complete: true, upserted: 0, deleted: 1 });
      expect(db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'issue'").get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
    }
  });
});

describeWithFetchRestore("jsm oncall parsers", () => {
  test("parseSchedules accepts values, schedules, a bare list and rejects junk", () => {
    expect(parseSchedules('{"values":[{"id":"a","name":"A"},{"x":1},5]}')).toEqual([
      { id: "a", name: "A" },
    ]);
    expect(parseSchedules('{"data":{"schedules":[{"id":"b"}]}}')).toEqual([{ id: "b", name: "b" }]);
    expect(parseSchedules('[{"id":"c","name":"C"}]')).toEqual([{ id: "c", name: "C" }]);
    expect(parseSchedules("{}")).toBeNull();
    expect(parseSchedules("nope")).toBeNull();
  });

  test("parseParticipants counts non-users and bad ids, and takes the first present key", () => {
    expect(parseParticipants("{}", ["onCallParticipants"])).toBeNull();
    expect(
      parseParticipants(
        JSON.stringify({
          result: {
            onCallParticipants: [
              { id: "u", name: "U", type: "USER" },
              { id: "bad id", type: "user" },
              { type: "user" },
              "x",
            ],
          },
        }),
        ["onCallParticipants"],
      ),
    ).toEqual({ users: [{ id: "u", name: "U" }], skipped: 3 });
    expect(parseParticipants('{"onCallParticipants":"nope"}', ["onCallParticipants"])).toEqual({
      users: [],
      skipped: 0,
    });
    expect(
      parseParticipants('{"nextOnCallParticipants":[{"id":"n","type":"user"}]}', [
        "nextOnCallParticipants",
        "onCallParticipants",
      ]),
    ).toEqual({ users: [{ id: "n", name: "n" }], skipped: 0 });
  });
});
