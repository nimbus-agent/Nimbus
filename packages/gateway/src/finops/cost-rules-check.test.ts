import { describe, expect, test } from "bun:test";

import type { CostLine } from "./cost-line.ts";
import type { CostRule } from "./cost-rules.ts";
import { checkCostRules } from "./cost-rules-check.ts";
import type { CostViewInput } from "./cost-views.ts";

const RANGE = { fromDay: "2026-10-28", toDay: "2026-11-26", label: "last 30 days" };

function line(over: Partial<CostLine> & { billedCost: number }): CostLine {
  return {
    source: "focus",
    provider: "aws",
    billingAccountId: "123",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-20",
    subAccountId: null,
    subAccountName: null,
    serviceName: "Amazon EC2",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    effectiveCost: null,
    currency: "USD",
    tags: {},
    repo: null,
    workflow: null,
    model: null,
    importId: "focus:0",
    ...over,
  };
}

const RULES: CostRule[] = [
  { index: 1, match: { tag: { product: "*" } }, set: { product: "{tag.product}" } },
  { index: 2, match: { service: "Amazon S3" }, set: { product: "storage" } },
  { index: 3, match: { provider: "gcp" }, set: { product: "never" } },
];

function input(lines: CostLine[], configError: string | null = null): CostViewInput {
  return {
    lines,
    rules: RULES,
    range: RANGE,
    nowMs: Date.UTC(2026, 10, 26, 9),
    empty: lines.length === 0,
    lastDays: [],
    knownCurrencies: [],
    excludedSources: [],
    notes: [],
    configError,
  };
}

const LINES: CostLine[] = [
  line({ billedCost: 10, tags: { product: "checkout" } }),
  line({ billedCost: 4, tags: { product: "<!here>" } }),
  line({ billedCost: 6, serviceName: "Amazon S3" }),
  line({ billedCost: 2, subAccountId: "acct-1", tags: { team: "x", owner: "y" } }),
  line({ billedCost: 3, subAccountId: "acct-1", tags: { owner: "z", team: "w" } }),
  line({ billedCost: 5, currency: "EUR", serviceName: "Azure VM", provider: "azure" }),
  line({ billedCost: 99, chargeDay: "2026-10-01", tags: { product: "old" } }),
];

describe("checkCostRules", () => {
  test("counts per rule, including a match whose value was unsafe", () => {
    const r = checkCostRules(input(LINES));
    expect(r.configError).toBeNull();
    expect(r.range).toEqual(RANGE);
    expect(r.rules).toEqual([
      { index: 1, lines: 2, amountByCurrency: { USD: 14 }, unassignedLines: 1 },
      { index: 2, lines: 1, amountByCurrency: { USD: 6 }, unassignedLines: 0 },
      { index: 3, lines: 0, amountByCurrency: {}, unassignedLines: 0 },
    ]);
    expect(r.unusedRules).toEqual([3]);
  });

  test("the unassigned share per currency, lines outside the range ignored", () => {
    const r = checkCostRules(input(LINES));
    expect(r.byCurrency["USD"]).toEqual({ total: 25, unassigned: 9, unassignedPct: 36 });
    expect(r.byCurrency["EUR"]).toEqual({ total: 5, unassigned: 5, unassignedPct: 100 });
  });

  test("top unassigned groups by provider, service, sub-account and sorted tag keys, with the reason", () => {
    const r = checkCostRules(input(LINES));
    expect(r.topUnassigned[0]).toEqual({
      provider: "aws",
      service: "Amazon EC2",
      subAccount: "acct-1",
      tagKeys: ["owner", "team"],
      lines: 2,
      amountByCurrency: { USD: 5 },
      reason: "no rule matched",
    });
    expect(r.topUnassigned).toHaveLength(3);
    expect(r.topUnassigned.map((g) => g.provider).sort()).toEqual(["aws", "aws", "azure"]);
    const unsafe = r.topUnassigned.find((g) => g.tagKeys.includes("product"));
    expect(unsafe?.reason).toStartWith('rule 1: product: the value "<!here>" is not allowed');
    expect(r.topUnassignedTruncated).toBe(0);
  });

  test("at most 10 unassigned groups, the rest counted", () => {
    const lines = Array.from({ length: 13 }, (_, i) =>
      line({ billedCost: 1, serviceName: `svc-${String(i)}` }),
    );
    const r = checkCostRules(input(lines));
    expect(r.topUnassigned).toHaveLength(10);
    expect(r.topUnassignedTruncated).toBe(3);
  });

  test("a zero total has a null unassigned percent", () => {
    const r = checkCostRules(input([line({ billedCost: 0, tags: { product: "p" } })]));
    expect(r.byCurrency["USD"]).toEqual({ total: 0, unassigned: 0, unassignedPct: null });
  });

  test("a refused config reports the error and no rule counts", () => {
    const r = checkCostRules(input(LINES, "unknown key foo in [[cost.rule]] 2"));
    expect(r.configError).toBe("unknown key foo in [[cost.rule]] 2");
    expect(r.rules).toEqual([]);
    expect(r.unusedRules).toEqual([]);
    expect(r.byCurrency["USD"]).toEqual({ total: 25, unassigned: 25, unassignedPct: 100 });
  });
});
