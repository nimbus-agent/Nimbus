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
  JSM_MAX_PAGES,
  JSM_MAX_SCHEDULES,
  JSM_OPS_ROOT,
  JSM_UNAVAILABLE_BACKOFF_MS,
  type JsmCreds,
  parseParticipants,
  parseSchedules,
  resolvePinnedNextUrl,
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
      for (const c of calls.filter((x) => new URL(x.url).origin !== new URL(SITE).origin)) {
        const u = new URL(c.url);
        expect(u.origin).toBe(new URL(JSM_OPS_ROOT).origin);
        expect(u.pathname.startsWith(`${new URL(JSM_OPS_ROOT).pathname}/${CID}/v1/`)).toBe(true);
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

  test("an unparseable schedule entry is partial: nothing deleted, valid schedules still upserted", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      install(
        happy({
          [`${OPS}/schedules`]: {
            body: { values: [{ name: "Primary" }, { id: "sch1", name: "P" }] },
          },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
      expect(run.outcome).toEqual({ complete: false, upserted: 2, deleted: 0 });
      install(happy({ [`${OPS}/schedules`]: { body: { values: [{ name: "Primary" }] } } }));
      const only = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 2);
      expect(only.outcome).toEqual({ complete: false, upserted: 0, deleted: 0 });
      expect(rows(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("a non-array participant field is partial and keeps the stored responders", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      install(
        happy({ [`${OPS}/schedules/sch1/on-calls`]: { body: { onCallParticipants: "invalid" } } }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
      expect(rows(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("a user entry with no readable id is partial and keeps the stored responder's shift", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      const before = rows(db).length;
      install(
        happy({
          [`${OPS}/schedules/sch1/on-calls`]: {
            body: { onCallParticipants: [{ type: "user", name: "Alice" }] },
          },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
      expect(rows(db)).toHaveLength(before);
    } finally {
      db.close();
    }
  });

  test("a relative links.next (Atlassian's documented form) is followed and the set is replaced", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        happy({
          [`${OPS}/schedules`]: {
            body: {
              values: [{ id: "sch1", name: "A" }],
              links: { next: "/v1/schedules?offset=1" },
            },
          },
          [`${OPS}/schedules?offset=1`]: { body: { values: [], links: { next: null } } },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome?.complete).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a user nested in an escalation is indexed for both current and next shifts", async () => {
    const db = createMemoryIndexDb();
    try {
      install(
        happy({
          [`${OPS}/schedules/sch1/on-calls`]: {
            body: {
              onCallParticipants: [
                {
                  id: "esc",
                  type: "escalation",
                  onCallParticipants: [{ id: "acc-9", name: "Nina", type: "user" }],
                },
              ],
            },
          },
          [`${OPS}/schedules/sch1/next-on-calls`]: {
            body: {
              nextOnCallParticipants: [
                {
                  id: "esc",
                  type: "escalation",
                  nextOnCallParticipants: [{ id: "acc-8", name: "Omar", type: "user" }],
                },
              ],
            },
          },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome).toEqual({ complete: true, upserted: 2, deleted: 0 });
      expect(rows(db).map((r) => r.title)).toEqual([
        "On call: Nina — Primary rotation",
        "Next on call: Omar — Primary rotation",
      ]);
    } finally {
      db.close();
    }
  });

  test("links.next is followed on the pinned host: every page is read before the set is replaced", async () => {
    const db = createMemoryIndexDb();
    try {
      const page2 = `${OPS}/schedules?offset=1`;
      const { calls } = install(
        happy({
          [`${OPS}/schedules`]: {
            body: { values: [{ id: "sch1", name: "A" }], links: { next: page2 } },
          },
          [page2]: { body: { values: [{ id: "sch2", name: "B" }] } },
          [`${OPS}/schedules/sch2/on-calls`]: {
            body: { onCallParticipants: [{ id: "acc-3", name: "Pia", type: "user" }] },
          },
          [`${OPS}/schedules/sch2/next-on-calls`]: { body: { nextOnCallParticipants: [] } },
        }),
      );
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome).toEqual({ complete: true, upserted: 3, deleted: 0 });
      expect(calls.some((c) => c.url === page2)).toBe(true);
      expect(calls.some((c) => c.url.includes("/schedules/sch2/on-calls"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a links.next off the pinned host (or another cloud id) is never requested and is partial", async () => {
    const db = createMemoryIndexDb();
    try {
      install(happy());
      await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      for (const next of [
        "https://evil.example/jsm/ops/api/x/v1/schedules",
        "https://api.atlassian.com/jsm/ops/api/ffffffff-0000-4000-8000-000000000000/v1/schedules",
        `http://api.atlassian.com/jsm/ops/api/${CID}/v1/schedules`,
      ]) {
        const { calls } = install(
          happy({
            [`${OPS}/schedules`]: {
              body: { values: [{ id: "sch1", name: "P" }], links: { next } },
            },
          }),
        );
        const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
        expect(calls.some((c) => c.url === next)).toBe(false);
        expect(run.outcome?.complete).toBe(false);
        expect(run.outcome?.deleted).toBe(0);
      }
      expect(rows(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("a failing or unparseable second schedules page is partial; page 1 schedules are still read", async () => {
    const db = createMemoryIndexDb();
    try {
      for (const second of [{ status: 500 }, { text: "{nope" }] as Reply[]) {
        const page2 = `${OPS}/schedules?offset=1`;
        install(
          happy({
            [`${OPS}/schedules`]: {
              body: { values: [{ id: "sch1", name: "P" }], links: { next: page2 } },
            },
            [page2]: second,
          }),
        );
        const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
        expect(run.outcome).toEqual({ complete: false, upserted: 2, deleted: 0 });
      }
    } finally {
      db.close();
    }
  });

  test("the 50-schedule cap across pages, and an endless links.next chain, are partial", async () => {
    const db = createMemoryIndexDb();
    try {
      const mk = (from: number): Array<{ id: string; name: string }> =>
        Array.from({ length: 30 }, (_, i) => ({ id: `s${String(from + i)}`, name: "n" }));
      const p2 = `${OPS}/schedules?offset=30`;
      const { calls } = install((url) => {
        if (url === `${SITE}/rest/api/3/myself`) return { body: { accountId: "x" } };
        if (url === `${OPS}/schedules`) return { body: { values: mk(0), links: { next: p2 } } };
        if (url === p2) {
          return { body: { values: mk(30), links: { next: `${OPS}/schedules?offset=60` } } };
        }
        if (url.endsWith("/on-calls")) return { body: { onCallParticipants: [] } };
        if (url.endsWith("/next-on-calls")) return { body: { nextOnCallParticipants: [] } };
        return undefined;
      });
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
      expect(calls.filter((c) => c.url.endsWith("/on-calls"))).toHaveLength(JSM_MAX_SCHEDULES);
      expect(calls.some((c) => c.url.endsWith("offset=60"))).toBe(false);

      const loop = install((url) => {
        if (url === `${SITE}/rest/api/3/myself`) return { body: { accountId: "x" } };
        if (new URL(url).pathname === new URL(`${OPS}/schedules`).pathname) {
          return { body: { values: [], links: { next: `${OPS}/schedules?offset=1` } } };
        }
        return undefined;
      });
      const endless = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW + 1);
      expect(endless.outcome?.complete).toBe(false);
      expect(loop.calls.filter((c) => c.url.includes("/schedules")).length).toBeLessThanOrEqual(
        JSM_MAX_PAGES,
      );
    } finally {
      db.close();
    }
  });

  test("the budget covers a rate-limiter wait: a limiter that never grants a token ends the read, partial", async () => {
    const db = createMemoryIndexDb();
    try {
      const { calls } = install(happy());
      const ctx = ctxFor(db, { "jira.cloud_id": CID });
      let asked = 0;
      ctx.rateLimiter.tryAcquire = async () => {
        asked += 1;
        return asked <= 2; // /myself and /schedules, then the limiter is exhausted
      };
      let t = 0;
      const clock = (): number => {
        t += 20_000;
        return t;
      };
      const run = await runJsmOncall(ctx, CREDS, {}, NOW, clock);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
      expect(calls.some((c) => c.url.endsWith("/on-calls"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("the budget covers a hung request: its signal aborts at the deadline, partial", async () => {
    const db = createMemoryIndexDb();
    try {
      let aborted = false;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = urlFromFetchInput(input);
        if (url === `${SITE}/rest/api/3/myself`) return new Response('{"accountId":"a"}');
        if (url === `${OPS}/schedules`) {
          return new Response('{"values":[{"id":"sch1","name":"P"}]}');
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      }) as typeof fetch;
      let n = 0;
      // The list request and the schedule check see the whole budget; the hung on-calls request
      // then has 50 ms left, so its own deadline (not the 30 s request timeout) aborts it.
      const clock = (): number => {
        n += 1;
        return n <= 4 ? 0 : 59_950;
      };
      const run = await runJsmOncall(ctxFor(db, { "jira.cloud_id": CID }), CREDS, {}, NOW, clock);
      expect(aborted).toBe(true);
      expect(run.outcome?.complete).toBe(false);
      expect(run.outcome?.deleted).toBe(0);
    } finally {
      db.close();
    }
  });
});

describeWithFetchRestore("jsm oncall parsers", () => {
  test("parseSchedules accepts values, schedules, a bare list, counts unreadable entries, rejects junk", () => {
    expect(parseSchedules('{"values":[{"id":"a","name":"A"},{"x":1},5]}')).toEqual({
      schedules: [{ id: "a", name: "A" }],
      skipped: 2,
      next: null,
    });
    expect(parseSchedules('{"data":{"schedules":[{"id":"b"}]}}')).toEqual({
      schedules: [{ id: "b", name: "b" }],
      skipped: 0,
      next: null,
    });
    expect(parseSchedules('[{"id":"c","name":"C"}]')?.schedules).toEqual([{ id: "c", name: "C" }]);
    expect(parseSchedules('{"values":[{"name":"Primary"}]}')).toEqual({
      schedules: [],
      skipped: 1,
      next: null,
    });
    expect(parseSchedules("{}")).toBeNull();
    expect(parseSchedules("nope")).toBeNull();
  });

  test("parseSchedules reads links.next and rejects a malformed links block", () => {
    expect(parseSchedules('{"values":[],"links":{"next":"https://x/y"}}')?.next).toBe(
      "https://x/y",
    );
    expect(parseSchedules('{"values":[],"links":{"next":null}}')?.next).toBeNull();
    expect(parseSchedules('{"values":[],"links":{"next":5}}')).toBeNull();
    expect(parseSchedules('{"values":[],"links":"x"}')).toBeNull();
  });

  test("resolvePinnedNextUrl resolves Atlassian's relative /v1/ link against this cloud id's base", () => {
    expect(resolvePinnedNextUrl("/v1/schedules?offset=50&size=25", CID)).toBe(
      `${OPS}/schedules?offset=50&size=25`,
    );
    for (const bad of [
      "/v1/schedules/sch1/on-calls",
      "/v1/../../other/v1/schedules",
      "//evil.example/v1/schedules",
      "/v1/schedules#frag",
    ]) {
      expect(resolvePinnedNextUrl(bad, CID)).toBeNull();
    }
  });

  test("resolvePinnedNextUrl accepts only the fixed host, https, this cloud id and the schedules path", () => {
    const ok = `${OPS}/schedules?offset=50`;
    expect(resolvePinnedNextUrl(ok, CID)).toBe(ok);
    for (const bad of [
      `https://evil.example/jsm/ops/api/${CID}/v1/schedules`,
      `http://api.atlassian.com/jsm/ops/api/${CID}/v1/schedules`,
      `https://api.atlassian.com:8443/jsm/ops/api/${CID}/v1/schedules`,
      `https://u:p@api.atlassian.com/jsm/ops/api/${CID}/v1/schedules`,
      `https://api.atlassian.com.evil.example/jsm/ops/api/${CID}/v1/schedules`,
      `https://api.atlassian.com/jsm/ops/api/other-cloud/v1/schedules`,
      `https://api.atlassian.com/jsm/ops/api/${CID}/v1/schedules/sch1/on-calls`,
      "/jsm/ops/api/x",
      "not a url",
    ]) {
      expect(resolvePinnedNextUrl(bad, CID)).toBeNull();
    }
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
    ).toEqual({ users: [{ id: "u", name: "U" }], skipped: 3, unreadableUsers: 2 });
    expect(
      parseParticipants('{"nextOnCallParticipants":[{"id":"n","type":"user"}]}', [
        "nextOnCallParticipants",
        "onCallParticipants",
      ]),
    ).toEqual({ users: [{ id: "n", name: "n" }], skipped: 0, unreadableUsers: 0 });
  });

  test("a non-array participant field is a parse failure, at the top level and nested", () => {
    expect(
      parseParticipants('{"onCallParticipants":"invalid"}', ["onCallParticipants"]),
    ).toBeNull();
    expect(
      parseParticipants(
        '{"onCallParticipants":[{"id":"e","type":"escalation","onCallParticipants":"x"}]}',
        ["onCallParticipants"],
      ),
    ).toBeNull();
  });

  test("users nested in an escalation are indexed once each (on-call and next-on-call forms)", () => {
    const current = JSON.stringify({
      onCallParticipants: [
        {
          id: "esc1",
          type: "escalation",
          onCallParticipants: [
            { id: "u1", name: "One", type: "user" },
            { id: "t1", type: "team" },
          ],
        },
        { id: "u1", name: "One again", type: "user" },
        { id: "u2", name: "Two", type: "user" },
      ],
    });
    expect(parseParticipants(current, ["onCallParticipants"])).toEqual({
      users: [
        { id: "u1", name: "One" },
        { id: "u2", name: "Two" },
      ],
      skipped: 1,
      unreadableUsers: 0,
    });
    const next = JSON.stringify({
      nextOnCallParticipants: [
        {
          id: "esc1",
          type: "escalation",
          nextOnCallParticipants: [{ id: "u3", name: "Three", type: "user" }],
        },
      ],
    });
    expect(parseParticipants(next, ["nextOnCallParticipants", "onCallParticipants"])).toEqual({
      users: [{ id: "u3", name: "Three" }],
      skipped: 0,
      unreadableUsers: 0,
    });
  });

  test("nesting deeper than the bound is a parse failure", () => {
    let node: Record<string, unknown> = { id: "u", type: "user" };
    for (let i = 0; i < 8; i += 1) {
      node = { id: `e${String(i)}`, type: "escalation", onCallParticipants: [node] };
    }
    expect(
      parseParticipants(JSON.stringify({ onCallParticipants: [node] }), ["onCallParticipants"]),
    ).toBeNull();
  });
});
