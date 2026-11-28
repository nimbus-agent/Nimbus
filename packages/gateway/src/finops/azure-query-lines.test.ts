import { describe, expect, test } from "bun:test";

import { AZURE_UNSPECIFIED_SERVICE, azureQueryLines, usageDay } from "./azure-query-lines.ts";

const W = { scope: "subscriptions/s1", month: "2026-11", lastDay: "2026-11-20" };
const cols = (...names: string[]) => names.map((name) => ({ name, type: "String" }));
const std = cols("Cost", "UsageDate", "ServiceName", "ResourceGroupName", "Currency");

describe("azureQueryLines", () => {
  test("columns are mapped by name, whatever their order", () => {
    const r = azureQueryLines(W, [
      {
        columns: cols("Currency", "ResourceGroupName", "ServiceName", "UsageDate", "Cost"),
        rows: [["usd", "RG-One", "Storage", 20261103, 4.5]],
      },
    ]);
    expect(r.kind).toBe("lines");
    if (r.kind !== "lines") return;
    const l = r.lines[0];
    expect(l).toMatchObject({
      source: "azure_billing",
      provider: "azure",
      billingAccountId: "subscriptions/s1",
      subAccountId: "rg-one",
      subAccountName: "RG-One",
      serviceName: "Storage",
      chargeDay: "2026-11-03",
      billedCost: 4.5,
      currency: "USD",
      chargeCategory: "usage",
    });
  });

  test("a missing currency column, or any other required one, is a retry", () => {
    const noCurrency = azureQueryLines(W, [
      { columns: cols("Cost", "UsageDate", "ServiceName"), rows: [[1, 20261103, "S"]] },
    ]);
    expect(noCurrency).toEqual({ kind: "retry", missing: ["Currency"] });
    const none = azureQueryLines(W, [{ columns: [1, null], rows: [] }]);
    expect(none.kind).toBe("retry");
  });

  test("same day and grain are summed; credits are credits; no resource-group column or an empty one is no sub-account", () => {
    const r = azureQueryLines(W, [
      {
        columns: cols("Cost", "UsageDate", "ServiceName", "Currency"),
        rows: [
          [1, "20261103", "", "USD"],
          [2, "2026-11-03T00:00:00", "", "USD"],
          [-3, 20261103, "S", "USD"],
        ],
      },
      { columns: std, rows: [[5, 20261104, "S", "", "EUR"]] },
    ]);
    if (r.kind !== "lines") throw new Error("lines expected");
    expect(r.lines).toHaveLength(3);
    const un = r.lines.find((l) => l.serviceName === AZURE_UNSPECIFIED_SERVICE);
    expect(un?.billedCost).toBe(3);
    expect(un?.subAccountId).toBeNull();
    expect(r.lines.find((l) => l.billedCost === -3)?.chargeCategory).toBe("credit");
    expect(r.lines.find((l) => l.currency === "EUR")?.subAccountName).toBeNull();
  });

  test("unreadable rows are dropped and counted, rows outside the month or after the last day are outside", () => {
    const r = azureQueryLines(W, [
      {
        columns: std,
        rows: [
          "x",
          [1, "nope", "S", "g", "USD"],
          ["1", 20261103, "S", "g", "USD"],
          [1, 20261103, "S", "g", 5],
          [1, 20261103, "x".repeat(300), "g", "USD"],
          [1, 20261030, "S", "g", "USD"],
          [1, 20261121, "S", "g", "USD"],
          [1, 20261120, "S", "g", "USD"],
        ],
      },
    ]);
    if (r.kind !== "lines") throw new Error("lines expected");
    expect(r.rows).toBe(8);
    expect(r.dropped).toEqual({ malformed: 5, outside_month: 2 });
    expect(r.lines).toHaveLength(1);
  });

  test("usageDay", () => {
    expect(usageDay(20261103)).toBe("2026-11-03");
    expect(usageDay("2026-11-03T00:00:00")).toBe("2026-11-03");
    expect(usageDay(20261303)).toBeNull();
    expect(usageDay(1.5)).toBeNull();
    expect(usageDay(null)).toBeNull();
  });
});
