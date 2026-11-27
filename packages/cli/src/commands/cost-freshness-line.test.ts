import { describe, expect, test } from "bun:test";

import { costFreshnessLine, noCostDataText } from "./cost-freshness-line.ts";

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

  test("the no-data refusal still shows what a sync could not read", () => {
    const hint =
      'No cost data imported. Import a FOCUS export with "nimbus cost import <file|dir>".\n';
    expect(noCostDataText(undefined)).toBe(hint);
    expect(
      noCostDataText([
        { source: "focus", lastDay: null, provisionalFrom: null },
        {
          source: "github_billing",
          lastDay: null,
          provisionalFrom: null,
          gap: "cannot read billing for acme",
        },
      ]),
    ).toBe(
      `${hint}Source github_billing: data up to none\n  Not synced: cannot read billing for acme\n`,
    );
  });
});
