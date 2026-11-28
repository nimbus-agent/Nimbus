// V110 (Phase 7, slice 8): the consumed quantity the sources fill, and how merged rows combine it.
import { describe, expect, test } from "bun:test";

import { type CostLine, measureUnit, mergeMeasures } from "./cost-line.ts";
import { parseFocusCsv } from "./focus-csv.ts";
import { githubBillingLines } from "./github-billing-lines.ts";

const measured = (q: number | null, u: string | null): CostLine =>
  ({ consumedQuantity: q, consumedUnit: u }) as CostLine;

describe("mergeMeasures and measureUnit", () => {
  test("two quantities in one unit sum", () => {
    expect(mergeMeasures(measured(2, "minute"), measured(3, "minute"))).toEqual({
      consumedQuantity: 5,
      consumedUnit: "minute",
    });
  });

  test("a row without a quantity makes the merged quantity unknown", () => {
    expect(mergeMeasures(measured(2, "minute"), measured(null, "minute")).consumedQuantity).toBe(
      null,
    );
    expect(mergeMeasures({} as CostLine, measured(2, "minute")).consumedQuantity).toBe(null);
  });

  test("two units are never summed", () => {
    expect(mergeMeasures(measured(2, "minute"), measured(3, "hour"))).toEqual({
      consumedQuantity: null,
      consumedUnit: null,
    });
  });

  test("a unit is trimmed, and an empty or over-long one is none", () => {
    expect(measureUnit(" minute ")).toBe("minute");
    expect(measureUnit("")).toBeNull();
    expect(measureUnit(null)).toBeNull();
    expect(measureUnit("x".repeat(33))).toBeNull();
  });
});

const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargeCategory,ChargePeriodStart,ProviderName,ServiceName,ConsumedQuantity,ConsumedUnit";

describe("FOCUS ConsumedQuantity and ConsumedUnit", () => {
  test("read when present; rows of one grain sum their quantity", () => {
    const csv = [
      HEADER,
      "1,111,USD,Usage,2026-11-01T00:00:00Z,AWS,S3,10,GB-Mo",
      "2,111,USD,Usage,2026-11-01T01:00:00Z,AWS,S3,5,GB-Mo",
    ].join("\n");
    const [l] = parseFocusCsv(csv, { importId: "i" }).lines;
    expect(l?.billedCost).toBe(3);
    expect(l?.consumedQuantity).toBe(15);
    expect(l?.consumedUnit).toBe("GB-Mo");
  });

  test("a blank or non-numeric quantity is none, never a refused row", () => {
    const csv = [HEADER, "1,111,USD,Usage,2026-11-01T00:00:00Z,AWS,S3,lots,"].join("\n");
    const r = parseFocusCsv(csv, { importId: "i" });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.consumedQuantity).toBeNull();
    expect(r.lines[0]?.consumedUnit).toBeNull();
  });

  test("an export without the columns has no quantity", () => {
    const csv = [
      "BilledCost,BillingAccountId,BillingCurrency,ChargeCategory,ChargePeriodStart,ProviderName,ServiceName",
      "1,111,USD,Usage,2026-11-01T00:00:00Z,AWS,S3",
    ].join("\n");
    expect(parseFocusCsv(csv, { importId: "i" }).lines[0]?.consumedQuantity).toBeNull();
  });
});

describe("GitHub billing quantity", () => {
  test("two rows of one grain sum their quantity", () => {
    const item = {
      date: "2026-11-02",
      product: "Actions",
      sku: "linux",
      quantity: 60,
      unitType: "minutes",
      netAmount: 0.48,
      organizationName: "acme",
      repositoryName: "acme/web",
    };
    const { lines } = githubBillingLines("acme", "2026-11", [item, { ...item, quantity: 30 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.consumedQuantity).toBe(90);
    expect(lines[0]?.consumedUnit).toBe("minutes");
  });
});
