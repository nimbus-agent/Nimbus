// Slice 15: the split reaches every view through `gatherCostViewInput`, and stored rows never change.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CostLine } from "./cost-line.ts";
import { readCostLines, replaceCostLines, repriceCostLines } from "./cost-line-store.ts";
import { compileCostRule } from "./cost-rules.ts";
import { checkCostRules } from "./cost-rules-check.ts";
import { type CostViewConfig, gatherCostViewInput } from "./cost-view-input.ts";
import { internalView, productView } from "./cost-views.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const RANGE = { fromDay: "2026-11-01", toDay: "2026-11-26", label: "test" };
const RULES = [
  compileCostRule(
    { match: { source: "jenkins_billing" }, set: { product: "{repo}", env: "ci" } },
    1,
  ),
  compileCostRule({ match: { tag: { idle: "true" } }, set: { product: "ci-idle", env: "ci" } }, 2),
];
const CFG: CostViewConfig = {
  rules: RULES,
  authoritative: {},
  error: null,
  jenkins: { agentCost: [{ agent: "big", provider: "aws", resource: "i-0abc*" }] },
};

function line(over: Partial<CostLine>): CostLine {
  return {
    source: "aws_billing",
    provider: "aws",
    billingAccountId: "111",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-20",
    subAccountId: null,
    subAccountName: null,
    serviceName: "Amazon EC2",
    serviceCategory: null,
    regionId: null,
    resourceId: "i-0abc123",
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    billedCost: 14.4,
    effectiveCost: null,
    currency: "USD",
    tags: {},
    repo: null,
    workflow: null,
    model: null,
    importId: "i",
    ...over,
  };
}

const buildLine = (repo: string, minutes: number): CostLine =>
  line({
    source: "jenkins_billing",
    provider: "jenkins",
    billingAccountId: "ci.acme.test",
    serviceName: "Jenkins builds",
    resourceId: null,
    resourceName: "big",
    subAccountId: repo,
    repo,
    skuId: "build_minutes",
    billedCost: 0,
    tags: { rate_key: "cloud:big", cloud_resource: "i-0abc*" },
    consumedQuantity: minutes,
    consumedUnit: "minute",
    priced: false,
  });

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const put = (l: CostLine): unknown =>
    replaceCostLines(
      db,
      {
        source: l.source,
        provider: l.provider,
        billingAccountId: l.billingAccountId,
        billingPeriod: l.billingPeriod,
      },
      [l.chargeDay],
      [l],
    );
  put(line({}));
  // One Jenkins line per job: they share a source and account, so write them in one replace.
  replaceCostLines(
    db,
    {
      source: "jenkins_billing",
      provider: "jenkins",
      billingAccountId: "ci.acme.test",
      billingPeriod: "2026-11",
    },
    ["2026-11-20"],
    [buildLine("app", 144), buildLine("api", 288)],
  );
});
afterEach(() => {
  db.close();
});

describe("the agent machine split in the views", () => {
  test("products shows CI cost per build's product next to the machine's idle share", () => {
    const v = productView(gatherCostViewInput(db, CFG, RANGE, NOW));
    const usd = v.byCurrency["USD"];
    expect(usd?.rows.map((r) => [r.key, r.secondary, Math.round(r.amount * 100) / 100])).toEqual([
      ["api", "ci", 2.88],
      ["app", "ci", 1.44],
      ["ci-idle", "ci", 10.08],
    ]);
    expect(usd?.total).toBeCloseTo(14.4, 9);
    expect(usd?.unassigned).toBe(0);
    // The quantity-only lines are gone, so nothing is reported as unpriced.
    expect(v.freshness.some((f) => f.unpriced !== undefined)).toBe(false);
  });

  test("internal and the rules check read the same split", () => {
    const input = gatherCostViewInput(db, CFG, RANGE, NOW);
    expect(internalView(input, ["ci"]).byCurrency["USD"]?.total).toBeCloseTo(14.4, 9);
    const check = checkCostRules(input);
    expect(check.byCurrency["USD"]?.total).toBeCloseTo(14.4, 9);
    expect(check.byCurrency["USD"]?.unassigned).toBe(0);
  });

  test("without agent_cost the lines are as stored: the cloud line whole, the minutes unpriced", () => {
    const input = gatherCostViewInput(
      db,
      { rules: RULES, authoritative: {}, error: null },
      RANGE,
      NOW,
    );
    expect(input.lines).toHaveLength(3);
    expect(productView(input).byCurrency["USD"]?.total).toBeCloseTo(14.4, 9);
  });

  test("a refused cost config applies no split", () => {
    const input = gatherCostViewInput(db, { ...CFG, error: "bad" }, RANGE, NOW);
    expect(input.lines).toHaveLength(3);
  });

  test("the split never changes a stored row, and a re-price leaves cloud: lines unpriced", () => {
    const before = readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" });
    gatherCostViewInput(db, CFG, RANGE, NOW);
    const r = repriceCostLines(db, "jenkins_billing", {
      ratePerMinute: 0.01,
      currency: "USD",
      keyedRates: [["cloud:big", 5]],
    });
    expect(r.repriced).toBe(2);
    const after = readCostLines(db, { fromDay: "2026-11-01", toDay: "2026-11-30" });
    expect(after).toHaveLength(before.length);
    for (const l of after.filter((x) => x.source === "jenkins_billing")) {
      expect(l).toMatchObject({ billedCost: 0, priced: false });
    }
    expect(after.find((l) => l.source === "aws_billing")?.billedCost).toBe(14.4);
    expect(
      productView(gatherCostViewInput(db, CFG, RANGE, NOW)).byCurrency["USD"]?.total,
    ).toBeCloseTo(14.4, 9);
  });
});
