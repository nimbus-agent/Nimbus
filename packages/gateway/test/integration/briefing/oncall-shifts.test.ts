/**
 * Morning briefing MB3, end to end over a real SQLite FILE: the REAL pagerduty and jira syncables
 * through the production capability set, a fake HTTP layer per provider, then `queryOncallNow` with
 * `fetch` replaced by a thrower (spec § 7: the answer comes from the index with the HTTP fake disabled).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createJiraSyncable } from "../../../src/connectors/jira-sync.ts";
import {
  decodeNimbusJsonCursorObject,
  encodeNimbusJsonCursor,
} from "../../../src/connectors/nimbus-json-cursor.ts";
import { createPagerdutySyncable } from "../../../src/connectors/pagerduty-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { queryOncallNow } from "../../../src/index/oncall-now-query.ts";
import { ensureFullSqlite } from "../../../src/platform/sqlite-runtime.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { requestUrlString } from "../../../src/testing/bun-test-support.ts";
import { rmDirWithRetry } from "../../helpers/rm-dir-with-retry.ts";

const tempDirs: string[] = [];
const realFetch = globalThis.fetch;
let requests: string[] = [];
let router: (url: string) => Response = () => new Response("{}", { status: 404 });

function createIndexDb(): Database {
  ensureFullSqlite();
  const root = mkdtempSync(join(tmpdir(), "nimbus-oncall-shifts-"));
  tempDirs.push(root);
  const db = new Database(join(root, "index.db"));
  LocalIndex.ensureSchema(db);
  return db;
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = requestUrlString(input);
    requests.push(url);
    return router(url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const d of tempDirs.splice(0)) rmDirWithRetry(d);
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function fastCtx(
  db: Database,
  service: "pagerduty" | "jira",
  vault: Record<string, string>,
): SyncContext {
  return {
    ...syncTestContext(db, createStubVault(vault), service),
    rateLimiter: new ProviderRateLimiter({
      [service]: { requestsPerMinute: 60_000, burstSize: 100 },
    }),
  };
}

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

type Oncall = { user: string; name: string; email?: string };
let oncalls: Oncall[] = [];
let oncallsFail = false;

function pagerdutyRouter(url: string): Response {
  const u = new URL(url);
  if (u.pathname === "/incidents") return json({ incidents: [], more: false });
  if (u.pathname === "/users/me") return json({ user: { id: "U-ME", email: "me@acme.com" } });
  if (u.pathname === "/services") {
    return json({
      services: [{ id: "PSVC1", name: "payment-service", escalation_policy: { id: "EP1" } }],
      more: false,
    });
  }
  if (u.pathname === "/oncalls") {
    if (oncallsFail) return json({}, 500);
    return json({
      oncalls: oncalls.map((o) => ({
        user: { id: o.user, name: o.name, email: o.email },
        escalation_policy: { id: "EP1", summary: "Payments policy" },
        escalation_level: 1,
        schedule: { id: "S1", summary: "Payments primary" },
        start: iso(-3_600_000),
        end: iso(3_600_000),
      })),
      more: false,
    });
  }
  return json({}, 404);
}

function rows(db: Database, service: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM item WHERE service = ? AND type = 'oncall_shift'")
      .get(service) as { n: number }
  ).n;
}

describe("PagerDuty on-call shifts, end to end", () => {
  beforeEach(() => {
    oncalls = [{ user: "U-ME", name: "Alice Ng", email: "alice@acme.com" }];
    oncallsFail = false;
    router = pagerdutyRouter;
  });

  test("one refresh, then the query answers with fetch disabled", async () => {
    const db = createIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    await syncable.sync(fastCtx(db, "pagerduty", { "pagerduty.api_token": "tok" }), null);
    // The [ci.service.payment-service] binding names the fake's service id.
    const binding = [{ serviceId: "payment-service", pagerdutyServices: ["PSVC1"] }];

    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("no live API call at question time");
    }) as unknown as typeof fetch;
    const r = queryOncallNow(db, {
      nowMs: Date.now(),
      term: "payment-service",
      serviceConfigs: binding,
    });
    expect(r.status).toBe("ok");
    expect(r.resolvedVia).toBe("binding");
    expect(r.shifts.map((s) => s.userName)).toEqual(["Alice Ng"]);
    expect(r.youAreOnCall).toBe(true);
    expect(calls).toBe(0);
    db.close();
  });

  test("a second refresh that omits a shift deletes it and leaves incidents alone", async () => {
    const db = createIndexDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('pagerduty:PINC', 'pagerduty', 'incident', 'PINC', 't', 1, 1)`,
    );
    oncalls = [
      { user: "U-ME", name: "Alice Ng" },
      { user: "U-2", name: "Bob" },
    ];
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = { "pagerduty.api_token": "tok" };
    const first = await syncable.sync(fastCtx(db, "pagerduty", vault), null);
    expect(rows(db, "pagerduty")).toBe(2);
    oncalls = [{ user: "U-ME", name: "Alice Ng" }];
    // An absent cursor is what `nimbus index rebody` leaves: it refreshes at once.
    await syncable.sync(fastCtx(db, "pagerduty", vault), null);
    expect(rows(db, "pagerduty")).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'incident'").get()).toEqual({
      n: 1,
    });
    expect(first.cursor).not.toBeNull();
    db.close();
  });

  test("a refresh whose on-call page fails keeps the earlier rows and their age", async () => {
    const db = createIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = { "pagerduty.api_token": "tok" };
    await syncable.sync(fastCtx(db, "pagerduty", vault), null);
    const before = queryOncallNow(db, { nowMs: Date.now() }).sources[0]?.oldestFetchedMs;
    oncallsFail = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await syncable.sync(fastCtx(db, "pagerduty", vault), null);
    expect(rows(db, "pagerduty")).toBe(1);
    expect(queryOncallNow(db, { nowMs: Date.now() }).sources[0]?.oldestFetchedMs).toBe(before);
    db.close();
  });

  test("three syncs 60 s apart make exactly one set of on-call requests", async () => {
    const db = createIndexDb();
    const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
    const vault = { "pagerduty.api_token": "tok" };
    let cursor: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      cursor = (await syncable.sync(fastCtx(db, "pagerduty", vault), cursor)).cursor;
    }
    expect(requests.filter((u) => u.includes("/oncalls"))).toHaveLength(1);
    expect(requests.filter((u) => u.includes("/users/me"))).toHaveLength(1);
    db.close();
  });
});

describe("JSM Operations on-call shifts, end to end", () => {
  const SITE = "https://acme.atlassian.net";
  const CID = "0123abcd-0123-4abc-8abc-0123456789ab";
  const OPS = `https://api.atlassian.com/jsm/ops/api/${CID}/v1`;
  let schedulesStatus = 200;

  function jiraRouter(url: string): Response {
    if (url.endsWith("/rest/api/3/search")) return json({ issues: [], startAt: 0, total: 0 });
    if (url === `${SITE}/_edge/tenant_info`) return json({ cloudId: CID });
    if (url === `${SITE}/rest/api/3/myself`) return json({ accountId: "acc-1" });
    if (url === `${OPS}/schedules`) {
      return schedulesStatus === 200
        ? json({ values: [{ id: "s1", name: "Primary rotation" }] })
        : json({}, schedulesStatus);
    }
    if (url === `${OPS}/schedules/s1/on-calls`) {
      return json({ onCallParticipants: [{ id: "acc-1", name: "Alice Ng", type: "user" }] });
    }
    if (url === `${OPS}/schedules/s1/next-on-calls`) return json({ nextOnCallParticipants: [] });
    return json({}, 404);
  }

  const baseVault = { "jira.email": "u@acme.com", "jira.api_token": "tok", "jira.base_url": SITE };

  beforeEach(() => {
    schedulesStatus = 200;
    router = jiraRouter;
  });

  test("a stored cloud id: rows for the schedule, is_me by accountId", async () => {
    const db = createIndexDb();
    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    await syncable.sync(fastCtx(db, "jira", { ...baseVault, "jira.cloud_id": CID }), null);
    expect(requests.some((u) => u.endsWith("/_edge/tenant_info"))).toBe(false);
    const r = queryOncallNow(db, { nowMs: Date.now(), term: "Primary rotation" });
    expect(r.status).toBe("ok");
    expect(r.shifts[0]).toMatchObject({ userName: "Alice Ng", isMe: true, source: "jsm" });
    expect(r.sources[0]?.source).toBe("jsm");
    db.close();
  });

  test("no stored id on an atlassian.net site: exactly one tenant_info call, cached in the cursor", async () => {
    const db = createIndexDb();
    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const first = await syncable.sync(fastCtx(db, "jira", baseVault), null);
    expect(requests.filter((u) => u.endsWith("/_edge/tenant_info"))).toHaveLength(1);
    const cur = decodeNimbusJsonCursorObject(first.cursor, "nimbus-jra1:");
    expect(cur?.["cid"]).toBe(CID);
    // An old ocAt makes the next refresh due; the cached id means no second lookup.
    const aged = encodeNimbusJsonCursor("nimbus-jra1:", { ...cur, ocAt: Date.now() - 20 * 60_000 });
    await syncable.sync(fastCtx(db, "jira", baseVault), aged);
    expect(requests.filter((u) => u.endsWith("/_edge/tenant_info"))).toHaveLength(1);
    expect(requests.filter((u) => u === `${OPS}/schedules`)).toHaveLength(2);
    db.close();
  });

  test("a 403 on the schedule list records a backoff, writes no rows and deletes nothing", async () => {
    const db = createIndexDb();
    const syncable = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
    const vault = { ...baseVault, "jira.cloud_id": CID };
    await syncable.sync(fastCtx(db, "jira", vault), null);
    expect(rows(db, "jira")).toBe(1);
    schedulesStatus = 403;
    const second = await syncable.sync(fastCtx(db, "jira", vault), null);
    expect(rows(db, "jira")).toBe(1);
    const cur = decodeNimbusJsonCursorObject(second.cursor, "nimbus-jra1:");
    expect(Number(cur?.["ocUntil"])).toBeGreaterThan(Date.now());
    db.close();
  });
});
