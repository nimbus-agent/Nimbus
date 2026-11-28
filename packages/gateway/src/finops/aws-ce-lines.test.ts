import { describe, expect, test } from "bun:test";

import { awsCeLines } from "./aws-ce-lines.ts";

const group = (
  svc: string,
  acct: string,
  unblended: string,
  amortized = unblended,
  unit = "USD",
) => ({
  Keys: [svc, acct],
  Metrics: {
    UnblendedCost: { Amount: unblended, Unit: unit },
    AmortizedCost: { Amount: amortized, Unit: unit },
    UsageQuantity: { Amount: "123", Unit: "Hrs" },
  },
});
const day = (d: string, groups: unknown[], estimated = false) => ({
  TimePeriod: { Start: d, End: d },
  Estimated: estimated,
  Groups: groups,
});

describe("awsCeLines", () => {
  test("a group becomes a line: unblended billed, amortized effective, no quantity, no region or resource", () => {
    const r = awsCeLines(
      "111111111111",
      "2026-11",
      [day("2026-11-02", [group("Amazon S3", "222222222222", "1.5", "1.25")])],
      "imp",
    );
    expect(r.skipped).toBe(0);
    expect(r.days).toEqual(new Set(["2026-11-02"]));
    const l = r.lines[0];
    expect(l).toMatchObject({
      source: "aws_billing",
      provider: "aws",
      billingAccountId: "111111111111",
      billingPeriod: "2026-11",
      chargeDay: "2026-11-02",
      subAccountId: "222222222222",
      serviceName: "Amazon S3",
      billedCost: 1.5,
      effectiveCost: 1.25,
      currency: "USD",
      regionId: null,
      resourceId: null,
    });
    expect(l?.consumedQuantity ?? null).toBeNull();
    expect(l?.consumedUnit ?? null).toBeNull();
  });

  test("zero groups are dropped, a repeated key keeps its first row, estimated is reported", () => {
    const r = awsCeLines(
      "1",
      "2026-11",
      [
        day("2026-11-01", [group("A", "2", "0"), group("B", "2", "3"), group("B", "2", "9")], true),
        day("2026-11-02", []),
      ],
      "imp",
    );
    expect(r.lines.map((l) => l.billedCost)).toEqual([3]);
    expect(r.estimated).toBe(true);
    expect(r.days).toEqual(new Set(["2026-11-01", "2026-11-02"]));
  });

  test("unreadable pieces are counted, never guessed", () => {
    const bad = [
      day("2026-11-01", [
        group("A", "2", "x"),
        group("A", "2", "1", "1", "usd"),
        { Keys: ["only-one"], Metrics: {} },
        { Keys: ["A", ""], Metrics: group("A", "2", "1").Metrics },
        {
          Keys: ["A", "2"],
          Metrics: {
            UnblendedCost: { Amount: "1", Unit: "USD" },
            AmortizedCost: { Amount: "1", Unit: "EUR" },
          },
        },
      ]),
      day("2026-10-31", [group("A", "2", "1")]),
      "nope",
      { TimePeriod: { Start: "2026-11-03" }, Groups: "x" },
    ];
    const r = awsCeLines("1", "2026-11", bad, "imp");
    expect(r.lines).toHaveLength(0);
    expect(r.skipped).toBe(8);
  });
});
