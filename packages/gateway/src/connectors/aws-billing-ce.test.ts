// The AWS Cost Explorer fallback (slice 11b) over the REAL capabilities, store and index; only the AWS CLI is faked.
// Cost Explorer is billed per request, so the first test proves it is never called unless it is the configured source.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostAwsConfig } from "../config/cost-aws-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createAwsBillingCostSyncable } from "./aws-billing-cost-sync.ts";
import type { AwsBillingCli } from "./aws-billing-export.ts";
import {
  AWS_CE_GAPS,
  AWS_CE_MAX_PAGES,
  type AwsCeCli,
  awsCeCli,
  ceTimePeriod,
} from "./aws-cost-explorer.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.aws_billing;
const PAYER = "111111111111";

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

const logs: { obj: Record<string, unknown>; msg: string }[] = [];
function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "aws_billing", DAY, Date.now(), false);
  const logger = pino({ level: "silent" });
  logger.info = ((obj: Record<string, unknown>, msg: string) => {
    logs.push({ obj, msg });
  }) as typeof logger.info;
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "aws_billing"),
    logger,
    rateLimiter: { acquire: async () => {} } as unknown as ProviderRateLimiter,
    depth: "full",
  } as SyncContext;
}

const metrics = (u: string, a = u) => ({
  UnblendedCost: { Amount: u, Unit: "USD" },
  AmortizedCost: { Amount: a, Unit: "USD" },
  UsageQuantity: { Amount: "9", Unit: "Hrs" },
});
const result = (d: string, svc: string, acct: string, cost: string, estimated = false) => ({
  TimePeriod: { Start: d, End: d },
  Estimated: estimated,
  Groups: [{ Keys: [svc, acct], Metrics: metrics(cost) }],
});

class FakeCe implements AwsCeCli {
  readonly calls: string[][] = [];
  org: "ok" | "denied" = "denied";
  sts: "ok" | "fail" = "ok";
  ceFails = false;
  /** month (YYYY-MM) -> pages */
  pages = new Map<string, unknown[][]>();
  endless = false;
  async run(args: string[]): Promise<{ ok: boolean; text: string }> {
    this.calls.push(args);
    if (args[0] === "organizations") {
      return this.org === "ok"
        ? {
            ok: true,
            text: JSON.stringify({ Organization: { ManagementAccountId: "999999999999" } }),
          }
        : { ok: false, text: "" };
    }
    if (args[0] === "sts") {
      return this.sts === "ok"
        ? { ok: true, text: JSON.stringify({ Account: PAYER }) }
        : { ok: false, text: "" };
    }
    if (this.ceFails) return { ok: false, text: "" };
    const period = args[args.indexOf("--time-period") + 1] ?? "";
    const month = period.slice("Start=".length, "Start=".length + 7);
    const tokenAt = args.indexOf("--next-page-token");
    const idx = tokenAt === -1 ? 0 : Number(args[tokenAt + 1]);
    const pages = this.pages.get(month) ?? [[]];
    const body: Record<string, unknown> = { ResultsByTime: this.endless ? [] : (pages[idx] ?? []) };
    if (this.endless || idx + 1 < pages.length) body["NextPageToken"] = String(idx + 1);
    return { ok: true, text: JSON.stringify(body) };
  }
  get ceCalls(): string[][] {
    return this.calls.filter((c) => c[0] === "ce");
  }
}

const noExportCli: AwsBillingCli = {
  list: async () => ({ ok: false, text: "" }),
  download: async () => ({ ok: false }),
};
const cfg = (over: Partial<NimbusCostAwsConfig> = {}): NimbusCostAwsConfig => ({
  export: null,
  costExplorer: true,
  ...over,
});

async function run(ce: FakeCe, config: NimbusCostAwsConfig | null, cursor: string | null = null) {
  const out = await createAwsBillingCostSyncable({
    aws: () => config,
    now: () => NOW,
    cli: noExportCli,
    ce,
  }).sync(ctx(), cursor);
  return { out, cursor: decodeCostSyncCursor(PREFIX, out.cursor) };
}
const stored = (month = "2026-11") =>
  readCostLines(db, { fromDay: `${month}-01`, toDay: `${month}-31` }).filter(
    (l) => l.source === "aws_billing",
  );
const CE_KEY = "aws-cost-explorer";

describe("aws_billing: Cost Explorer is opt-in", () => {
  test("it is never called by default: not configured, an export set, or an unreadable config", async () => {
    const ce = new FakeCe();
    await run(ce, cfg({ costExplorer: false }));
    await run(ce, cfg({ export: { bucket: "acme-cost", prefix: "focus" } }));
    await run(ce, null);
    expect(ce.calls).toEqual([]);
  });

  test("no export and no cost_explorer: the stated gap", async () => {
    const r = await run(new FakeCe(), cfg({ costExplorer: false }));
    expect(r.cursor.gaps["aws"]).toContain("[cost.aws] export, or cost_explorer = true");
  });
});

describe("aws_billing: the Cost Explorer path", () => {
  test("daily lines by service and linked account, billed from Unblended, no quantity; requests logged", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [[result("2026-11-02", "Amazon S3", "222222222222", "4.5")]]);
    ce.pages.set("2026-10", [[result("2026-10-05", "Amazon EC2", "222222222222", "7")]]);
    logs.length = 0;
    const r = await run(ce, cfg());
    expect(r.out.itemsUpserted).toBe(2);
    const nov = stored();
    expect(nov).toHaveLength(1);
    expect(nov[0]).toMatchObject({
      billingAccountId: PAYER,
      subAccountId: "222222222222",
      serviceName: "Amazon S3",
      billedCost: 4.5,
    });
    expect(nov[0]?.consumedQuantity ?? null).toBeNull();
    const first = ce.ceCalls[0] ?? [];
    expect(first).toContain("--granularity");
    expect(first.slice(first.indexOf("--metrics") + 1, first.indexOf("--metrics") + 4)).toEqual([
      "UnblendedCost",
      "AmortizedCost",
      "UsageQuantity",
    ]);
    expect(first).toContain("Start=2026-11-01,End=2026-11-21");
    expect(r.cursor.gaps).toEqual({});
    expect(r.cursor.synced[CE_KEY]).toBe("2026-11-20");
    expect(logs.find((l) => l.msg.includes("Cost Explorer requests"))?.obj["ceRequests"]).toBe(2);
  });

  test("the payer is the Organizations management account when readable, else the caller's account", async () => {
    const org = new FakeCe();
    org.org = "ok";
    org.pages.set("2026-11", [[result("2026-11-02", "S3", "222222222222", "1")]]);
    await run(org, cfg());
    expect(stored()[0]?.billingAccountId).toBe("999999999999");
    expect(org.calls.some((c) => c[0] === "sts")).toBe(false);
  });

  test("no account id: an account gap and no Cost Explorer request", async () => {
    const ce = new FakeCe();
    ce.sts = "fail";
    const r = await run(ce, cfg());
    expect(r.cursor.gaps[CE_KEY]).toBe(AWS_CE_GAPS.account);
    expect(ce.ceCalls).toHaveLength(0);
  });

  test("a failed Cost Explorer call is an account gap and writes nothing", async () => {
    const ce = new FakeCe();
    ce.ceFails = true;
    const r = await run(ce, cfg());
    expect(r.cursor.gaps[CE_KEY]).toBe(AWS_CE_GAPS.read);
    expect(stored()).toHaveLength(0);
  });

  test("paging follows the token; the cap is a month_gap with nothing written", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [
      [result("2026-11-02", "S3", "222222222222", "1")],
      [result("2026-11-03", "S3", "222222222222", "2")],
    ]);
    ce.pages.set("2026-10", [[]]);
    await run(ce, cfg());
    expect(stored().map((l) => l.billedCost)).toEqual([1, 2]);

    const endless = new FakeCe();
    endless.endless = true;
    const r = await run(endless, cfg());
    // 10 requests for the current month, then 10 for the previous one: each month is bounded on its own.
    expect(endless.ceCalls).toHaveLength(2 * AWS_CE_MAX_PAGES);
    expect(r.cursor.gaps[CE_KEY]).toContain("needs more than 10 requests");
    expect(r.cursor.pending[CE_KEY]).toEqual(["2026-11", "2026-10"]);
    expect(stored()).toHaveLength(2); // the earlier run's lines are untouched
  });

  test("an Estimated month is written and stays pending, with no gap", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [[result("2026-11-19", "S3", "222222222222", "3", true)]]);
    ce.pages.set("2026-10", [[result("2026-10-02", "S3", "222222222222", "5", false)]]);
    const r = await run(ce, cfg());
    expect(stored()).toHaveLength(1);
    expect(r.cursor.pending[CE_KEY]).toEqual(["2026-11"]);
    expect(r.cursor.gaps).toEqual({});
  });

  test("an answer with no cost never clears a month that holds lines; an empty month stays empty", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [[result("2026-11-02", "S3", "222222222222", "4")]]);
    await run(ce, cfg());
    const empty = new FakeCe();
    empty.pages.set("2026-11", [[]]);
    const r = await run(empty, cfg());
    expect(stored()).toHaveLength(1);
    expect(r.cursor.gaps[CE_KEY]).toContain("returned no cost");
    db.exec("DELETE FROM cost_line");
    const fresh = new FakeCe();
    expect((await run(fresh, cfg())).cursor.gaps).toEqual({});
  });

  test("an unreadable group is a month_gap, nothing written", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [
      [
        {
          TimePeriod: { Start: "2026-11-02", End: "2026-11-02" },
          Groups: [{ Keys: ["S3", "2"], Metrics: metrics("x") }],
        },
      ],
    ]);
    const r = await run(ce, cfg());
    expect(stored()).toHaveLength(0);
    expect(r.cursor.gaps[CE_KEY]).toContain("could not be read");
  });

  test("a later switch to an export replaces the same tuple on the days the export covers", async () => {
    const ce = new FakeCe();
    ce.pages.set("2026-11", [
      [
        result("2026-11-02", "Amazon S3", "222222222222", "4"),
        result("2026-11-03", "Amazon S3", "222222222222", "6"),
      ],
    ]);
    await run(ce, cfg());
    expect(stored()).toHaveLength(2);

    const header =
      "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
    const csv = `${header}\n${PAYER},10,USD,2026-11-02T00:00:00Z,Amazon S3,2026-11-01T00:00:00Z\n`;
    const key = "focus/e/data/BILLING_PERIOD=2026-11/e-00001.csv";
    const objects = new Map<string, Uint8Array>([
      [key, new TextEncoder().encode(csv)],
      [
        "focus/e/metadata/BILLING_PERIOD=2026-11/e-Manifest.json",
        new TextEncoder().encode(JSON.stringify({ dataFiles: [`s3://acme-cost/${key}`] })),
      ],
    ]);
    const cli: AwsBillingCli = {
      list: async () => ({
        ok: true,
        text: JSON.stringify({
          Contents: [...objects.keys()].map((Key) => ({
            Key,
            LastModified: "2026-11-19T00:00:00+00:00",
          })),
        }),
      }),
      download: async (url) => {
        const o = objects.get(url.replace("s3://acme-cost/", ""));
        return o === undefined ? { ok: false } : { ok: true, bytes: o };
      },
    };
    const forbidden = new FakeCe();
    await createAwsBillingCostSyncable({
      aws: () => cfg({ export: { bucket: "acme-cost", prefix: "focus" } }),
      now: () => NOW,
      cli,
      ce: forbidden,
    }).sync(ctx(), null);
    expect(forbidden.calls).toEqual([]);
    const byDay = new Map(stored().map((l) => [l.chargeDay, l.billedCost]));
    expect(byDay.get("2026-11-02")).toBe(10); // the export replaced the Cost Explorer line, no double count
    expect(byDay.get("2026-11-03")).toBe(6); // a day the export does not cover keeps its line
    expect(stored()).toHaveLength(2);
  });
});

describe("aws_billing: Cost Explorer replies that cannot be trusted", () => {
  test("a page token that does not advance, or a reply that is not JSON, is a month_gap", async () => {
    const stuck = new FakeCe();
    const orig = stuck.run.bind(stuck);
    stuck.run = async (args) => {
      const r = await orig(args);
      if (args[0] !== "ce") return r;
      return { ok: true, text: JSON.stringify({ ResultsByTime: [], NextPageToken: "same" }) };
    };
    const a = await run(stuck, cfg());
    expect(a.cursor.gaps[CE_KEY]).toContain("did not advance");

    const junk = new FakeCe();
    const origJunk = junk.run.bind(junk);
    junk.run = async (args) => (args[0] === "ce" ? { ok: true, text: "not json" } : origJunk(args));
    const b = await run(junk, cfg());
    expect(b.cursor.gaps[CE_KEY]).toContain("reply could not be read");
    expect(stored()).toHaveLength(0);
  });

  test("the legacy MasterAccountId field is read, and an account id that is not 12 digits is refused", async () => {
    const legacy = new FakeCe();
    legacy.pages.set("2026-11", [[result("2026-11-02", "S3", "222222222222", "1")]]);
    const o = legacy.run.bind(legacy);
    legacy.run = async (args) =>
      args[0] === "organizations"
        ? { ok: true, text: JSON.stringify({ Organization: { MasterAccountId: "888888888888" } }) }
        : o(args);
    await run(legacy, cfg());
    expect(stored()[0]?.billingAccountId).toBe("888888888888");

    const bad = new FakeCe();
    const ob = bad.run.bind(bad);
    bad.run = async (args) =>
      args[0] === "sts" ? { ok: true, text: JSON.stringify({ Account: "abc" }) } : ob(args);
    const r = await run(bad, cfg());
    expect(r.cursor.gaps[CE_KEY]).toBe(AWS_CE_GAPS.account);
  });

  test("the real CLI binding runs nothing without usable credentials", async () => {
    await vault.delete("aws.access_key_id");
    await vault.delete("aws.secret_access_key");
    await vault.delete("aws.default_region");
    expect(await awsCeCli(ctx()).run(["sts", "get-caller-identity"])).toEqual({
      ok: false,
      text: "",
    });
  });
});

describe("ceTimePeriod", () => {
  test("a past month is whole; the running month ends tomorrow", () => {
    expect(ceTimePeriod("2026-10", NOW)).toEqual({ start: "2026-10-01", end: "2026-11-01" });
    expect(ceTimePeriod("2026-11", NOW)).toEqual({ start: "2026-11-01", end: "2026-11-21" });
  });
});
