// Phase 7, slice 8: unpriced usage is named beside the money in every cost view, and never added to it.
import { describe, expect, test } from "bun:test";

import type { CostLine } from "./cost-line.ts";
import type { CostReportModel } from "./cost-report-model.ts";
import { parseCostTemplate, renderCostTemplate } from "./cost-template.ts";
import { rateHintOf, unpricedBySource, unpricedText } from "./cost-unpriced.ts";
import { type CostViewInput, costFreshness, productView } from "./cost-views.ts";

const RANGE = { fromDay: "2026-11-01", toDay: "2026-11-30", label: "November" };
const NOW = Date.parse("2026-11-28T12:00:00Z");

function line(over: Partial<CostLine> = {}): CostLine {
  return {
    source: "gitlab_billing",
    provider: "gitlab",
    billingAccountId: "acme",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-20",
    subAccountId: "acme/web",
    subAccountName: null,
    serviceName: "GitLab CI",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: "compute_minutes",
    chargeCategory: "usage",
    billedCost: 0,
    effectiveCost: null,
    currency: "USD",
    tags: { product: "checkout", rate_key: "default" },
    repo: "acme/web",
    workflow: null,
    model: null,
    importId: "sync",
    consumedQuantity: 100,
    consumedUnit: "minute",
    priced: false,
    ...over,
  };
}

function input(lines: CostLine[]): CostViewInput {
  return {
    lines,
    rules: [],
    range: RANGE,
    nowMs: NOW,
    empty: false,
    lastDays: [
      { source: "focus", lastDay: "2026-11-20" },
      { source: "gitlab_billing", lastDay: "2026-11-21" },
    ],
    knownCurrencies: ["USD"],
    excludedSources: [],
    notes: [],
    configError: null,
  };
}

describe("unpricedBySource", () => {
  test("sums unpriced quantity per source and unit, inside the range only", () => {
    const m = unpricedBySource(
      [
        line(),
        line({ chargeDay: "2026-11-21", consumedQuantity: 40 }),
        line({ chargeDay: "2026-10-31", consumedQuantity: 999 }),
        line({ priced: true, billedCost: 3, effectiveCost: 3 }),
        line({ consumedUnit: null, consumedQuantity: null }),
      ],
      RANGE,
    );
    expect(m.get("gitlab_billing")).toEqual([
      { unit: "minute", quantity: 140, lines: 2 },
      { unit: "unit", quantity: 0, lines: 1 },
    ]);
  });

  test("the text names the quantity and where to set the rate", () => {
    expect(unpricedText("gitlab_billing", [{ unit: "minute", quantity: 1240.5, lines: 3 }])).toBe(
      "1,240.5 minute unpriced (set a rate: [cost.gitlab] rate_per_minute)",
    );
    expect(unpricedText("other", [{ unit: "minute", quantity: 2, lines: 1 }])).toBe(
      "2 minute unpriced",
    );
    expect(rateHintOf("constructor")).toBeUndefined();
  });
});

describe("the views", () => {
  test("an unpriced line adds no money, and its source's freshness row names it", () => {
    const priced = line({
      source: "focus",
      provider: "aws",
      priced: true,
      billedCost: 10,
      consumedQuantity: null,
      consumedUnit: null,
    });
    const v = productView(input([priced, line()]));
    expect(v.byCurrency["USD"]?.total).toBe(10);
    const gl = v.freshness.find((f) => f.source === "gitlab_billing");
    expect(gl?.unpriced).toEqual([{ unit: "minute", quantity: 100, lines: 1 }]);
    expect(gl?.rateHint).toBe("[cost.gitlab] rate_per_minute");
    expect(v.freshness.find((f) => f.source === "focus")?.unpriced).toBeUndefined();
  });

  test("freshness without lines carries no unpriced entry", () => {
    const rows = costFreshness({ lastDays: input([]).lastDays, nowMs: NOW });
    expect(rows.every((r) => r.unpriced === undefined)).toBe(true);
  });

  test("the report's {freshness} names the unpriced minutes, escaped for the channel", () => {
    const m = {
      freshness: [
        {
          source: "gitlab_billing",
          lastDay: "2026-11-21",
          provisionalFrom: null,
          unpriced: [{ unit: "<b>min</b>", quantity: 100, lines: 1 }],
        },
      ],
    } as unknown as CostReportModel;
    const tpl = parseCostTemplate("{freshness}");
    const text = renderCostTemplate(
      tpl,
      { ...baseModel(), ...m },
      {
        kind: "gmail",
        format: "html",
        breakdown: "list",
        maxChars: 10_000,
      },
    ).text;
    // The channel escaper makes markup inert with look-alike characters (as for every other value).
    expect(text).toContain("gitlab_billing: data up to 2026-11-21; 100 ‹b›min‹/b› unpriced");
    expect(text).toContain("set a rate: [cost.gitlab] rate_per_minute");
    expect(text).not.toContain("<b>");
  });
});

function baseModel(): CostReportModel {
  return {
    name: "r",
    scope: {},
    range: RANGE,
    previous: { fromDay: "2026-10-01", toDay: "2026-10-31", label: "October" },
    weekStart: null,
    byCurrency: {},
    provisionalFrom: null,
    freshness: [],
    empty: false,
    configError: null,
    command: "nimbus cost report r",
  };
}

describe("unpricedText in a report", () => {
  test("each unit is escaped on its own, so a long list is never cut short", () => {
    const units = [
      "compute-minute-linux-shared",
      "compute-minute-linux-dedicated",
      "compute-minute-windows-shared",
      "compute-minute-macos-dedicated",
    ].map((unit) => ({ unit, quantity: 1, lines: 1 }));
    const text = unpricedText("gitlab_billing", units, (s) => s.slice(0, 128));
    expect(text).toContain("compute-minute-macos-dedicated unpriced (set a rate:");
  });
});
