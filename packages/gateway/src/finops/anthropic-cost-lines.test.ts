// Fixtures are DOCUMENTATION-SHAPED (Anthropic's Cost API reference for `/v1/organizations/cost_report`), not
// recorded live responses.
import { describe, expect, test } from "bun:test";

import { anthropicCostLines, centsToDollars } from "./anthropic-cost-lines.ts";

const result = (over: Record<string, unknown> = {}) => ({
  amount: "123.78912",
  context_window: "0-200k",
  cost_type: "tokens",
  currency: "USD",
  description: "Claude Opus 5.5 Usage - Input Tokens",
  inference_geo: "global",
  model: "claude-opus-5-5",
  service_tier: "standard",
  speed: "standard",
  token_type: "uncached_input_tokens",
  workspace_id: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
  ...over,
});
const bucket = (day: string, results: unknown[]) => ({
  starting_at: `${day}T00:00:00Z`,
  ending_at: `${day}T23:59:59Z`,
  results,
});

describe("centsToDollars", () => {
  test("moves the decimal point on the string: exact, with sign, padding and no float noise", () => {
    expect(centsToDollars("12345.678")).toBe(123.45678);
    expect(centsToDollars("123.45")).toBe(1.2345);
    expect(centsToDollars("5")).toBe(0.05);
    expect(centsToDollars("0")).toBe(0);
    expect(centsToDollars("-0.5")).toBe(-0.005);
    expect(centsToDollars("-0")).toBe(0);
    expect(centsToDollars("41280.000000")).toBe(412.8);
    // Dividing the parsed cents adds float noise; moving the point on the string does not.
    expect(1.1 / 100).not.toBe(0.011);
    expect(centsToDollars("1.1")).toBe(0.011);
    for (const bad of ["", "1e3", "12.3.4", "abc", " 1 2", "0x10", "Infinity"]) {
      expect(centsToDollars(bad), bad).toBeNull();
    }
  });
});

describe("anthropicCostLines", () => {
  test("a token cost becomes one line in USD per workspace, description and model", () => {
    const { lines, rows, dropped } = anthropicCostLines(
      [bucket("2026-11-20", [result()])],
      "2026-11",
    );
    expect(rows).toBe(1);
    expect(dropped).toEqual({ malformed: 0, outside_month: 0 });
    expect(lines).toEqual([
      {
        source: "anthropic_billing",
        provider: "anthropic",
        billingAccountId: "anthropic",
        billingPeriod: "2026-11",
        chargeDay: "2026-11-20",
        subAccountId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
        subAccountName: null,
        serviceName: "anthropic",
        serviceCategory: null,
        regionId: null,
        resourceId: null,
        resourceName: null,
        skuId: "Claude Opus 5.5 Usage - Input Tokens",
        chargeCategory: "usage",
        billedCost: 1.2378912,
        effectiveCost: 1.2378912,
        currency: "USD",
        tags: { cost_type: "tokens", service_tier: "standard" },
        repo: null,
        workflow: null,
        model: "claude-opus-5-5",
        importId: "anthropic_billing:anthropic:2026-11",
      },
    ]);
  });

  test("the default workspace is a null sub-account; a non-token cost has no model", () => {
    const { lines } = anthropicCostLines(
      [
        bucket("2026-11-20", [
          result({ workspace_id: null }),
          result({
            cost_type: "web_search",
            model: null,
            description: "Web Search",
            service_tier: null,
          }),
        ]),
      ],
      "2026-11",
    );
    expect(lines.map((l) => [l.subAccountId, l.model, l.tags])).toEqual([
      [null, "claude-opus-5-5", { cost_type: "tokens", service_tier: "standard" }],
      ["wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ", null, { cost_type: "web_search" }],
    ]);
  });

  test("the same day and grain across pages is summed", () => {
    const { lines } = anthropicCostLines(
      [
        bucket("2026-11-20", [result({ amount: "100" })]),
        bucket("2026-11-20", [result({ amount: "50" })]),
      ],
      "2026-11",
    );
    expect(lines.map((l) => l.billedCost)).toEqual([1.5]);
  });

  test("malformed rows, rows outside the month or after lastDay are dropped and counted", () => {
    const { lines, rows, dropped } = anthropicCostLines(
      [
        bucket("2026-11-20", [
          result({ amount: 12.5 }),
          result({ amount: "1e3" }),
          result({ currency: null }),
          result({ description: null }),
          result({ workspace_id: 3 }),
          null,
        ]),
        { starting_at: "later", results: [result()] },
        bucket("2026-10-31", [result()]),
        bucket("2026-11-21", [result()]),
      ],
      "2026-11",
      "2026-11-20",
    );
    expect(lines).toEqual([]);
    expect(rows).toBe(9);
    expect(dropped).toEqual({ malformed: 7, outside_month: 2 });
  });

  test("a negative amount is a credit; a row with no cost type or tier carries no such tag", () => {
    const { lines } = anthropicCostLines(
      [
        bucket("2026-11-20", [
          result({
            amount: "-300",
            description: "Credit",
            model: null,
            cost_type: null,
            service_tier: null,
            currency: "usd",
          }),
        ]),
      ],
      "2026-11",
    );
    expect(lines.map((l) => [l.chargeCategory, l.billedCost, l.tags, l.currency])).toEqual([
      ["credit", -3, {}, "USD"],
    ]);
  });
});
