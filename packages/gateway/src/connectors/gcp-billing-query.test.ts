import { describe, expect, test } from "bun:test";
import pino from "pino";

import { bqRow, FakeBigQuery } from "../../test/helpers/gcp-billing-fake.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  billingSql,
  GCP_QUERY_MAX_PAGES,
  partitionOf,
  readTablePartition,
  runBillingQuery,
} from "./gcp-billing-query.ts";

const ctx = {
  logger: pino({ level: "silent" }),
  rateLimiter: new ProviderRateLimiter({
    gcp_billing: { requestsPerMinute: 100000, burstSize: 1000 },
  }),
} as unknown as SyncContext;
const TABLE = "p.d.gcp_billing_export_v1_A_B_C";

describe("partition filter", () => {
  test("ingestion time, a TIMESTAMP column, a DATE column, or none", () => {
    expect(partitionOf({ timePartitioning: { type: "DAY" } })).toEqual({ kind: "ingestion" });
    const schema = (type: string) => ({ schema: { fields: [{ name: "export_time", type }] } });
    expect(
      partitionOf({
        timePartitioning: { type: "DAY", field: "export_time" },
        ...schema("TIMESTAMP"),
      }),
    ).toEqual({ kind: "column", name: "export_time", type: "TIMESTAMP" });
    expect(
      partitionOf({ timePartitioning: { type: "DAY", field: "export_time" }, ...schema("DATE") }),
    ).toEqual({ kind: "column", name: "export_time", type: "DATE" });
    expect(
      partitionOf({
        timePartitioning: { type: "DAY", field: "export_time" },
        ...schema("DATETIME"),
      }),
    ).toEqual({ kind: "none" });
    expect(partitionOf({ timePartitioning: { type: "DAY", field: "x`y" } })).toEqual({
      kind: "none",
    });
    expect(partitionOf({ timePartitioning: { type: "DAY", field: "gone" } })).toEqual({
      kind: "none",
    });
    expect(partitionOf({ rangePartitioning: {} })).toEqual({ kind: "none" });
  });

  test("each scheme bounds the SQL by its own column, with the 3-day buffer; none adds nothing", () => {
    expect(billingSql(TABLE, { kind: "ingestion" })).toContain(
      "_PARTITIONTIME >= TIMESTAMP(@start)",
    );
    const ts = billingSql(TABLE, { kind: "column", name: "export_time", type: "TIMESTAMP" });
    expect(ts).toContain("`export_time` >= TIMESTAMP(@start)");
    expect(ts).toContain("TIMESTAMP_ADD(TIMESTAMP(@end), INTERVAL 3 DAY)");
    const d = billingSql(TABLE, { kind: "column", name: "pd", type: "DATE" });
    expect(d).toContain("`pd` >= DATE(@start) AND `pd` < DATE_ADD(DATE(@end), INTERVAL 3 DAY)");
    const none = billingSql(TABLE, { kind: "none" });
    expect(none).not.toContain("_PARTITIONTIME");
    expect(none).toContain("usage_start_time >= TIMESTAMP(@start)");
  });

  test("the table's metadata is read, and a failure is its outcome", async () => {
    const bq = new FakeBigQuery();
    bq.meta = { timePartitioning: { type: "DAY" } };
    const deps = { fetch: bq.fetch, token: "t" };
    expect(await readTablePartition(ctx, deps, TABLE)).toEqual({
      kind: "ok",
      partition: { kind: "ingestion" },
    });
    bq.failNext = { kind: "meta", status: 404 };
    expect((await readTablePartition(ctx, deps, TABLE)).kind).toBe("gap");
  });
});

describe("runBillingQuery", () => {
  const args = {
    project: "run",
    table: TABLE,
    partition: { kind: "ingestion" } as const,
    start: "2026-11-01",
    end: "2026-12-01",
    maxBytesBilled: 1_073_741_824,
  };

  test("a result longer than the page cap is a month_gap, not a partial", async () => {
    const bq = new FakeBigQuery();
    bq.pageSize = 1;
    bq.rows.set(
      "2026-11-01",
      Array.from({ length: GCP_QUERY_MAX_PAGES + 2 }, (_, i) => bqRow({ sku_id: `S${String(i)}` })),
    );
    const r = await runBillingQuery(ctx, { fetch: bq.fetch, token: "t" }, args);
    expect(r.kind).toBe("month_gap");
  });

  test("a reply that is not a job, or a cell that is not text, is a retry or a month_gap", async () => {
    const odd = (async () =>
      new Response("[]", { status: 200 })) as unknown as FakeBigQuery["fetch"];
    expect((await runBillingQuery(ctx, { fetch: odd, token: "t" }, args)).kind).toBe("retry");
    const noJob = (async () =>
      new Response(JSON.stringify({ jobComplete: true }), {
        status: 200,
      })) as unknown as FakeBigQuery["fetch"];
    expect((await runBillingQuery(ctx, { fetch: noJob, token: "t" }, args)).kind).toBe("retry");
    const html = (async () =>
      new Response("<html>", { status: 200 })) as unknown as FakeBigQuery["fetch"];
    expect((await runBillingQuery(ctx, { fetch: html, token: "t" }, args)).kind).toBe("retry");

    const cells = (rows: unknown) =>
      (async () =>
        new Response(
          JSON.stringify({
            jobComplete: true,
            jobReference: { projectId: "run", jobId: "j" },
            schema: {
              fields: [
                "day",
                "billing_account_id",
                "project_id",
                "project_name",
                "service",
                "sku_id",
                "sku",
                "region",
                "currency",
                "unit",
                "cost_type",
                "labels_json",
                "cost",
                "credits",
                "quantity",
              ].map((name) => ({ name })),
            },
            rows,
          }),
          { status: 200 },
        )) as unknown as FakeBigQuery["fetch"];
    const nested = [{ f: Array.from({ length: 15 }, () => ({ v: { f: [] } })) }];
    expect((await runBillingQuery(ctx, { fetch: cells(nested), token: "t" }, args)).kind).toBe(
      "month_gap",
    );
    const short = [{ f: [{ v: "x" }] }];
    expect((await runBillingQuery(ctx, { fetch: cells(short), token: "t" }, args)).kind).toBe(
      "month_gap",
    );
  });
});
