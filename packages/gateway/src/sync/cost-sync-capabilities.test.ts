// Phase 7, slice 8 (static D24 `cost-line-confined`): the cost capabilities read and re-price only the bound
// service's own lines, and only a cost-sync service holds them.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CostLine } from "../finops/cost-line.ts";
import { readCostLines, replaceCostLines } from "../finops/cost-line-store.ts";
import type { CostRates } from "../finops/cost-rate-price.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  buildCostSyncCapabilities,
  COST_SYNC_SERVICES,
  refusingCostSyncCapabilities,
} from "./cost-sync-capabilities.ts";
import { upsertSchedulerRegistration } from "./scheduler-store.ts";

const MONTH = { provider: "gitlab", billingAccountId: "acme", month: "2026-11" } as const;
const CENT: CostRates = { ratePerMinute: 0.01, currency: "USD", keyedRates: [] };

function line(source: string, over: Partial<CostLine> = {}): CostLine {
  return {
    source,
    provider: "gitlab",
    billingAccountId: "acme",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-02",
    subAccountId: "acme/web",
    subAccountName: null,
    serviceName: "GitLab CI",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: "compute_minutes",
    chargeCategory: "usage",
    billedCost: 0,
    effectiveCost: null,
    currency: "USD",
    tags: { rate_key: "default" },
    repo: "acme/web",
    workflow: null,
    model: null,
    importId: "i",
    consumedQuantity: 100,
    consumedUnit: "minute",
    priced: false,
    ...over,
  };
}

/** Store lines of ONE (source, provider, account, period) in one call (a second call would replace the day). */
const seed = (db: Database, ...ls: CostLine[]): void => {
  const l = ls[0] as CostLine;
  replaceCostLines(
    db,
    {
      source: l.source,
      provider: l.provider,
      billingAccountId: l.billingAccountId,
      billingPeriod: l.billingPeriod,
    },
    [...new Set(ls.map((x) => x.chargeDay))],
    ls,
  );
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  upsertSchedulerRegistration(db, "gitlab_billing", 86_400_000, 0, false);
});
afterEach(() => {
  db.close();
});

describe("cost sync capabilities", () => {
  test("gitlab_billing and aws_billing are cost-sync services", () => {
    expect(COST_SYNC_SERVICES.has("aws_billing")).toBe(true);
    expect(COST_SYNC_SERVICES.has("azure_billing")).toBe(true);
    expect(COST_SYNC_SERVICES.has("gitlab_billing")).toBe(true);
  });

  test("the bound read returns only the service's own lines", () => {
    seed(db, line("gitlab_billing"));
    seed(db, line("focus", { chargeDay: "2026-11-03" }));
    const own = buildCostSyncCapabilities(db, "gitlab_billing").readOwnCostLinesForMonth(MONTH);
    expect(own.map((l) => l.source)).toEqual(["gitlab_billing"]);
  });

  test("a rate added prices the lines; removed, they are unpriced again; another source is untouched", () => {
    seed(db, line("gitlab_billing"));
    seed(db, line("focus", { tags: { rate_key: "default" } }));
    const caps = buildCostSyncCapabilities(db, "gitlab_billing");
    expect(caps.repriceOwnCostLines(CENT)).toEqual({ repriced: 1, skipped: 0 });
    const read = () => readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" });
    expect(read().find((l) => l.source === "gitlab_billing")).toMatchObject({
      billedCost: 1,
      effectiveCost: 1,
      priced: true,
    });
    expect(read().find((l) => l.source === "focus")).toMatchObject({
      billedCost: 0,
      priced: false,
    });
    caps.repriceOwnCostLines({ ...CENT, ratePerMinute: null });
    expect(read().find((l) => l.source === "gitlab_billing")).toMatchObject({
      billedCost: 0,
      effectiveCost: null,
      priced: false,
    });
  });

  test("a currency change moves the lines to it, re-hashed, with no duplicate grain", () => {
    seed(
      db,
      line("gitlab_billing"),
      line("gitlab_billing", { subAccountId: "acme/api", repo: "acme/api", consumedQuantity: 50 }),
    );
    const caps = buildCostSyncCapabilities(db, "gitlab_billing");
    caps.repriceOwnCostLines(CENT);
    caps.repriceOwnCostLines({ ...CENT, currency: "EUR", ratePerMinute: 0.02 });
    const lines = readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" });
    expect(lines.map((l) => [l.subAccountId, l.currency, l.billedCost]).sort()).toEqual([
      ["acme/api", "EUR", 1],
      ["acme/web", "EUR", 2],
    ]);
  });

  test("a line with no rate_key or no quantity is left as stored", () => {
    seed(db, line("gitlab_billing", { tags: {}, priced: true, billedCost: 3, effectiveCost: 3 }));
    const r = buildCostSyncCapabilities(db, "gitlab_billing").repriceOwnCostLines(CENT);
    expect(r).toEqual({ repriced: 0, skipped: 1 });
    expect(readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" })[0]?.billedCost).toBe(
      3,
    );
  });

  test("a service outside the cost syncs is refused; a removed one may not re-price", () => {
    const jira = buildCostSyncCapabilities(db, "jira");
    expect(() => jira.readOwnCostLinesForMonth(MONTH)).toThrow(/not available to "jira"/);
    expect(() => jira.repriceOwnCostLines(CENT)).toThrow(/not available to "jira"/);
    const gone = buildCostSyncCapabilities(db, "openai_billing");
    expect(() => gone.repriceOwnCostLines(CENT)).toThrow(/was removed during this sync/);
  });

  test("the refusing set refuses all three by name", () => {
    const caps = refusingCostSyncCapabilities((what) => {
      throw new Error(`no ${what}`);
    });
    expect(() => caps.repriceOwnCostLines(CENT)).toThrow("no repriceOwnCostLines");
    expect(() => caps.readOwnCostLinesForMonth(MONTH)).toThrow("no readOwnCostLinesForMonth");
    expect(() => caps.replaceCostLinesForMonth(MONTH, [])).toThrow("no replaceCostLinesForMonth");
  });
});
