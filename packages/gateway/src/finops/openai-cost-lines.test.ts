// Fixtures are DOCUMENTATION-SHAPED (OpenAI's reference schema for `/v1/organization/costs`), not recorded live
// responses.
import { describe, expect, test } from "bun:test";

import { openaiCostLines, openaiLineItemModel } from "./openai-cost-lines.ts";

const NOV20 = Date.UTC(2026, 10, 20) / 1000;
const NOV21 = Date.UTC(2026, 10, 21) / 1000;

const result = (over: Record<string, unknown> = {}) => ({
  object: "organization.costs.result",
  amount: { value: 1.5, currency: "usd" },
  line_item: "gpt-6.2-astra, input",
  project_id: "proj_checkout",
  api_key_id: null,
  quantity: 1000,
  quantity_unit: "tokens",
  user_id: null,
  api_source: null,
  ...over,
});
const bucket = (start: number, results: unknown[]) => ({
  object: "bucket",
  start_time: start,
  end_time: start + 86_400,
  results,
});

describe("openaiLineItemModel", () => {
  test("the model is the first part, or the second after a cost-kind prefix", () => {
    expect(openaiLineItemModel("gpt-6.2-astra, input")).toBe("gpt-6.2-astra");
    expect(openaiLineItemModel("fine-tuning, gpt-4o-mini-2024-07-18, training")).toBe(
      "gpt-4o-mini-2024-07-18",
    );
    expect(openaiLineItemModel("fine-tuning")).toBeNull();
    expect(openaiLineItemModel("web search tool calls")).toBe("web search tool calls");
  });
});

describe("openaiCostLines", () => {
  test("a model line item with a project becomes one usage line in USD", () => {
    const { lines, rows, dropped } = openaiCostLines([bucket(NOV20, [result()])], "2026-11");
    expect(rows).toBe(1);
    expect(dropped).toEqual({ malformed: 0, outside_month: 0 });
    expect(lines).toEqual([
      {
        source: "openai_billing",
        provider: "openai",
        billingAccountId: "openai",
        billingPeriod: "2026-11",
        chargeDay: "2026-11-20",
        subAccountId: "proj_checkout",
        subAccountName: null,
        serviceName: "openai",
        serviceCategory: null,
        regionId: null,
        resourceId: null,
        resourceName: null,
        skuId: "gpt-6.2-astra, input",
        chargeCategory: "usage",
        billedCost: 1.5,
        effectiveCost: 1.5,
        currency: "USD",
        tags: { unit: "tokens" },
        repo: null,
        workflow: null,
        model: "gpt-6.2-astra",
        importId: "openai_billing:openai:2026-11",
      },
    ]);
  });

  test("no project is a null sub-account; a negative amount is a credit", () => {
    const { lines } = openaiCostLines(
      [
        bucket(NOV20, [
          result({ project_id: null }),
          result({ amount: { value: -2, currency: "usd" } }),
        ]),
      ],
      "2026-11",
    );
    expect(lines.map((l) => [l.subAccountId, l.chargeCategory, l.billedCost])).toEqual([
      [null, "usage", 1.5],
      ["proj_checkout", "credit", -2],
    ]);
  });

  test("rows of one day and grain on two pages are summed into one line", () => {
    const pageOne = [bucket(NOV20, [result({ amount: { value: 1, currency: "usd" } })])];
    const pageTwo = [
      bucket(NOV20, [result({ amount: { value: 0.25, currency: "usd" } })]),
      bucket(NOV21, [result()]),
    ];
    const { lines } = openaiCostLines([...pageOne, ...pageTwo], "2026-11");
    expect(lines.map((l) => [l.chargeDay, l.billedCost])).toEqual([
      ["2026-11-20", 1.25],
      ["2026-11-21", 1.5],
    ]);
  });

  test("malformed rows and buckets, rows outside the month or after lastDay are dropped and counted", () => {
    const { lines, rows, dropped } = openaiCostLines(
      [
        bucket(NOV20, [
          result({ amount: { value: "1", currency: "usd" } }),
          result({ amount: { value: Number.NaN, currency: "usd" } }),
          result({ amount: null }),
          result({ line_item: null }),
          result({ project_id: 7 }),
          "not a row",
        ]),
        { object: "bucket", start_time: "soon", results: [result()] },
        { object: "bucket" },
        bucket(Date.UTC(2026, 9, 31) / 1000, [result()]),
        bucket(NOV21, [result()]),
      ],
      "2026-11",
      "2026-11-20",
    );
    expect(lines).toEqual([]);
    expect(rows).toBe(10);
    expect(dropped).toEqual({ malformed: 8, outside_month: 2 });
  });
});
