import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CostLine } from "./cost-line.ts";
import { replaceCostLines } from "./cost-line-store.ts";
import { compileCostRule } from "./cost-rules.ts";
import { type CostViewConfig, gatherCostViewInput } from "./cost-view-input.ts";
import { internalView, periodWindow, productView } from "./cost-views.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const RULES = [
  compileCostRule(
    { match: { tag: { product: "*" } }, set: { product: "{tag.product}", env: "{tag.env}" } },
    1,
  ),
  compileCostRule(
    { match: { source: "github_actions" }, set: { env: "ci", product: "{repo}" } },
    2,
  ),
];
const CFG: CostViewConfig = { rules: RULES, authoritative: {}, error: null };

function line(over: Partial<CostLine>): CostLine {
  return {
    source: "focus",
    provider: "aws",
    billingAccountId: "111",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-20",
    subAccountId: null,
    subAccountName: null,
    serviceName: "Amazon S3",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    billedCost: 10,
    effectiveCost: null,
    currency: "USD",
    tags: { product: "checkout", env: "prod" },
    repo: null,
    workflow: null,
    model: null,
    importId: "i",
    ...over,
  };
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

function store(lines: CostLine[]): void {
  const groups = new Map<string, CostLine[]>();
  for (const l of lines) {
    const k = JSON.stringify([l.source, l.provider, l.billingAccountId, l.billingPeriod]);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const g of groups.values()) {
    const f = g[0] as CostLine;
    replaceCostLines(
      db,
      {
        source: f.source,
        provider: f.provider,
        billingAccountId: f.billingAccountId,
        billingPeriod: f.billingPeriod,
      },
      [...new Set(g.map((l) => l.chargeDay))],
      g,
    );
  }
}

const range30 = periodWindow("30d", NOW) ?? { fromDay: "", toDay: "", label: "" };
const products = (cfg = CFG) => productView(gatherCostViewInput(db, cfg, range30, NOW));

describe("periodWindow", () => {
  test("Nd, week (Monday-based) and month end today (UTC)", () => {
    expect(periodWindow("7d", NOW)).toMatchObject({ fromDay: "2026-11-20", toDay: "2026-11-26" });
    // 2026-11-26 is a Thursday.
    expect(periodWindow("week", NOW)).toMatchObject({ fromDay: "2026-11-23", toDay: "2026-11-26" });
    expect(periodWindow("month", NOW)).toMatchObject({
      fromDay: "2026-11-01",
      toDay: "2026-11-26",
    });
    expect(periodWindow("0d", NOW)).toBeUndefined();
    expect(periodWindow("401d", NOW)).toBeUndefined();
    expect(periodWindow("year", NOW)).toBeUndefined();
  });
});

describe("productView", () => {
  test("per product, part and env; the unassigned share with its reasons", () => {
    store([
      line({ billedCost: 10 }),
      line({ serviceName: "Amazon EC2", billedCost: 30, resourceId: "i-1" }),
      line({ tags: { product: "search", env: "prod" }, billedCost: 5, resourceId: "r2" }),
      line({ tags: {}, billedCost: 2, resourceId: "r3" }),
      line({ tags: { product: "<!here>", env: "prod" }, billedCost: 1, resourceId: "r4" }),
    ]);
    const v = products();
    expect(v.empty).toBe(false);
    const usd = v.byCurrency["USD"];
    expect(usd?.total).toBe(48);
    expect(usd?.rows.map((r) => [r.key, r.secondary, r.part, r.amount])).toEqual([
      ["checkout", "prod", "Amazon EC2", 30],
      ["checkout", "prod", "Amazon S3", 10],
      ["search", "prod", "Amazon S3", 5],
    ]);
    expect(usd?.unassigned).toBe(3);
    expect(usd?.unassignedReasons.map((r) => [r.reason.slice(0, 22), r.amount])).toEqual([
      ["no rule matched", 2],
      ["rule 1: product: the v", 1],
    ]);
  });

  test("two currencies never produce a grand total (Review Focus 3)", () => {
    store([
      line({ billedCost: 10 }),
      line({ currency: "EUR", billedCost: 7, billingAccountId: "222" }),
    ]);
    const v = products();
    expect(Object.keys(v.byCurrency)).toEqual(["EUR", "USD"]);
    expect(v.byCurrency["EUR"]?.total).toBe(7);
    expect(v.byCurrency["USD"]?.total).toBe(10);
    expect(Object.keys(v)).not.toContain("total");
  });

  test("no cost data at all is `empty`; a period with no lines is 0 in each known currency (Review Focus 5)", () => {
    const none = products();
    expect(none.empty).toBe(true);
    expect(none.byCurrency).toEqual({});
    store([line({ chargeDay: "2026-01-05", billingPeriod: "2026-01" })]);
    const zero = products();
    expect(zero.empty).toBe(false);
    expect(zero.byCurrency["USD"]).toMatchObject({ total: 0, rows: [], unassigned: 0 });
  });

  test("the last three days of a source are provisional", () => {
    store([line({ chargeDay: "2026-11-25" })]);
    expect(products().freshness).toEqual([
      { source: "focus", lastDay: "2026-11-25", provisionalFrom: "2026-11-24" },
    ]);
    db.run("DELETE FROM cost_line");
    store([line({ chargeDay: "2026-11-10" })]);
    expect(products().freshness[0]?.provisionalFrom).toBeNull();
  });

  test("a refused config allocates nothing and says why", () => {
    store([line({})]);
    const v = products({ rules: RULES, authoritative: {}, error: 'rule 1: unknown match key "x"' });
    expect(v.configError).toContain("unknown match key");
    expect(v.byCurrency["USD"]?.unassigned).toBe(10);
  });
});

function seedVantage(amount: number, provider = "aws", dayMs = Date.UTC(2026, 10, 20)): void {
  upsertIndexedItem(db, {
    service: "vantage",
    type: "cost_allocation",
    externalId: `v-${provider}-${String(amount)}`,
    title: "t",
    bodyPreview: "t",
    modifiedAt: Date.UTC(2026, 10, 20),
    metadata: {
      scopeSeries: "rep|ws|service~h",
      dimensionKind: "service",
      dimensionKey: null,
      dimensionValue: "Amazon S3",
      periodStartMs: dayMs,
      amount,
      currency: "USD",
      provider,
      cloudService: null,
    },
    syncedAt: Date.UTC(2026, 10, 21),
  });
}

describe("sources: Vantage and the authoritative rule", () => {
  test("Vantage rows fill a provider with no raw lines and are excluded, listed, where raw lines exist", () => {
    store([line({ billedCost: 10 })]);
    seedVantage(99, "aws");
    seedVantage(4, "gcp");
    const v = products();
    expect(v.byCurrency["USD"]?.total).toBe(14);
    expect(v.excludedSources).toEqual([
      {
        source: "vantage",
        provider: "aws",
        reason: "raw cost lines exist for this provider (set [cost] authoritative to choose)",
      },
    ]);
    expect(v.freshness.map((f) => f.source)).toEqual(["focus", "vantage"]);
  });

  test("a period with no Vantage row is 0 in each currency an older Vantage row used", () => {
    seedVantage(7, "aws", Date.UTC(2026, 0, 5));
    const v = products();
    expect(v.empty).toBe(false);
    expect(v.byCurrency["USD"]).toMatchObject({ total: 0, rows: [], unassigned: 0 });
  });

  test("[cost] authoritative picks the source for a provider", () => {
    store([line({ billedCost: 10 })]);
    seedVantage(99, "aws");
    const v = products({ rules: RULES, authoritative: { aws: "vantage" }, error: null });
    expect(v.byCurrency["USD"]?.total).toBe(99);
    expect(v.excludedSources).toEqual([
      { source: "focus", provider: "aws", reason: "[cost] authoritative names vantage for aws" },
    ]);
  });
});

describe("internalView", () => {
  test("only internal envs are shown; other envs and unknown envs are counted apart", () => {
    store([
      line({
        source: "github_actions",
        provider: "github",
        repo: "acme/web",
        tags: {},
        billedCost: 8,
      }),
      line({ tags: { product: "checkout", env: "dev" }, billedCost: 3 }),
      line({ tags: { product: "checkout", env: "prod" }, billedCost: 50, resourceId: "p" }),
      line({ tags: {}, billedCost: 1, resourceId: "u" }),
    ]);
    const v = internalView(gatherCostViewInput(db, CFG, range30, NOW), [
      "ci",
      "dev",
      "test",
      "staging",
    ]);
    const usd = v.byCurrency["USD"];
    expect(usd?.rows.map((r) => [r.key, r.secondary, r.part, r.provider, r.amount])).toEqual([
      ["ci", "acme/web", "Amazon S3", "github", 8],
      ["dev", "checkout", "Amazon S3", "aws", 3],
    ]);
    expect(usd?.outside).toBe(50);
    expect(usd?.unassigned).toBe(1);
    expect(usd?.total).toBe(62);
    expect(v.internalEnvs).toEqual(["ci", "dev", "test", "staging"]);
  });
});
