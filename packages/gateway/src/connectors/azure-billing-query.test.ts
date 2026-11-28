// The Azure Query API fallback over the REAL capabilities, store and index; only HTTPS is faked: one fake serves the
// token endpoint and management.azure.com. The shapes follow Microsoft's Query reference
// (see azure-cost-query.ts), not a live tenant.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAzureConfig } from "../config/cost-azure-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { AzureFetch } from "./_lib/azure-token.ts";
import { createAzureBillingCostSyncable } from "./azure-billing-cost-sync.ts";
import { lastQueryDay } from "./azure-billing-query-run.ts";
import {
  AZURE_QUERY_API_VERSION,
  AZURE_QUERY_GAPS,
  AZURE_QUERY_MAX_PAGES,
  AZURE_QUERY_RETRY_HEADER,
  acceptableNextLink,
  queryBody,
  queryUrl,
  readAzureQueryMonth,
} from "./azure-cost-query.ts";
import { RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.azure_billing;
const SUB = "/subscriptions/11111111-2222-3333-4444-555555555555";
const ACCT = SUB.slice(1);
const COLS = ["Cost", "UsageDate", "ServiceName", "ResourceGroupName", "Currency"].map((name) => ({
  name,
  type: "String",
}));
const ROW: unknown[] = [10, 20261103, "Storage", "RG1", "USD"];

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("azure.tenant_id", "11111111-2222-3333-4444-555555555555");
  await vault.set("azure.client_id", "app");
  await vault.set("azure.client_secret", "secret");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "azure_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "azure_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
}

const page = (rows: unknown[][], nextLink?: string) =>
  new Response(
    JSON.stringify({
      properties: { columns: COLS, rows, ...(nextLink === undefined ? {} : { nextLink }) },
    }),
  );

type Req = { url: string; auth: string | null; body: Record<string, unknown> };
class Management {
  readonly requests: Req[] = [];
  tokenCalls = 0;
  scopes: string[] = [];
  /** Answers by call number (1-based); the default is one row on 2026-11-03. */
  answer: (n: number, req: Req) => Response = () => page([ROW]);
  fetch: AzureFetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "login.microsoftonline.com") {
      this.tokenCalls++;
      this.scopes.push(new URLSearchParams(String(init.body)).get("scope") ?? "");
      return new Response(JSON.stringify({ access_token: "T" }));
    }
    if (u.host !== "management.azure.com") return new Response("x", { status: 404 });
    const req: Req = {
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    this.requests.push(req);
    expect(init.method).toBe("POST");
    return this.answer(this.requests.length, req);
  };
}

const cfg = (over: Partial<NimbusCostAzureConfig> = {}): NimbusCostAzureConfig => ({
  export: null,
  scopes: [SUB],
  ...over,
});

async function run(
  m: Management,
  config: NimbusCostAzureConfig | null = cfg(),
  cursor: string | null = null,
  now = NOW,
) {
  const sleeps: number[] = [];
  const out = await createAzureBillingCostSyncable({
    azure: () => config,
    now: () => now,
    fetch: m.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }).sync(ctx(), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor), sleeps };
}

const stored = () =>
  readCostLines(db, { fromDay: "2026-10-01", toDay: "2026-11-30" }).filter(
    (l) => l.source === "azure_billing",
  );

describe("azure_billing: the Query API fallback", () => {
  test("writes one month per scope, with the request the API documents", async () => {
    const m = new Management();
    const { out, cursor } = await run(m, cfg({ scopes: [`${SUB}/`] }));
    expect(out.itemsUpserted).toBe(1);
    expect(stored()[0]).toMatchObject({
      billingAccountId: ACCT,
      subAccountId: "rg1",
      serviceName: "Storage",
      chargeDay: "2026-11-03",
      billedCost: 10,
      provider: "azure",
    });
    expect(cursor.gaps).toEqual({});
    expect(cursor.synced[ACCT]).toBe("2026-11-20");
    expect(m.scopes).toEqual(["https://management.azure.com/.default"]);
    expect(m.tokenCalls).toBe(1);
    const r = m.requests[0];
    expect(r?.url).toBe(
      `https://management.azure.com${SUB}/providers/Microsoft.CostManagement/query?api-version=${AZURE_QUERY_API_VERSION}`,
    );
    expect(r?.auth).toBe("Bearer T");
    expect(r?.body).toEqual({
      type: "ActualCost",
      timeframe: "Custom",
      timePeriod: { from: "2026-11-01T00:00:00Z", to: "2026-11-20T23:59:59Z" },
      dataset: {
        granularity: "Daily",
        aggregation: { totalCost: { name: "Cost", function: "Sum" } },
        grouping: [
          { type: "Dimension", name: "ServiceName" },
          { type: "Dimension", name: "ResourceGroupName" },
        ],
      },
    });
    // A re-sync replaces the same day: it never doubles.
    await run(new Management());
    expect(stored()).toHaveLength(1);
  });

  test("an export wins: the scopes are not read; no export and no scopes is the configuration gap", async () => {
    const m = new Management();
    const withExport = cfg({ export: { account: "acmecost", container: "c", path: "p" } });
    await run(m, withExport);
    expect(m.requests).toHaveLength(0);
    const none = await run(m, cfg({ scopes: [] }));
    expect(Object.values(none.cursor.gaps)[0]).toContain("set [cost.azure] export, or scopes");
    expect(m.requests).toHaveLength(0);
  });

  test("no credentials and an unreadable config read nothing", async () => {
    await vault.delete("azure.client_secret");
    const m = new Management();
    await run(m);
    expect(m.tokenCalls).toBe(0);
    const kept = await run(m, null, "nimbus-azb1:abc");
    expect(kept.out.cursor).toBe("nimbus-azb1:abc");
  });

  test("a 429 waits the header's seconds once and repeats; a second 429 is a retry; a missing header waits 60 s", async () => {
    const m = new Management();
    m.answer = (n) =>
      n === 1
        ? new Response("", { status: 429, headers: { [AZURE_QUERY_RETRY_HEADER]: "7" } })
        : page([ROW]);
    const a = await run(m);
    expect(a.sleeps).toEqual([7000]);
    expect(stored()).toHaveLength(1);

    const m2 = new Management();
    m2.answer = () => new Response("", { status: 429 });
    const b = await run(m2, cfg(), null);
    expect(b.sleeps).toEqual([]); // no header is taken as 60 s: longer than the 30 s cap, so no sleep
    expect(b.cursor.pending[ACCT]?.length).toBeGreaterThan(0);
    expect(b.cursor.gaps).toEqual({}); // a retry is not a stated gap
    expect(m2.requests).toHaveLength(1);

    const m3 = new Management();
    m3.answer = () =>
      new Response("", { status: 429, headers: { [AZURE_QUERY_RETRY_HEADER]: "30" } });
    const c = await run(m3);
    expect(c.sleeps).toEqual([30_000]); // the cap itself is waited
    expect(m3.requests).toHaveLength(2); // one wait, one repeat, then the next run
  });

  test("after a 429 the remaining scopes are not queried and stay pending", async () => {
    const other = "/subscriptions/99999999-2222-3333-4444-555555555555";
    const m = new Management();
    m.answer = () => new Response("", { status: 429 });
    const r = await run(m, cfg({ scopes: [SUB, other] }));
    expect(m.requests).toHaveLength(1);
    expect(r.cursor.pending[ACCT]?.length).toBeGreaterThan(0);
    expect(r.cursor.pending[other.slice(1)]?.length).toBeGreaterThan(0);
  });

  test("a 401 drops the token once and repeats; a second 401 is the role gap", async () => {
    const m = new Management();
    m.answer = (n) => (n === 1 ? new Response("", { status: 401 }) : page([ROW]));
    await run(m);
    expect(m.tokenCalls).toBe(2);
    expect(stored()).toHaveLength(1);
    const m2 = new Management();
    m2.answer = () => new Response("", { status: 401 });
    const r = await run(m2);
    expect(r.cursor.gaps[ACCT]).toBe(AZURE_QUERY_GAPS.access);
    expect(m2.tokenCalls).toBe(2);
    expect(m2.requests).toHaveLength(2);
  });

  test("a retry-after beyond 30 seconds is not waited for", async () => {
    const m = new Management();
    m.answer = () =>
      new Response("", { status: 429, headers: { [AZURE_QUERY_RETRY_HEADER]: "31" } });
    const r = await run(m);
    expect(r.sleeps).toEqual([]);
    expect(m.requests).toHaveLength(1);
  });

  test("401 and 403 name the Cost Management Reader role; 404 and 400 are scope gaps; 5xx retries", async () => {
    for (const [status, reason] of [
      [401, AZURE_QUERY_GAPS.access],
      [403, AZURE_QUERY_GAPS.access],
      [404, AZURE_QUERY_GAPS.notFound],
      [400, AZURE_QUERY_GAPS.rejected],
    ] as const) {
      const m = new Management();
      m.answer = () => new Response("", { status });
      expect((await run(m)).cursor.gaps[ACCT]).toBe(reason);
    }
    expect(AZURE_QUERY_GAPS.access).toContain("Cost Management Reader");
    const m = new Management();
    m.answer = () => new Response("", { status: 503 });
    const r = await run(m);
    expect(r.cursor.gaps).toEqual({});
    expect(stored()).toHaveLength(0);
  });

  test("one refused scope does not stop another", async () => {
    const other = "/subscriptions/99999999-2222-3333-4444-555555555555";
    const m = new Management();
    m.answer = (_n, req) =>
      req.url.includes(other) ? new Response("", { status: 403 }) : page([ROW]);
    const r = await run(m, cfg({ scopes: [other, SUB] }));
    expect(r.cursor.gaps[other.slice(1)]).toBe(AZURE_QUERY_GAPS.access);
    expect(stored().map((l) => l.billingAccountId)).toEqual([ACCT]);
  });

  test("pages follow nextLink with the same body", async () => {
    const m = new Management();
    const next = `https://management.azure.com${SUB}/providers/Microsoft.CostManagement/query?api-version=${AZURE_QUERY_API_VERSION}&$skiptoken=A`;
    m.answer = (n) => (n === 1 ? page([ROW], next) : page([[2, 20261104, "S", "g", "USD"]]));
    await run(m);
    expect(m.requests[1]?.url).toBe(next);
    expect(m.requests[1]?.body).toEqual(m.requests[0]?.body);
    expect(stored()).toHaveLength(2);
  });

  test("a nextLink that repeats, leaves management.azure.com or is not https makes the month a gap with no write", async () => {
    const same = `https://management.azure.com${SUB}/providers/Microsoft.CostManagement/query?api-version=${AZURE_QUERY_API_VERSION}`;
    for (const link of [
      same,
      "https://evil.example/q",
      "http://management.azure.com/q",
      "not a url",
    ]) {
      const m = new Management();
      m.answer = () => page([ROW], link);
      const r = await run(m);
      expect(r.cursor.gaps[ACCT]).toContain("does not advance");
      expect(stored()).toHaveLength(0);
      expect(m.requests).toHaveLength(2); // one per month of a first sync
    }
    expect(acceptableNextLink("https://management.azure.com/x", new Set())).toBe(true);
  });

  test("twenty pages is the cap: the month is a gap and nothing is written", async () => {
    let posts = 0;
    const r = await readAzureQueryMonth(
      {
        post: async () => {
          posts++;
          return {
            kind: "page" as const,
            columns: COLS,
            rows: [ROW],
            next: `https://management.azure.com/p?page=${String(posts + 1)}`,
          };
        },
      },
      ACCT,
      "2026-11",
      "2026-11-20",
    );
    expect(posts).toBe(AZURE_QUERY_MAX_PAGES);
    expect(r).toMatchObject({ kind: "month_gap" });
    expect(JSON.stringify(r)).toContain("more than 20 pages");
    expect(stored()).toHaveLength(0);
  });

  test("a missing currency column is a retry (nothing written, no stated gap)", async () => {
    const m = new Management();
    m.answer = () =>
      new Response(
        JSON.stringify({
          properties: {
            columns: COLS.filter((c) => c.name !== "Currency"),
            rows: [[1, 20261103, "S", "g"]],
          },
        }),
      );
    const r = await run(m);
    expect(stored()).toHaveLength(0);
    expect(r.cursor.gaps).toEqual({});
    expect(r.cursor.pending[ACCT]?.length).toBeGreaterThan(0);
  });

  test("an unreadable row makes the month a gap; a body that is not a result is a retry", async () => {
    const m = new Management();
    m.answer = () => page([ROW, [1, "bad", "S", "g", "USD"]]);
    expect((await run(m)).cursor.gaps[ACCT]).toContain("could not be read");
    expect(stored()).toHaveLength(0);
    const m2 = new Management();
    m2.answer = () => new Response("{}");
    expect((await run(m2)).cursor.gaps).toEqual({});
    const m3 = new Management();
    m3.answer = () => new Response("not json");
    expect((await run(m3)).cursor.gaps).toEqual({});
  });

  test("an empty answer never clears a stored month; with nothing stored it is fine", async () => {
    await run(new Management());
    expect(stored()).toHaveLength(1);
    const empty = new Management();
    empty.answer = () => new Response(null, { status: 204 });
    const r = await run(empty);
    expect(r.cursor.gaps[ACCT]).toContain("returned no rows");
    expect(stored()).toHaveLength(1);
    db.run("DELETE FROM cost_line");
    const fresh = await run(empty);
    expect(fresh.cursor.gaps).toEqual({});
  });

  test("an empty month is asked again at most once a day (current), with no query in between", async () => {
    const first = await run(new Management());
    const empty = new Management();
    empty.answer = () => new Response(null, { status: 204 });
    const a = await run(empty, cfg(), first.out.cursor, NOW + DAY);
    expect(a.cursor.gaps[ACCT]).toContain("asked again every 1 day");
    expect(a.cursor.emptyScan?.[`${ACCT}|2026-11`]).toBe("2026-11-21");
    const asked = empty.requests.length;
    expect(asked).toBeGreaterThan(0);
    // Same day again: the stated gap stands and no QPU is spent.
    const b = await run(empty, cfg(), a.out.cursor, NOW + DAY);
    expect(empty.requests).toHaveLength(asked);
    expect(b.cursor.gaps[ACCT]).toContain("asked again");
    // The next day the current month is asked again.
    const c = await run(empty, cfg(), b.out.cursor, NOW + 2 * DAY);
    expect(empty.requests.length).toBeGreaterThan(asked);
    expect(c.cursor.emptyScan?.[`${ACCT}|2026-11`]).toBe("2026-11-22");
    expect(stored()).toHaveLength(1);
    // A real answer clears the record.
    const d = await run(new Management(), cfg(), c.out.cursor, NOW + 3 * DAY);
    expect(d.cursor.emptyScan).toBeUndefined();
    expect(d.cursor.gaps).toEqual({});
  });

  test("a past month is asked again only after a week", async () => {
    const first = await run(new Management());
    const dec3 = Date.UTC(2026, 11, 3, 9); // up to the 5th the previous month (November) is read again
    const empty = new Management();
    empty.answer = () => new Response(null, { status: 204 });
    const a = await run(empty, cfg(), first.out.cursor, dec3);
    expect(a.cursor.emptyScan?.[`${ACCT}|2026-11`]).toBe("2026-12-03");
    expect(a.cursor.gaps[ACCT]).toContain("asked again every 7 days");
    const nov = () =>
      empty.requests.filter((r) => JSON.stringify(r.body).includes("2026-11-01")).length;
    const asked = nov();
    expect(asked).toBeGreaterThan(0);
    await run(empty, cfg(), a.out.cursor, dec3 + 6 * DAY); // six days later: no new November query
    expect(nov()).toBe(asked);
    await run(empty, cfg(), a.out.cursor, dec3 + 7 * DAY);
    expect(nov()).toBe(asked + 1);
  });

  test("a scope written in other letters is the same account", async () => {
    const mixed = SUB.replace("/subscriptions", "/Subscriptions")
      .toUpperCase()
      .replace("/SUBSCRIPTIONS", "/Subscriptions");
    await run(new Management(), cfg({ scopes: [mixed] }));
    expect(stored().map((l) => l.billingAccountId)).toEqual([ACCT]);
    const m = new Management();
    await run(m, cfg({ scopes: [SUB, mixed] }));
    expect(m.requests).toHaveLength(2); // one scope, two months (a first sync), never four
  });

  test("days the query does not return keep their stored lines", async () => {
    await run(new Management());
    const m2 = new Management();
    m2.answer = () => page([[3, 20261105, "S", "g", "USD"]]);
    await run(m2);
    expect(
      stored()
        .map((l) => l.chargeDay)
        .sort(),
    ).toEqual(["2026-11-03", "2026-11-05"]);
  });

  test("a redirect is refused and the token is never sent on", async () => {
    const m = new Management();
    const redirecting: AzureFetch = async (url, init) => {
      if (new URL(url).host === "management.azure.com") throw new RedirectRefusedError();
      return m.fetch(url, init);
    };
    const out = await createAzureBillingCostSyncable({
      azure: () => cfg(),
      now: () => NOW,
      fetch: redirecting,
    }).sync(ctx(), null);
    expect(decodeCostSyncCursor(PREFIX, out.cursor).gaps[ACCT]).toBe(AZURE_QUERY_GAPS.redirect);
  });
});

describe("helpers", () => {
  test("lastQueryDay, queryUrl, queryBody", () => {
    expect(lastQueryDay("2026-11", "2026-11-20")).toBe("2026-11-20");
    expect(lastQueryDay("2026-10", "2026-11-20")).toBe("2026-10-31");
    expect(lastQueryDay("2024-02", "2026-11-20")).toBe("2024-02-29");
    expect(queryUrl("a/b")).toBe(
      `https://management.azure.com/a/b/providers/Microsoft.CostManagement/query?api-version=${AZURE_QUERY_API_VERSION}`,
    );
    expect(JSON.stringify(queryBody("2026-10", "2026-10-31"))).toContain("2026-10-31T23:59:59Z");
  });

  test("readAzureQueryMonth passes an account gap through", async () => {
    const r = await readAzureQueryMonth(
      { post: async () => ({ kind: "gap", reason: "no" }) },
      "s",
      "2026-11",
      "2026-11-20",
    );
    expect(r).toEqual({ kind: "gap", reason: "no" });
  });
});
