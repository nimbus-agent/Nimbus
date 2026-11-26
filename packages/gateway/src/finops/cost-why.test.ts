import { describe, expect, test } from "bun:test";

import type { CostLine } from "./cost-line.ts";
import type { CostRule } from "./cost-rules.ts";
import { compareCost, previousRange, resolveCostTarget, rulesInForce } from "./cost-why.ts";

const NOW = Date.UTC(2026, 10, 26, 9);

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
    match: { tag: { product: "*", service: "*" } },
    set: { product: "{tag.product}", service: "{tag.service}" },
  },
  { index: 2, match: { tag: { product: "*" } }, set: { product: "{tag.product}" } },
];

const tagged = (product: string, service?: string): Record<string, string> =>
  service === undefined ? { product } : { product, service };

/** 14 + 14 days ending 2026-11-26: flat 10/day for checkout/payment-service, then two high days. */
function demoShaped(): CostLine[] {
  const out: CostLine[] = [];
  for (let d = 0; d < 28; d++) {
    const day = new Date(Date.UTC(2026, 10, 26) - (27 - d) * 86_400_000).toISOString().slice(0, 10);
    const spike = d >= 26 ? 40 : 0;
    out.push(
      line({ chargeDay: day, billedCost: 10 + spike, tags: tagged("checkout", "payment-service") }),
    );
    out.push(
      line({
        chargeDay: day,
        billedCost: 5,
        serviceName: "Amazon RDS",
        tags: tagged("checkout", "orders-service"),
      }),
    );
    out.push(line({ chargeDay: day, billedCost: 3, tags: tagged("search") }));
  }
  return out;
}

const RANGE = { fromDay: "2026-11-13", toDay: "2026-11-26", label: "last 14 days" };

describe("previousRange", () => {
  test("the same number of days immediately before", () => {
    const p = previousRange(RANGE);
    expect(p.fromDay).toBe("2026-10-30");
    expect(p.toDay).toBe("2026-11-12");
    expect(p.label).toBe("the 14 days before");
  });
});

describe("resolveCostTarget", () => {
  test("a product name and a service id resolve; a product wins over a service of the same name", () => {
    const lines = [
      ...demoShaped(),
      line({ chargeDay: "2026-11-20", billedCost: 1, tags: tagged("search", "checkout") }),
    ];
    expect(resolveCostTarget(lines, RULES, "checkout")).toEqual({
      kind: "product",
      name: "checkout",
    });
    expect(resolveCostTarget(lines, RULES, "payment-service")).toEqual({
      kind: "service",
      name: "payment-service",
    });
  });

  test("an unknown target lists the known products and services", () => {
    expect(resolveCostTarget(demoShaped(), RULES, "nope")).toEqual({
      kind: "unknown",
      known: { products: ["checkout", "search"], services: ["orders-service", "payment-service"] },
    });
  });

  test("a target known only from the previous range still resolves", () => {
    const lines = [line({ chargeDay: "2026-11-01", billedCost: 9, tags: tagged("legacy") })];
    expect(resolveCostTarget(lines, RULES, "legacy")).toEqual({ kind: "product", name: "legacy" });
  });

  test("a refused config allocates nothing, so every target is unknown", () => {
    const rules = rulesInForce(RULES, "bad [cost] config");
    expect(resolveCostTarget(demoShaped(), rules, "checkout")).toEqual({
      kind: "unknown",
      known: { products: [], services: [] },
    });
  });
});

describe("compareCost", () => {
  const prev = previousRange(RANGE);

  test("compares the range with the previous one and finds the spike onset", () => {
    const w = compareCost({
      lines: demoShaped(),
      rules: RULES,
      target: { kind: "product", name: "checkout" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    const usd = w.byCurrency["USD"];
    expect(usd?.current).toBe(14 * 15 + 80);
    expect(usd?.previous).toBe(14 * 15);
    expect(usd?.change).toBe(80);
    expect(usd?.changePct).toBeCloseTo((80 / 210) * 100, 5);
    expect(usd?.spikeDay).toBe("2026-11-25");
    expect(usd?.movers[0]).toEqual({
      service: "payment-service",
      part: "Amazon EC2",
      provider: "aws",
      current: 220,
      previous: 140,
      change: 80,
    });
    expect(w.services).toEqual(["payment-service", "orders-service"]);
    expect(w.provisionalFrom).toBe("2026-11-24");
    expect(Object.keys(w.byCurrency)).toEqual(["USD"]);
  });

  test("a flat series has no spike day", () => {
    const w = compareCost({
      lines: demoShaped(),
      rules: RULES,
      target: { kind: "product", name: "search" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    expect(w.byCurrency["USD"]?.spikeDay).toBeNull();
    expect(w.byCurrency["USD"]?.change).toBe(0);
  });

  test("a tie between two spike days picks the earlier", () => {
    const lines = [
      line({ chargeDay: "2026-11-20", billedCost: 50, tags: tagged("p") }),
      line({ chargeDay: "2026-11-22", billedCost: 50, tags: tagged("p") }),
      line({ chargeDay: "2026-11-01", billedCost: 14, tags: tagged("p") }),
    ];
    const w = compareCost({
      lines,
      rules: RULES,
      target: { kind: "product", name: "p" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    expect(w.byCurrency["USD"]?.spikeDay).toBe("2026-11-20");
  });

  test("two currencies give two comparisons and no total; a zero baseline has a null percent", () => {
    const lines = [
      line({ chargeDay: "2026-11-20", billedCost: 7, tags: tagged("p") }),
      line({ chargeDay: "2026-11-01", billedCost: 4, tags: tagged("p") }),
      line({ chargeDay: "2026-11-20", billedCost: 9, currency: "EUR", tags: tagged("p") }),
    ];
    const w = compareCost({
      lines,
      rules: RULES,
      target: { kind: "product", name: "p" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    expect(Object.keys(w.byCurrency)).toEqual(["EUR", "USD"]);
    expect(w.byCurrency["EUR"]).toMatchObject({
      current: 9,
      previous: 0,
      change: 9,
      changePct: null,
    });
    expect(w.byCurrency["USD"]).toMatchObject({
      current: 7,
      previous: 4,
      change: 3,
      changePct: 75,
    });
    expect(w).not.toHaveProperty("total");
  });

  test("a cost that fell to zero shows the drop", () => {
    const lines = [
      line({ chargeDay: "2026-11-01", billedCost: 9, tags: tagged("legacy", "old-svc") }),
    ];
    const w = compareCost({
      lines,
      rules: RULES,
      target: { kind: "product", name: "legacy" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    expect(w.byCurrency["USD"]).toMatchObject({
      current: 0,
      previous: 9,
      change: -9,
      changePct: -100,
    });
    expect(w.byCurrency["USD"]?.spikeDay).toBeNull();
    expect(w.services).toEqual(["old-svc"]);
  });

  test("a service target counts only that service's lines", () => {
    const w = compareCost({
      lines: demoShaped(),
      rules: RULES,
      target: { kind: "service", name: "orders-service" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    expect(w.byCurrency["USD"]).toMatchObject({ current: 70, previous: 70, change: 0 });
    expect(w.services).toEqual(["orders-service"]);
  });

  test("movers are ranked by the size of the change, at most 10, the rest counted", () => {
    const lines: CostLine[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(
        line({
          chargeDay: "2026-11-20",
          billedCost: i + 1,
          serviceName: `svc-${String(i).padStart(2, "0")}`,
          tags: tagged("p"),
        }),
      );
    }
    lines.push(
      line({ chargeDay: "2026-11-01", billedCost: 100, serviceName: "gone", tags: tagged("p") }),
    );
    const w = compareCost({
      lines,
      rules: RULES,
      target: { kind: "product", name: "p" },
      range: RANGE,
      previous: prev,
      nowMs: NOW,
    });
    const usd = w.byCurrency["USD"];
    expect(usd?.movers).toHaveLength(10);
    expect(usd?.movers[0]).toMatchObject({ part: "gone", change: -100, service: null });
    expect(usd?.movers[1]).toMatchObject({ part: "svc-11", change: 12 });
    expect(usd?.moversTruncated).toBe(3);
  });

  test("a range that ends before the provisional days has no provisional marker", () => {
    const w = compareCost({
      lines: demoShaped(),
      rules: RULES,
      target: { kind: "product", name: "checkout" },
      range: prev,
      previous: previousRange(prev),
      nowMs: NOW,
    });
    expect(w.provisionalFrom).toBeNull();
  });
});
