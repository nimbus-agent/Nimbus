import { describe, expect, test } from "bun:test";

import { tagOf } from "./cost-line.ts";
import type { CostRates } from "./cost-rate-price.ts";
import { jenkinsBuildLines } from "./jenkins-build-lines.ts";

const NO_RATE: CostRates = { ratePerMinute: null, currency: "USD", keyedRates: [] };
const CENT: CostRates = { ratePerMinute: 0.01, currency: "USD", keyedRates: [] };
const T = Date.UTC(2026, 10, 2, 9); // 2026-11-02 09:00 UTC

/** A documentation-shaped build; `timestamp` and `duration` are milliseconds. */
const build = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 1,
  timestamp: T,
  duration: 120_000,
  builtOn: "linux-1",
  result: "SUCCESS",
  building: false,
  ...over,
});
const job = (builds: unknown[], fullName = "team/app") => ({ fullName, builds });
const key = (l?: { tags: Readonly<Record<string, string>> }) => tagOf(l?.tags ?? {}, "rate_key");

describe("jenkinsBuildLines", () => {
  test("milliseconds: 120000 ms is 2 minutes, priced and identified by job and agent", () => {
    const r = jenkinsBuildLines("ci.acme.test", "2026-11", [job([build()])], CENT);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      source: "jenkins_billing",
      provider: "jenkins",
      billingAccountId: "ci.acme.test",
      subAccountId: "team/app",
      subAccountName: "team/app",
      repo: "team/app",
      resourceName: "linux-1",
      skuId: "build_minutes",
      consumedUnit: "minute",
      consumedQuantity: 2,
      chargeDay: "2026-11-02",
      billedCost: 0.02,
      priced: true,
    });
    expect(key(r.lines[0])).toBe("agent:linux-1");
  });

  test("the charge day is the day the build ended, across midnight", () => {
    const late = Date.UTC(2026, 10, 2, 23, 50);
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [job([build({ timestamp: late, duration: 20 * 60_000 })])],
      CENT,
    );
    expect(r.lines[0]?.chargeDay).toBe("2026-11-03");
    expect(r.lines[0]?.consumedQuantity).toBe(20);
  });

  test("a present empty builtOn is the built-in node, with its own key", () => {
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [job([build({ builtOn: "" }), build({ number: 2, builtOn: "  " })])],
      CENT,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.resourceName).toBe("built-in");
    expect(key(r.lines[0])).toBe("agent:built-in");
    expect(r.lines[0]?.consumedQuantity).toBe(4);
  });

  test("a missing or non-string builtOn (a Pipeline build) names no agent: key default, resource unknown, default rate", () => {
    const rates: CostRates = { ...CENT, keyedRates: [["agent:built-in", 0.5]] };
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [
        job([
          build({ builtOn: undefined }),
          build({ number: 2, builtOn: 7 }),
          build({ number: 3, builtOn: null }),
        ]),
      ],
      rates,
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.resourceName).toBe("unknown");
    expect(key(r.lines[0])).toBe("default");
    expect(r.lines[0]?.billedCost).toBe(0.06);
  });

  test("an agent rate wins, others fall back to the default, none is unpriced", () => {
    const rates: CostRates = { ...CENT, keyedRates: [["agent:big", 0.05]] };
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [job([build({ builtOn: "big" }), build({ number: 2 })])],
      rates,
    );
    const byAgent = new Map(r.lines.map((l) => [l.resourceName, l.billedCost]));
    expect(byAgent.get("big")).toBe(0.1);
    expect(byAgent.get("linux-1")).toBe(0.02);
    const none = jenkinsBuildLines("h", "2026-11", [job([build()])], NO_RATE);
    expect(none.lines[0]).toMatchObject({ billedCost: 0, effectiveCost: null, priced: false });
    expect(key(none.lines[0])).toBe("agent:linux-1");
  });

  test("a build keeps its agent key so a rate added later re-prices it", () => {
    const later: CostRates = { ...NO_RATE, keyedRates: [["agent:linux-1", 0.03]] };
    expect(jenkinsBuildLines("h", "2026-11", [job([build()])], later).lines[0]?.billedCost).toBe(
      0.06,
    );
  });

  test("a repeated (job, number) counts once; the same number in another job is separate", () => {
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [job([build(), build()]), job([build()], "team/other")],
      CENT,
    );
    expect(r.builds).toBe(2);
    expect(r.lines.map((l) => l.consumedQuantity)).toEqual([2, 2]);
  });

  test("running, no-duration, unreadable and out-of-month builds are dropped and counted", () => {
    const r = jenkinsBuildLines(
      "h",
      "2026-11",
      [
        job([
          build({ building: true, number: 2 }),
          build({ duration: undefined, number: 3 }),
          build({ duration: -5, number: 4 }),
          build({ timestamp: "x", number: 5 }),
          build({ number: "six" }),
          "junk",
          build({ timestamp: Date.UTC(2026, 9, 1), number: 7 }),
          build({ timestamp: Date.UTC(2026, 10, 25), number: 8 }),
        ]),
      ],
      CENT,
      "2026-11-20",
    );
    expect(r.lines).toHaveLength(0);
    expect(r.dropped).toEqual({ unfinished: 2, bad_duration: 4, outside_month: 2 });
  });
});
