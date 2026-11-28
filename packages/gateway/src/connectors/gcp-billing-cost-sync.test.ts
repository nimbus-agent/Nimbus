// The GCP billing sync over the REAL capabilities, store and index; only BigQuery (a fake REST endpoint) and the
// gcloud token are faked. The REST shapes follow Google's reference pages (see gcp-billing-query.ts), not a live table.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import { bqRow, FakeBigQuery } from "../../test/helpers/gcp-billing-fake.ts";
import { DEFAULT_COST_GCP_CONFIG, type NimbusCostGcpConfig } from "../config/cost-gcp-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { billingAccountOfTable, createGcpBillingCostSyncable } from "./gcp-billing-cost-sync.ts";
import { GCP_COST_GAPS } from "./gcp-billing-query.ts";
import { RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.gcp_billing;
const TABLE = "my-proj.billing.gcp_billing_export_resource_v1_01AB23_CD45EF_6789AB";
const ACCOUNT = "01AB23-CD45EF-6789AB";
const CFG: NimbusCostGcpConfig = { exportTables: [TABLE], maxBytesBilled: 53_687_091_200 };

let db: Database;
let vault: NimbusVault;
let bq: FakeBigQuery;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("gcp.auth_source", "gcloud");
  await vault.set("gcp.project_id", "run-proj");
  bq = new FakeBigQuery();
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "gcp_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "gcp_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      gcp_billing: { requestsPerMinute: 100000, burstSize: 1000 },
    }),
    depth: "full",
  } as SyncContext;
}

function run(
  cursor: string | null = null,
  over: {
    gcp?: () => NimbusCostGcpConfig | null;
    token?: string | null;
    fetch?: typeof bq.fetch;
    now?: number;
  } = {},
) {
  return createGcpBillingCostSyncable({
    gcp: over.gcp ?? (() => CFG),
    now: () => over.now ?? NOW,
    fetch: over.fetch ?? bq.fetch,
    mintAccessToken: async () => (over.token === undefined ? "tok" : over.token),
  }).sync(ctx(), cursor);
}

const cursorOf = (c: string | null) => decodeCostSyncCursor(PREFIX, c);
const lines = () => readCostLines(db, { fromDay: "2026-10-01", toDay: "2026-11-30" });
const total = () => lines().reduce((s, l) => s + l.billedCost, 0);

describe("gcp_billing sync", () => {
  test("writes the month: credits netted once, labels as tags, quantity and unit, one query shape", async () => {
    bq.rows.set("2026-11-01", [
      bqRow({
        cost: "10",
        credits: "-2.5",
        labels_json: '[{"key":"env","value":"prod"},{"key":"team","value":"web"}]',
      }),
      bqRow({ day: "2026-11-19", cost: "4", credits: "0", sku_id: "SKU-2", quantity: "3" }),
      bqRow({ cost_type: "tax", cost: "1", credits: null, quantity: null, unit: null }),
    ]);
    const out = await run();
    const l = lines();
    expect(l).toHaveLength(3);
    const first = l.find((x) => x.skuId === "SKU-1" && x.chargeCategory === "usage");
    expect(first).toMatchObject({
      source: "gcp_billing",
      provider: "gcp",
      billingAccountId: ACCOUNT,
      billingPeriod: "2026-11",
      subAccountId: "web-prod",
      subAccountName: "Web Production",
      serviceName: "Compute Engine",
      regionId: "us-central1",
      billedCost: 7.5,
      effectiveCost: 7.5,
      currency: "USD",
      consumedQuantity: 24,
      consumedUnit: "hour",
      tags: { env: "prod", team: "web" },
    });
    expect(l.find((x) => x.chargeCategory === "tax")).toMatchObject({
      billedCost: 1,
      consumedQuantity: null,
    });
    const c = cursorOf(out.cursor);
    expect(c.gaps).toEqual({});
    expect(c.pending).toEqual({});

    const q = bq.calls.find((x) => x.kind === "query" && x.url.includes("/projects/run-proj/"));
    const body = q?.body as Record<string, unknown>;
    const sql = String(body["query"]);
    expect(body["maximumBytesBilled"]).toBe("53687091200");
    expect(body["useLegacySql"]).toBe(false);
    expect(sql).toContain("UNNEST(IFNULL(labels, []))");
    expect(sql).toContain("UNNEST(IFNULL(credits, []))");
    expect(sql).toContain("_PARTITIONTIME >= TIMESTAMP_SUB(TIMESTAMP(@start), INTERVAL 1 DAY)");
    expect(sql).not.toContain("_PARTITIONTIME <");
    expect(sql).toContain(
      "FROM `my-proj.billing.gcp_billing_export_resource_v1_01AB23_CD45EF_6789AB`",
    );
    const params = body["queryParameters"] as { name: string; parameterValue: { value: string } }[];
    const byName = Object.fromEntries(params.map((p) => [p.name, p.parameterValue.value]));
    expect(byName).toEqual({ start: expect.any(String), end: expect.any(String) });
    // The current month ends tomorrow; a closed month ends at the next month's first day.
    const ends = bq.calls
      .filter((x) => x.kind === "query")
      .map((x) =>
        ((x.body?.["queryParameters"] ?? []) as { parameterValue: { value: string } }[]).map(
          (p) => p.parameterValue.value,
        ),
      );
    expect(ends).toContainEqual(["2026-11-01", "2026-11-21"]);
    expect(ends).toContainEqual(["2026-10-01", "2026-11-01"]);
  });

  test("pages follow their tokens, and an unfinished job is polled in its own project and location", async () => {
    bq.pageSize = 2;
    bq.incomplete = 2;
    bq.rows.set(
      "2026-11-01",
      Array.from({ length: 5 }, (_, i) => bqRow({ sku_id: `S${String(i)}`, cost: "1" })),
    );
    await run();
    expect(lines()).toHaveLength(5);
    expect(total()).toBe(5);
    const polls = bq.calls.filter((c) => c.kind === "poll");
    expect(polls.length).toBeGreaterThanOrEqual(4);
    expect(polls.every((p) => p.url.includes("/projects/job-proj/queries/job-1"))).toBe(true);
    expect(polls.every((p) => p.url.includes("location=EU"))).toBe(true);
  });

  test("a page token that does not advance, a row count that differs, or an endless job retries and writes nothing", async () => {
    bq.rows.set(
      "2026-11-01",
      Array.from({ length: 5 }, (_, i) => bqRow({ sku_id: `S${String(i)}` })),
    );
    bq.stuckToken = true;
    let out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");

    bq.stuckToken = false;
    bq.totalRows = "99";
    out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");

    bq.totalRows = null;
    bq.incomplete = 1000;
    out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");
  });

  test("the byte cap is a stated gap naming max_bytes_billed, and keeps what is stored", async () => {
    bq.rows.set("2026-11-01", [bqRow({ cost: "10" })]);
    await run();
    expect(total()).toBe(10);
    bq.failNext = {
      kind: "query",
      status: 400,
      body: {
        error: {
          errors: [{ reason: "bytesBilledLimitExceeded" }],
          message: "Query exceeded limit for bytes billed",
        },
      },
    };
    const out = await run(null);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("max_bytes_billed");
    expect(total()).toBe(10);
  });

  test("an empty result keeps a month that holds lines (month_gap); a month with none is simply empty", async () => {
    bq.rows.set("2026-11-01", [bqRow({ cost: "10" })]);
    const first = await run();
    expect(cursorOf(first.cursor).gaps).toEqual({});
    bq.rows.set("2026-11-01", []);
    const out = await run(first.cursor);
    expect(total()).toBe(10);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("already holds lines");
    expect(cursorOf(out.cursor).pending[TABLE]).toEqual(["2026-11"]);
    // October never had lines: empty is not a gap.
    expect(lines().filter((l) => l.billingPeriod === "2026-10")).toHaveLength(0);
  });

  test("an unreadable row, missing columns or a table not named after its account never write a guess", async () => {
    bq.rows.set("2026-11-01", [bqRow({ cost: "10" }), bqRow({ cost: "oops", sku_id: "S2" })]);
    let out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("could not be read");

    bq.rows.set("2026-11-01", [bqRow({ day: "2026-12-01" })]);
    out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("could not be read");

    bq.rows.set("2026-11-01", [bqRow()]);
    bq.dropColumn = "credits_sum";
    out = await run();
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("without the columns");

    bq.dropColumn = null;
    bq.rows.set("2026-11-01", []);
    const custom = "my-proj.billing.my_export_copy";
    out = await run(null, { gcp: () => ({ ...CFG, exportTables: [custom] }) });
    expect(cursorOf(out.cursor).gaps).toEqual({});
  });

  test("two billing accounts in one table are two accounts; one the result drops keeps its lines", async () => {
    bq.rows.set("2026-11-01", [
      bqRow({ cost: "10" }),
      bqRow({ billing_account_id: "BBBBBB-111111-222222", cost: "5", sku_id: "S9" }),
    ]);
    await run();
    expect(new Set(lines().map((l) => l.billingAccountId))).toEqual(
      new Set([ACCOUNT, "BBBBBB-111111-222222"]),
    );
    bq.rows.set("2026-11-01", [bqRow({ cost: "12" })]);
    await run();
    const byAccount = (a: string) =>
      lines()
        .filter((l) => l.billingAccountId === a)
        .reduce((s, l) => s + l.billedCost, 0);
    expect(byAccount(ACCOUNT)).toBe(12); // replaced whole, never added
    expect(byAccount("BBBBBB-111111-222222")).toBe(5);
  });

  test("a re-sync replaces the month (10 then 12 is 12)", async () => {
    bq.rows.set("2026-11-01", [bqRow({ cost: "10" })]);
    const c1 = await run();
    bq.rows.set("2026-11-01", [bqRow({ cost: "12" })]);
    await run(c1.cursor);
    expect(total()).toBe(12);
  });

  test("HTTP failures: 429 retries, 401/403 and 404 are stated gaps, 5xx retries, a refused redirect retries", async () => {
    bq.rows.set("2026-11-01", [bqRow()]);
    bq.failNext = { kind: "query", status: 429 };
    let out = await run();
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");
    expect(cursorOf(out.cursor).gaps).toEqual({});

    bq.failNext = {
      kind: "query",
      status: 403,
      body: { error: { errors: [{ reason: "accessDenied" }] } },
    };
    out = await run();
    expect(cursorOf(out.cursor).gaps[TABLE]).toBe(GCP_COST_GAPS.access);

    bq.failNext = { kind: "meta", status: 404 };
    out = await run();
    expect(cursorOf(out.cursor).gaps[TABLE]).toBe(GCP_COST_GAPS.notFound);

    bq.failNext = {
      kind: "query",
      status: 400,
      body: { error: { message: "Unrecognized name: credits" } },
    };
    out = await run();
    expect(cursorOf(out.cursor).gaps[TABLE]).toBe(GCP_COST_GAPS.refused);

    bq.failNext = { kind: "query", status: 503 };
    out = await run();
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");

    bq.failNext = {
      kind: "query",
      status: 403,
      body: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
    };
    out = await run();
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");

    bq.failNext = { kind: "poll", status: 500 };
    bq.incomplete = 1;
    out = await run();
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");

    const refused = (async () => {
      throw new RedirectRefusedError();
    }) as unknown as typeof bq.fetch;
    out = await run(null, { fetch: refused });
    expect(cursorOf(out.cursor).pending[TABLE]).toContain("2026-11");
    expect(lines()).toHaveLength(0);
  });

  test("the detailed table is the one read when two are named", async () => {
    const standard = "my-proj.billing.gcp_billing_export_v1_01AB23_CD45EF_6789AB";
    bq.rows.set("2026-11-01", [bqRow()]);
    await run(null, { gcp: () => ({ ...CFG, exportTables: [standard, TABLE] }) });
    const sql = String(bq.calls.find((c) => c.kind === "query")?.body?.["query"]);
    expect(sql).toContain(TABLE);
    expect(sql).not.toContain(standard);
  });

  test("states: no table is a stated gap, a null config keeps the cursor, missing credentials or token read nothing", async () => {
    let out = await run(null, { gcp: () => DEFAULT_COST_GCP_CONFIG });
    expect(cursorOf(out.cursor).gaps["gcp"]).toBe(GCP_COST_GAPS.notConfigured);

    const kept = `${PREFIX}${Buffer.from("x").toString("base64")}`;
    out = await run(kept, { gcp: () => null });
    expect(out.cursor).toBe(kept);
    out = await run(null, { gcp: () => null });
    expect(out.cursor).toStartWith(PREFIX);

    out = await run(null, { token: null });
    expect(bq.calls).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps).toEqual({});

    await vault.delete("gcp.project_id");
    out = await run();
    expect(cursorOf(out.cursor).gaps[TABLE]).toBe(GCP_COST_GAPS.noProject);

    await vault.delete("gcp.auth_source");
    out = await run();
    expect(bq.calls).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps).toEqual({});
  });

  test("an endless job is cancelled in its own project and location", async () => {
    bq.rows.set("2026-11-01", [bqRow()]);
    bq.incomplete = 1000;
    const out = await run();
    const cancels = bq.calls.filter((c) => c.kind === "cancel");
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    expect(cancels[0]?.url).toContain("/projects/job-proj/jobs/job-1/cancel?location=EU");
    expect(lines()).toHaveLength(0);
    expect(cursorOf(out.cursor).gaps[TABLE]).toContain("billed BigQuery scan");
  });

  test("a 404 while polling is a retry (an expired job), not a missing table", async () => {
    bq.rows.set("2026-11-01", [bqRow()]);
    bq.incomplete = 1;
    bq.failNext = { kind: "poll", status: 404 };
    const out = await run();
    expect(lines()).toHaveLength(0);
    const c = cursorOf(out.cursor);
    expect(c.gaps[TABLE] ?? "").not.toBe(GCP_COST_GAPS.notFound);
    expect(c.pending[TABLE]).toContain("2026-11");
  });

  test("a month that cannot finish is scanned once, then again only after 7 days (a past month)", async () => {
    // October is over the page cap (42 pages of 1 row); November is fine.
    bq.pageSize = 1;
    bq.rows.set(
      "2026-10-01",
      Array.from({ length: 42 }, (_, i) => bqRow({ day: "2026-10-05", sku_id: `S${String(i)}` })),
    );
    bq.rows.set("2026-11-01", [bqRow()]);
    const scans = (start: string) =>
      bq.calls.filter((c) => c.kind === "query" && JSON.stringify(c.body).includes(`"${start}"`))
        .length;
    let cursor: string | null = null;
    for (let d = 0; d < 7; d++) {
      const out = await run(cursor, { now: NOW + d * DAY });
      cursor = out.cursor;
    }
    // Day 0 scanned October; days 1 to 6 did not.
    expect(scans("2026-10-01")).toBe(1);
    const c = cursorOf(cursor);
    expect(c.failedScan?.[TABLE]?.["2026-10"]).toBe("2026-11-20");
    expect(c.gaps[TABLE]).toContain("2026-10");
    // Day 7 scans it again.
    await run(cursor, { now: NOW + 7 * DAY });
    expect(scans("2026-10-01")).toBe(2);
  });

  test("a failed current month is scanned at most once a day, and a success clears the record", async () => {
    bq.pageSize = 1;
    bq.rows.set(
      "2026-11-01",
      Array.from({ length: 42 }, (_, i) => bqRow({ sku_id: `S${String(i)}` })),
    );
    const scans = () => bq.calls.filter((c) => c.kind === "query").length;
    let out = await run(null, { now: NOW });
    const first = scans();
    out = await run(out.cursor, { now: NOW + 3_600_000 });
    expect(scans()).toBe(first); // the same day: no second scan
    out = await run(out.cursor, { now: NOW + DAY });
    expect(scans()).toBeGreaterThan(first); // the next day: one more
    bq.pageSize = 100;
    out = await run(out.cursor, { now: NOW + 2 * DAY });
    expect(total()).toBeGreaterThan(0);
    expect(cursorOf(out.cursor).failedScan?.[TABLE]?.["2026-11"]).toBeUndefined();
  });

  test("the billing account a table name carries", () => {
    expect(billingAccountOfTable(TABLE)).toBe(ACCOUNT);
    expect(billingAccountOfTable("p.d.gcp_billing_export_v1_01AB23_CD45EF_6789AB")).toBe(ACCOUNT);
    expect(billingAccountOfTable("p.d.my_copy")).toBeNull();
  });
});
