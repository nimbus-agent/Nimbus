import { describe, expect, test } from "bun:test";

import { bqRow } from "../../test/helpers/gcp-billing-fake.ts";
import { type GcpRawRow, gcpBillingLines } from "./gcp-billing-lines.ts";

const raw = (over = {}): GcpRawRow => bqRow(over) as GcpRawRow;

describe("gcpBillingLines", () => {
  test("netted cost, labels, quantity and category", () => {
    const { lines, unreadable } = gcpBillingLines(
      [
        raw({ cost: "10", credits: "-3", labels_json: '[{"key":"team","value":"web"}]' }),
        raw({ cost_type: "adjustment", cost: "-1", credits: null, quantity: null }),
        raw({ cost_type: "rounding_error", cost: "0.01" }),
        raw({ project_id: null, project_name: null, region: null, sku_id: null, service: null }),
      ],
      "2026-11",
    );
    expect(unreadable).toBe(0);
    expect(lines[0]).toMatchObject({ billedCost: 7, effectiveCost: 7, tags: { team: "web" } });
    expect(lines[1]).toMatchObject({ chargeCategory: "adjustment", billedCost: -1 });
    expect(lines[2]?.chargeCategory).toBe("adjustment");
    expect(lines[3]).toMatchObject({
      subAccountId: null,
      regionId: null,
      serviceName: "Unknown service",
      skuId: "N2 Core running in Americas",
    });
  });

  test("a row that cannot be read is counted, never guessed", () => {
    const bad = [
      raw({ day: null }),
      raw({ day: "2026-10-31" }),
      raw({ day: "2026-11-99" }),
      raw({ billing_account_id: "" }),
      raw({ currency: null }),
      raw({ cost: null }),
      raw({ cost: "NaN" }),
      raw({ credits: "x" }),
      raw({ labels_json: "not json" }),
      raw({ labels_json: '{"a":1}' }),
      raw({ labels_json: "[1]" }),
      raw({ labels_json: '[{"key":"","value":"x"}]' }),
    ];
    const r = gcpBillingLines(bad, "2026-11");
    expect(r.lines).toHaveLength(0);
    expect(r.unreadable).toBe(bad.length);
  });

  test("a label key named __proto__ is an own tag", () => {
    const { lines } = gcpBillingLines(
      [raw({ labels_json: '[{"key":"__proto__","value":"x"},{"key":"k","value":null}]' })],
      "2026-11",
    );
    expect(Object.keys(lines[0]?.tags ?? {})).toEqual(["__proto__", "k"]);
    expect(lines[0]?.tags["k"]).toBe("");
  });
});
