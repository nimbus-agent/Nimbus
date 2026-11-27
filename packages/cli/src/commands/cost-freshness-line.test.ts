import { describe, expect, test } from "bun:test";

import { costFreshnessLine } from "./cost-freshness-line.ts";

describe("costFreshnessLine", () => {
  test("the freshness line, with the provisional days and, when a sync could not read, its gap", () => {
    expect(
      costFreshnessLine({ source: "focus", lastDay: "2026-11-25", provisionalFrom: null }),
    ).toBe("Source focus: data up to 2026-11-25\n");
    expect(
      costFreshnessLine({ source: "focus", lastDay: "2026-11-26", provisionalFrom: "2026-11-25" }),
    ).toBe("Source focus: data up to 2026-11-26 (provisional from 2026-11-25)\n");
    expect(
      costFreshnessLine({
        source: "github_billing",
        lastDay: null,
        provisionalFrom: null,
        gap: "cannot read billing for acme\u0007",
      }),
    ).toBe("Source github_billing: data up to none\n  Not synced: cannot read billing for acme\n");
  });
});
