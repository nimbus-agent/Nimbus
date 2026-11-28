// The AWS export sync over the REAL capabilities, store and index; only the AWS CLI is faked (an in-memory bucket).
// The manifest and key layout follow AWS's Data Exports documentation (see aws-billing-export.ts), not a live bucket.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAwsConfig } from "../config/cost-aws-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createAwsBillingCostSyncable } from "./aws-billing-cost-sync.ts";
import { AWS_COST_GAPS, type AwsBillingCli, readExportMonth } from "./aws-billing-export.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.aws_billing;
const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
const EXPORT = "focus/prod/daily";

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("aws.access_key_id", "AKIAEXAMPLE");
  await vault.set("aws.secret_access_key", "secret");
  await vault.set("aws.default_region", "us-east-1");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "aws_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "aws_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
}

/** A row of the export: account, cost, day (November 2026). */
const row = (acct: string, cost: number, day: number, svc = "Amazon S3") =>
  `${acct},${String(cost)},USD,2026-11-${String(day).padStart(2, "0")}T00:00:00Z,${svc},2026-11-01T00:00:00Z`;
const csv = (...rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;
const gz = (text: string) => Bun.gzipSync(new TextEncoder().encode(text));

type Obj = { bytes: Uint8Array; lastModified: string };
class Bucket {
  readonly objects = new Map<string, Obj>();
  readonly downloads: string[] = [];
  readonly listCalls: { prefix: string; token: string | null }[] = [];
  pageSize = 1000;
  failDownload = new Set<string>();
  put(key: string, bytes: Uint8Array | string, lastModified = "2026-11-19T00:00:00+00:00"): void {
    this.objects.set(key, {
      bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      lastModified,
    });
  }
  /** One delivery: the data chunks and the manifest naming them, for `month`. */
  deliver(
    month: string,
    chunks: Uint8Array[],
    lastModified: string,
    ext = "csv.gz",
    manifestKey = `${EXPORT}/metadata/BILLING_PERIOD=${month}/daily-Manifest.json`,
  ): void {
    const files = chunks.map((c, i) => {
      const key = `${EXPORT}/data/BILLING_PERIOD=${month}/daily-0000${String(i + 1)}.${ext}`;
      this.put(key, c, lastModified);
      return `s3://acme-cost/${key}`;
    });
    this.put(manifestKey, JSON.stringify({ executionId: "e", dataFiles: files }), lastModified);
  }
  /** Fields are returned only when the request asks for them, like the real CLI. */
  cli(): AwsBillingCli {
    return {
      list: async (bucket, prefix, token) => {
        this.listCalls.push({ prefix, token });
        if (bucket !== "acme-cost") return { ok: false, text: "" };
        const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = token === null ? 0 : Number(token);
        const page = all.slice(start, start + this.pageSize);
        const body: Record<string, unknown> = {
          Contents: page.map((Key) => ({ Key, LastModified: this.objects.get(Key)?.lastModified })),
        };
        if (start + this.pageSize < all.length) body["NextToken"] = String(start + this.pageSize);
        return { ok: true, text: JSON.stringify(body) };
      },
      download: async (url) => {
        const key = url.replace("s3://acme-cost/", "");
        this.downloads.push(key);
        const o = this.objects.get(key);
        if (o === undefined || this.failDownload.has(key) || !url.startsWith("s3://acme-cost/")) {
          return { ok: false };
        }
        return { ok: true, bytes: o.bytes };
      },
    };
  }
}

const cfg = (over: Partial<NimbusCostAwsConfig> = {}): NimbusCostAwsConfig => ({
  export: { bucket: "acme-cost", prefix: "focus/prod" },
  costExplorer: false,
  ...over,
});

async function run(
  bucket: Bucket,
  config: NimbusCostAwsConfig | null,
  cursor: string | null = null,
  now = NOW,
) {
  const out = await createAwsBillingCostSyncable({
    aws: () => config,
    now: () => now,
    cli: bucket.cli(),
  }).sync(ctx(), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor) };
}

const stored = (month = "2026-11") =>
  readCostLines(db, { fromDay: `${month}-01`, toDay: `${month}-31` }).filter(
    (l) => l.source === "aws_billing",
  );
const total = (acct: string) =>
  stored()
    .filter((l) => l.billingAccountId === acct)
    .reduce((a, l) => a + l.billedCost, 0);

describe("aws_billing: the export path", () => {
  test("a two-file gzipped export becomes lines per billing account, re-sourced to aws_billing", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 10, 1), row("222", 5, 1))), gz(csv(row("111", 2, 2)))],
      "2026-11-19T10:00:00+00:00",
    );
    const { out, cursor } = await run(b, cfg());
    expect(out.itemsUpserted).toBe(3);
    expect(total("111")).toBe(12);
    expect(total("222")).toBe(5);
    expect(new Set(stored().map((l) => l.provider))).toEqual(new Set(["aws"]));
    expect(cursor.gaps).toEqual({});
    expect(cursor.synced["s3://acme-cost/focus/prod"]).toBe("2026-11-20");
    expect(b.listCalls[0]?.prefix).toBe("focus/prod/");
  });

  test("a newer manifest replaces only the days its files cover; other days and other accounts stay", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 10, 1), row("111", 20, 2), row("222", 5, 2)))],
      "2026-11-19T10:00:00+00:00",
    );
    await run(b, cfg());
    const next = new Bucket();
    // a restated day 2 for account 111 only
    next.deliver("2026-11", [gz(csv(row("111", 99, 2)))], "2026-11-20T08:00:00+00:00");
    const { cursor } = await run(next, cfg());
    expect(cursor.gaps).toEqual({});
    const day = (acct: string, d: string) =>
      stored()
        .filter((l) => l.billingAccountId === acct && l.chargeDay === d)
        .reduce((a, l) => a + l.billedCost, 0);
    expect(day("111", "2026-11-01")).toBe(10); // not covered: kept
    expect(day("111", "2026-11-02")).toBe(99); // covered: replaced
    expect(day("222", "2026-11-02")).toBe(5); // another account: untouched
  });

  test("of two manifests the newest is read (create-new mode keeps every run)", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 1, 1)))],
      "2026-11-18T00:00:00+00:00",
      "csv.gz",
      `${EXPORT}/metadata/BILLING_PERIOD=2026-11/run1/daily-Manifest.json`,
    );
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 7, 1)))],
      "2026-11-19T00:00:00+00:00",
      "csv.gz",
      `${EXPORT}/metadata/BILLING_PERIOD=2026-11/daily-Manifest.json`,
    );
    await run(b, cfg());
    expect(total("111")).toBe(7);
  });

  test("a period with an unreadable file is a month_gap: nothing is written and the stored month stays", async () => {
    const good = new Bucket();
    good.deliver("2026-11", [gz(csv(row("111", 10, 1)))], "2026-11-19T00:00:00+00:00");
    await run(good, cfg());
    const bad = new Bucket();
    bad.deliver(
      "2026-11",
      [gz(csv(row("111", 55, 1))), gz(csv(row("111", 1, 2)))],
      "2026-11-20T00:00:00+00:00",
    );
    bad.failDownload.add(`${EXPORT}/data/BILLING_PERIOD=2026-11/daily-00002.csv.gz`);
    const { cursor } = await run(bad, cfg());
    expect(total("111")).toBe(10);
    expect(cursor.gaps["s3://acme-cost/focus/prod"]).toContain("could not be read");
    expect(cursor.pending["s3://acme-cost/focus/prod"]).toEqual(["2026-11"]);
  });

  test("rows that cannot be read make the month a gap, not a lower month", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [
        gz(
          csv(
            row("111", 10, 1),
            "111,not-a-number,USD,2026-11-02T00:00:00Z,S3,2026-11-01T00:00:00Z",
          ),
        ),
      ],
      "2026-11-19T00:00:00+00:00",
    );
    const { cursor } = await run(b, cfg());
    expect(stored()).toHaveLength(0);
    expect(Object.values(cursor.gaps)[0]).toContain("1 rows");
  });

  test("empty surplus chunks are skipped; an export of only empty files never clears a month", async () => {
    const b = new Bucket();
    b.deliver("2026-11", [gz(csv(row("111", 10, 1))), gz("")], "2026-11-19T00:00:00+00:00");
    await run(b, cfg());
    expect(total("111")).toBe(10);
    const empty = new Bucket();
    empty.deliver("2026-11", [gz(""), gz(csv())], "2026-11-20T00:00:00+00:00");
    const { cursor } = await run(empty, cfg());
    expect(total("111")).toBe(10);
    expect(Object.values(cursor.gaps)[0]).toContain("no rows");
  });

  test("a Parquet export is a stated gap and nothing is downloaded but the manifest", async () => {
    const b = new Bucket();
    b.deliver("2026-11", [new Uint8Array([1])], "2026-11-19T00:00:00+00:00", "snappy.parquet");
    const { cursor } = await run(b, cfg());
    expect(Object.values(cursor.gaps)).toEqual([AWS_COST_GAPS.parquet]);
    expect(b.downloads.filter((k) => k.includes("/data/"))).toEqual([]);
  });

  test("a manifest that names a file outside the configured prefix is refused without reading it", async () => {
    const b = new Bucket();
    b.put(
      `${EXPORT}/metadata/BILLING_PERIOD=2026-11/daily-Manifest.json`,
      JSON.stringify({
        dataFiles: ["s3://other-bucket/x.csv.gz", "s3://acme-cost/elsewhere/x.csv.gz"],
      }),
    );
    const { cursor } = await run(b, cfg());
    expect(Object.values(cursor.gaps)[0]).toContain("outside");
    expect(b.downloads).toEqual([`${EXPORT}/metadata/BILLING_PERIOD=2026-11/daily-Manifest.json`]);
  });

  test("a header that differs between chunks, or a period outside the folder, is a gap", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 1, 1))), gz("BillingAccountId,BilledCost\n111,1\n")],
      "2026-11-19T00:00:00+00:00",
    );
    expect(Object.values((await run(b, cfg())).cursor.gaps)[0]).toContain("different headers");
    const c = new Bucket();
    c.deliver(
      "2026-11",
      [gz(`${HEADER}\n111,1,USD,2026-10-30T00:00:00Z,S3,2026-10-01T00:00:00Z\n`)],
      "2026-11-19T00:00:00+00:00",
    );
    expect(Object.values((await run(c, cfg())).cursor.gaps)[0]).toContain("outside the period");
    expect(stored()).toHaveLength(0);
  });

  test("listing: pages are followed, a token that does not advance and a listing failure are gaps", async () => {
    const b = new Bucket();
    b.pageSize = 2;
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 4, 1))), gz(csv(row("111", 6, 2)))],
      "2026-11-19T00:00:00+00:00",
    );
    await run(b, cfg());
    expect(b.listCalls.length).toBeGreaterThan(1);
    expect(total("111")).toBe(10);
    const stuck: AwsBillingCli = {
      list: async () => ({ ok: true, text: JSON.stringify({ Contents: [], NextToken: "same" }) }),
      download: async () => ({ ok: false }),
    };
    const out = await createAwsBillingCostSyncable({
      aws: () => cfg(),
      now: () => NOW,
      cli: stuck,
    }).sync(ctx(), null);
    expect(Object.values(decodeCostSyncCursor(PREFIX, out.cursor).gaps)).toEqual([
      AWS_COST_GAPS.list,
    ]);
    const failing: AwsBillingCli = {
      list: async () => ({ ok: false, text: "" }),
      download: async () => ({ ok: false }),
    };
    const out2 = await createAwsBillingCostSyncable({
      aws: () => cfg(),
      now: () => NOW,
      cli: failing,
    }).sync(ctx(), null);
    expect(Object.values(decodeCostSyncCursor(PREFIX, out2.cursor).gaps)).toEqual([
      AWS_COST_GAPS.list,
    ]);
  });

  test("an empty prefix and a prefix with two exports are stated gaps", async () => {
    const none = await run(new Bucket(), cfg());
    expect(Object.values(none.cursor.gaps)).toEqual([AWS_COST_GAPS.empty]);
    const two = new Bucket();
    two.deliver("2026-11", [gz(csv(row("111", 1, 1)))], "2026-11-19T00:00:00+00:00");
    two.put("focus/prod/other/metadata/BILLING_PERIOD=2026-11/other-Manifest.json", "{}");
    const r = await run(two, cfg({ export: { bucket: "acme-cost", prefix: "focus/prod" } }));
    expect(Object.values(r.cursor.gaps)).toEqual([AWS_COST_GAPS.severalExports]);
    expect(stored()).toHaveLength(0);
  });

  test("a late credit dated in the previous month is written with its period, not retried forever", async () => {
    const b = new Bucket();
    const late = "111,-3,USD,2026-10-31T00:00:00Z,Amazon S3,2026-11-01T00:00:00Z";
    b.deliver("2026-11", [gz(csv(row("111", 10, 1), late))], "2026-11-19T00:00:00+00:00");
    const { cursor } = await run(b, cfg());
    expect(cursor.gaps).toEqual({});
    expect(cursor.pending).toEqual({});
    const all = readCostLines(db, { fromDay: "2026-10-01", toDay: "2026-11-30" }).filter(
      (l) => l.source === "aws_billing" && l.billingPeriod === "2026-11",
    );
    expect(all.map((l) => [l.chargeDay, l.billedCost]).sort()).toEqual([
      ["2026-10-31", -3],
      ["2026-11-01", 10],
    ]);
  });

  test("a row dated after today is a month_gap with a reason, not a retry", async () => {
    const b = new Bucket();
    const future = "111,5,USD,2026-11-25T00:00:00Z,Amazon S3,2026-11-01T00:00:00Z";
    b.deliver("2026-11", [gz(csv(row("111", 10, 1), future))], "2026-11-19T00:00:00+00:00");
    const { cursor } = await run(b, cfg());
    expect(stored()).toHaveLength(0);
    expect(Object.values(cursor.gaps)[0]).toContain("dated after today");
  });

  test("a zero-byte gz chunk is skipped like any empty chunk", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 10, 1))), new Uint8Array(0)],
      "2026-11-19T00:00:00+00:00",
    );
    await run(b, cfg());
    expect(total("111")).toBe(10);
  });

  test("the decoded text of a period is capped: past the cap it is a month_gap", async () => {
    const b = new Bucket();
    b.deliver(
      "2026-11",
      [gz(csv(row("111", 10, 1))), gz(csv(row("111", 1, 2)))],
      "2026-11-19T00:00:00+00:00",
    );
    const ref = {
      key: `${EXPORT}/metadata/BILLING_PERIOD=2026-11/daily-Manifest.json`,
      lastModified: 0,
    };
    const r = await readExportMonth(b.cli(), "acme-cost", "focus/prod", ref, "2026-11", 150);
    expect(r).toMatchObject({ kind: "month_gap" });
    expect(JSON.stringify(r)).toContain("decoded-text cap");
    expect(
      Array.isArray(await readExportMonth(b.cli(), "acme-cost", "focus/prod", ref, "2026-11")),
    ).toBe(true);
  });

  test("a re-sync of the same export changes nothing", async () => {
    const b = new Bucket();
    b.deliver("2026-11", [gz(csv(row("111", 10, 1)))], "2026-11-19T00:00:00+00:00");
    const first = await run(b, cfg());
    const before = JSON.stringify(stored());
    await run(b, cfg(), first.out.cursor);
    expect(JSON.stringify(stored())).toBe(before);
  });
});

describe("aws_billing: configuration", () => {
  test("no export and no Cost Explorer: the stated gap; an unreadable config keeps the cursor", async () => {
    const b = new Bucket();
    const r = await run(b, cfg({ export: null }));
    expect(r.cursor.gaps).toEqual({ aws: AWS_COST_GAPS.notConfigured });
    expect(b.listCalls).toHaveLength(0);
    const ce = await run(b, cfg({ export: null, costExplorer: true }));
    expect(ce.cursor.gaps["aws"]).toBe(AWS_COST_GAPS.costExplorerOnly);
    const kept = await run(b, null, r.out.cursor);
    expect(kept.out.cursor).toBe(r.out.cursor);
    expect((await run(b, null, null)).out.cursor?.startsWith(PREFIX)).toBe(true);
  });

  test("no usable AWS credentials: nothing is listed and the earlier gap is kept", async () => {
    await vault.delete("aws.access_key_id");
    const b = new Bucket();
    const r = await run(b, cfg());
    expect(b.listCalls).toHaveLength(0);
    expect(r.cursor.gaps).toEqual({});
  });
});
