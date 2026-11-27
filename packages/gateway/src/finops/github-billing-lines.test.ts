// Fixtures are DOCUMENTATION-SHAPED (GitHub's REST reference schema for the billing usage report), not a
// recorded live response.
import { describe, expect, test } from "bun:test";

import { githubBillingLines } from "./github-billing-lines.ts";

const row = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-20T00:00:00Z",
  product: "actions",
  sku: "actions_linux",
  quantity: 120,
  unitType: "minutes",
  pricePerUnit: 0.008,
  grossAmount: 0.96,
  discountAmount: 0,
  netAmount: 0.96,
  organizationName: "Acme",
  repositoryName: "acme/checkout",
  ...over,
});

describe("githubBillingLines", () => {
  test("an Actions row with a repository becomes one usage line in USD for the org", () => {
    const { lines, dropped } = githubBillingLines("Acme", "2026-11", [row()]);
    expect(dropped).toEqual({ malformed: 0, outside_month: 0, other_org: 0 });
    expect(lines).toEqual([
      {
        source: "github_billing",
        provider: "github",
        billingAccountId: "acme",
        billingPeriod: "2026-11",
        chargeDay: "2026-11-20",
        subAccountId: null,
        subAccountName: null,
        serviceName: "actions",
        serviceCategory: null,
        regionId: null,
        resourceId: null,
        resourceName: null,
        skuId: "actions_linux",
        chargeCategory: "usage",
        billedCost: 0.96,
        effectiveCost: 0.96,
        currency: "USD",
        tags: { unit_type: "minutes" },
        repo: "acme/checkout",
        workflow: null,
        model: null,
        importId: "github_billing:acme:2026-11",
      },
    ]);
  });

  test("a row with no repository (Copilot) and a discount: the net amount is the cost", () => {
    const { lines } = githubBillingLines("acme", "2026-11", [
      row({
        product: "copilot",
        sku: "copilot_for_business",
        repositoryName: undefined,
        grossAmount: 19,
        discountAmount: 19,
        netAmount: 0,
        unitType: "user-months",
        date: "2026-11-01",
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ repo: null, billedCost: 0, chargeDay: "2026-11-01" });
  });

  test("rows of the same day, product, SKU and repository are summed into one line", () => {
    const { lines } = githubBillingLines("acme", "2026-11", [
      row({ netAmount: 0.5, quantity: 10 }),
      row({ netAmount: 0.25, quantity: 5 }),
      row({ repositoryName: "acme/web", netAmount: 1 }),
      row({ date: "2026-11-21", netAmount: 2 }),
    ]);
    expect(lines.map((l) => [l.chargeDay, l.repo, l.billedCost])).toEqual([
      ["2026-11-20", "acme/checkout", 0.75],
      ["2026-11-20", "acme/web", 1],
      ["2026-11-21", "acme/checkout", 2],
    ]);
  });

  test("malformed rows, rows outside the month and another org's rows are dropped and counted", () => {
    const { lines, dropped } = githubBillingLines("acme", "2026-11", [
      row({ netAmount: Number.NaN }),
      row({ netAmount: "1" }),
      row({ product: "" }),
      row({ sku: "x".repeat(300) }),
      row({ date: "yesterday" }),
      "not a row",
      null,
      row({ date: "2026-10-31T00:00:00Z" }),
      row({ organizationName: "evil-corp" }),
      row({ organizationName: undefined }),
    ]);
    expect(dropped).toEqual({ malformed: 7, outside_month: 1, other_org: 1 });
    expect(lines).toHaveLength(1); // the row with no organizationName is the requested org's
  });

  test("a body that is not a list yields no line", () => {
    expect(githubBillingLines("acme", "2026-11", { usageItems: [] }).lines).toEqual([]);
    expect(githubBillingLines("acme", "2026-11", undefined).lines).toEqual([]);
  });

  test("a date-time with no zone is the date as written; a day after lastDay is outside the month", () => {
    const { lines, dropped } = githubBillingLines(
      "acme",
      "2026-11",
      [
        row({ date: "2026-11-01T00:00:00" }),
        row({ date: "2026-11-20T23:30:00-05:00", repositoryName: "acme/web" }),
        row({ date: "2026-11-28", repositoryName: "acme/late" }),
      ],
      "2026-11-27",
    );
    expect(lines.map((l) => [l.chargeDay, l.repo])).toEqual([
      ["2026-11-01", "acme/checkout"],
      ["2026-11-21", "acme/web"],
    ]);
    expect(dropped.outside_month).toBe(1);
  });
});
