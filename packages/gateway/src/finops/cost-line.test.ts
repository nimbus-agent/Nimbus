import { describe, expect, test } from "bun:test";

import { type CostLine, costLineGrainHash, sortedTags } from "./cost-line.ts";

function line(over: Partial<CostLine> = {}): CostLine {
  return {
    source: "focus",
    provider: "aws",
    billingAccountId: "111",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-01",
    subAccountId: null,
    subAccountName: null,
    serviceName: "Amazon S3",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    billedCost: 1,
    effectiveCost: null,
    currency: "USD",
    tags: {},
    repo: null,
    workflow: null,
    model: null,
    importId: "imp-a",
    ...over,
  };
}

describe("sortedTags", () => {
  test("orders the keys and drops a key whose value is missing", () => {
    // External data can carry an explicit `undefined`; the type cannot rule it out at runtime.
    const raw = { b: "2", a: "1", c: undefined } as unknown as Record<string, string>;
    const out = sortedTags(raw);
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(out).toEqual({ a: "1", b: "2" });
  });
});

describe("costLineGrainHash", () => {
  test("tag order does not change the grain; the amount and the day are not part of it", () => {
    const a = line({ tags: { env: "prod", product: "checkout" } });
    const b = line({
      tags: { product: "checkout", env: "prod" },
      billedCost: 9,
      chargeDay: "2026-11-02",
    });
    expect(costLineGrainHash(a)).toBe(costLineGrainHash(b));
    expect(costLineGrainHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the resource id stands for the grain, and the sku only when there is no resource", () => {
    const bySku = line({ skuId: "sku-1" });
    expect(costLineGrainHash(bySku)).not.toBe(costLineGrainHash(line({ skuId: "sku-2" })));
    expect(costLineGrainHash(line({ resourceId: "r-1", skuId: "sku-1" }))).toBe(
      costLineGrainHash(line({ resourceId: "r-1", skuId: "sku-2" })),
    );
    expect(costLineGrainHash(line({ resourceId: "sku-1" }))).toBe(costLineGrainHash(bySku));
  });

  test("a different charge category, repo, workflow or model is a different grain", () => {
    const base = costLineGrainHash(line());
    for (const over of [
      { chargeCategory: "credit" as const },
      { repo: "acme/web" },
      { workflow: "ci" },
      { model: "gpt-x" },
    ]) {
      expect(costLineGrainHash(line(over))).not.toBe(base);
    }
  });
});
