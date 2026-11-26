import { describe, expect, test } from "bun:test";

import type { CostReportDef } from "../config/cost-report-toml.ts";
import type { CostLine } from "./cost-line.ts";
import { buildCostReport } from "./cost-report-model.ts";
import type { CostRule } from "./cost-rules.ts";

const NOW = Date.UTC(2026, 10, 25, 9);
const RANGE = { fromDay: "2026-11-16", toDay: "2026-11-22", label: "week of Monday 2026-11-16" };
const PREVIOUS = { fromDay: "2026-11-09", toDay: "2026-11-15", label: "the week before" };

function line(over: Partial<CostLine> & { chargeDay: string; billedCost: number }): CostLine {
  return {
    source: "focus",
    provider: "aws",
    billingAccountId: "123",
    billingPeriod: over.chargeDay.slice(0, 7),
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
  {
    index: 1,
    match: { tag: { product: "*" } },
    set: { product: "{tag.product}", env: "{tag.env}", service: "{tag.service}" },
  },
];
const tags = (product: string, env = "prod", service = "web") => ({ product, env, service });

const LINES: CostLine[] = [
  line({
    chargeDay: "2026-11-17",
    billedCost: 100,
    tags: tags("checkout", "prod", "payment-service"),
  }),
  line({
    chargeDay: "2026-11-18",
    billedCost: 20,
    serviceName: "Amazon RDS",
    tags: tags("checkout", "dev", "orders-service"),
  }),
  line({
    chargeDay: "2026-11-10",
    billedCost: 60,
    tags: tags("checkout", "prod", "payment-service"),
  }),
  line({
    chargeDay: "2026-11-17",
    billedCost: 9,
    currency: "EUR",
    provider: "azure",
    serviceName: "Azure VM",
    tags: tags("checkout"),
  }),
  line({ chargeDay: "2026-11-17", billedCost: 50, tags: tags("search") }),
  line({ chargeDay: "2026-11-17", billedCost: 7 }), // no tags: unassigned
  line({ chargeDay: "2026-11-30", billedCost: 999, tags: tags("checkout") }), // outside both periods
];

function def(scope: CostReportDef["scope"]): CostReportDef {
  return { name: "checkout-weekly", scope, period: "week", schedule: null, tz: null, channels: [] };
}

function build(
  scope: CostReportDef["scope"],
  over: Partial<Parameters<typeof buildCostReport>[0]> = {},
) {
  return buildCostReport({
    lines: LINES,
    rules: RULES,
    configError: null,
    def: def(scope),
    range: RANGE,
    previous: PREVIOUS,
    weekStart: "2026-11-16",
    nowMs: NOW,
    lastDays: [{ source: "focus", lastDay: "2026-11-24" }],
    empty: false,
    ...over,
  });
}

describe("buildCostReport", () => {
  test("a product scope: per-currency totals, change, movers and breakdown", () => {
    const m = build({ product: "checkout" });
    expect(m.name).toBe("checkout-weekly");
    expect(m.command).toBe("nimbus cost report checkout-weekly");
    expect(m.weekStart).toBe("2026-11-16");
    expect(Object.keys(m.byCurrency)).toEqual(["EUR", "USD"]);
    const usd = m.byCurrency["USD"];
    expect(usd).toMatchObject({ total: 120, previous: 60, change: 60, changePct: 100 });
    expect(usd?.topMovers[0]).toEqual({
      service: "payment-service",
      part: "Amazon EC2",
      provider: "aws",
      change: 40,
    });
    expect(usd?.breakdown).toEqual([
      { part: "payment-service", provider: "aws", env: "prod", amount: 100 },
      { part: "orders-service", provider: "aws", env: "dev", amount: 20 },
    ]);
    expect(m.byCurrency["EUR"]).toMatchObject({
      total: 9,
      previous: 0,
      change: 9,
      changePct: null,
    });
  });

  test("unassigned cost is stated beside the total, never inside it", () => {
    const usd = build({ product: "checkout" }).byCurrency["USD"];
    expect(usd?.total).toBe(120);
    expect(usd?.unassigned).toBe(7);
    // 7 of the 177 USD in the range (100 + 20 + 50 + 7) could not be attributed.
    expect(usd?.unassignedPct).toBeCloseTo((7 / 177) * 100, 6);
  });

  test("scope by env and provider, and by service", () => {
    expect(build({ env: "dev" }).byCurrency["USD"]?.total).toBe(20);
    expect(build({ provider: "azure" }).byCurrency["EUR"]?.total).toBe(9);
    expect(build({ provider: "azure" }).byCurrency["USD"]?.total).toBe(0);
    expect(build({ service: "payment-service", env: "prod" }).byCurrency["USD"]).toMatchObject({
      total: 100,
      previous: 60,
    });
  });

  test("no figure anywhere sums two currencies", () => {
    const m = build({ product: "checkout" });
    expect(m).not.toHaveProperty("total");
    expect(m.byCurrency["USD"]?.total).toBe(120);
    expect(m.byCurrency["EUR"]?.total).toBe(9);
  });

  test("movers are at most 3 per currency, by the size of the change", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      line({
        chargeDay: "2026-11-17",
        billedCost: i + 1,
        serviceName: `svc-${String(i)}`,
        tags: tags("p"),
      }),
    );
    const usd = build({ product: "p" }, { lines: many }).byCurrency["USD"];
    expect(usd?.topMovers.map((x) => x.part)).toEqual(["svc-4", "svc-3", "svc-2"]);
    expect(usd?.breakdown).toHaveLength(1);
  });

  test("a refused config puts nothing in scope and says why", () => {
    const m = build({ product: "checkout" }, { configError: "bad [cost]" });
    expect(m.configError).toBe("bad [cost]");
    expect(m.byCurrency["USD"]?.total).toBe(0);
    expect(m.byCurrency["USD"]?.unassigned).toBe(177);
  });

  test("no cost data, and the provisional marker", () => {
    expect(build({ product: "checkout" }, { lines: [], empty: true, lastDays: [] })).toMatchObject({
      empty: true,
      byCurrency: {},
      freshness: [],
    });
    expect(build({ product: "checkout" }).provisionalFrom).toBeNull();
    const recent = { fromDay: "2026-11-18", toDay: "2026-11-24", label: "x" };
    expect(build({ product: "checkout" }, { range: recent }).provisionalFrom).toBe("2026-11-23");
    expect(build({ product: "checkout" }).freshness).toEqual([
      { source: "focus", lastDay: "2026-11-24", provisionalFrom: "2026-11-23" },
    ]);
  });
});
