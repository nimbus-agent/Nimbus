// V110 (Phase 7, slice 8): the consumed quantity, the unit and the priced flag on a stored cost line.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type CostLine, type CostLineKey, costLineGrainHash } from "./cost-line.ts";
import { readCostLines, replaceCostLines } from "./cost-line-store.ts";

const KEY: CostLineKey = {
  source: "gitlab_billing",
  provider: "gitlab",
  billingAccountId: "acme",
  billingPeriod: "2026-11",
};
const DAY = "2026-11-03";

function line(over: Partial<CostLine> = {}): CostLine {
  return {
    ...KEY,
    chargeDay: DAY,
    subAccountId: "acme/web",
    subAccountName: null,
    serviceName: "GitLab CI",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: "compute_minutes",
    chargeCategory: "usage",
    billedCost: 1.2,
    effectiveCost: 1.2,
    currency: "USD",
    tags: { rate_key: "default" },
    repo: "acme/web",
    workflow: null,
    model: null,
    importId: "sync",
    consumedQuantity: 120,
    consumedUnit: "minute",
    priced: true,
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

describe("cost-line store, V110 measures", () => {
  test("quantity, unit and priced round-trip", () => {
    const unpriced = line({
      subAccountId: "acme/api",
      billedCost: 0,
      effectiveCost: null,
      priced: false,
    });
    replaceCostLines(db, KEY, [DAY], [line(), unpriced]);
    const back = readCostLines(db, { fromDay: DAY, toDay: DAY });
    expect(back).toHaveLength(2);
    expect(back).toContainEqual(line());
    expect(back).toContainEqual(unpriced);
  });

  test("a line that leaves the measures out is stored priced with no quantity", () => {
    const { consumedQuantity: _q, consumedUnit: _u, priced: _p, ...bare } = line();
    replaceCostLines(db, KEY, [DAY], [bare]);
    const [back] = readCostLines(db, { fromDay: DAY, toDay: DAY });
    expect(back?.consumedQuantity).toBeNull();
    expect(back?.consumedUnit).toBeNull();
    expect(back?.priced).toBe(true);
  });

  test("an unpriced line with a cost is refused, and nothing is written", () => {
    expect(() =>
      replaceCostLines(db, KEY, [DAY], [line({ priced: false, effectiveCost: null })]),
    ).toThrow(/unpriced but carries a cost/);
    expect(() =>
      replaceCostLines(db, KEY, [DAY], [line({ priced: false, billedCost: 0 })]),
    ).toThrow(/unpriced but carries a cost/);
    expect(readCostLines(db, { fromDay: DAY, toDay: DAY })).toEqual([]);
  });

  test("a non-finite quantity or a bad unit is refused", () => {
    expect(() =>
      replaceCostLines(db, KEY, [DAY], [line({ consumedQuantity: Number.NaN })]),
    ).toThrow(/quantity that is not finite/);
    expect(() => replaceCostLines(db, KEY, [DAY], [line({ consumedUnit: "" })])).toThrow(
      /unit that is not 1 to 32/,
    );
    expect(() =>
      replaceCostLines(db, KEY, [DAY], [line({ consumedUnit: "x".repeat(33) })]),
    ).toThrow(/unit that is not 1 to 32/);
  });

  test("a quantity change alone is a restatement, not unchanged", () => {
    replaceCostLines(db, KEY, [DAY], [line()]);
    const r = replaceCostLines(db, KEY, [DAY], [line({ consumedQuantity: 130 })]);
    expect(r).toEqual({ inserted: 0, replaced: 1, unchanged: 0, removed: 0 });
  });

  test("a priced flag change alone is a restatement", () => {
    replaceCostLines(db, KEY, [DAY], [line()]);
    const r = replaceCostLines(
      db,
      KEY,
      [DAY],
      [line({ billedCost: 0, effectiveCost: null, priced: false })],
    );
    expect(r.replaced).toBe(1);
  });

  test("an identical re-sync with measures is unchanged", () => {
    replaceCostLines(db, KEY, [DAY], [line()]);
    expect(replaceCostLines(db, KEY, [DAY], [line()]).unchanged).toBe(1);
  });

  test("the grain hash ignores the measures", () => {
    expect(costLineGrainHash(line({ consumedQuantity: 1, priced: false }))).toBe(
      costLineGrainHash(line()),
    );
  });
});
