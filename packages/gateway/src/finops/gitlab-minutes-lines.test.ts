import { describe, expect, test } from "bun:test";

import type { CostLine } from "./cost-line.ts";
import type { CostRates } from "./cost-rate-price.ts";
import {
  type GitlabMinutesInput,
  gitlabMinutesLines,
  gitlabObservedDay,
} from "./gitlab-minutes-lines.ts";

const NO_RATE: CostRates = { ratePerMinute: null, currency: "USD", runnerRates: [] };
const CENT: CostRates = { ratePerMinute: 0.01, currency: "USD", runnerRates: [] };

function run(over: Partial<GitlabMinutesInput>): ReturnType<typeof gitlabMinutesLines> {
  return gitlabMinutesLines({
    account: "acme",
    month: "2026-11",
    observedDay: "2026-11-02",
    fetched: [],
    stored: [],
    rates: CENT,
    ...over,
  });
}

/** Per (project, day), the stored quantity: what the month holds after a sync. */
const held = (lines: readonly CostLine[]): Record<string, number> =>
  Object.fromEntries(
    [...lines]
      .sort((a, b) =>
        `${a.subAccountId}${a.chargeDay}` < `${b.subAccountId}${b.chargeDay}` ? -1 : 1,
      )
      .map((l) => [`${l.subAccountId ?? ""}@${l.chargeDay}`, l.consumedQuantity ?? 0]),
  );

/** One sync after another: each sync's output is the next one's stored lines. */
function days(
  steps: readonly { day: string; totals: Record<string, number>; rates?: CostRates }[],
): CostLine[] {
  let stored: readonly CostLine[] = [];
  for (const s of steps) {
    stored = run({
      observedDay: s.day,
      stored,
      rates: s.rates ?? CENT,
      fetched: Object.entries(s.totals).map(([projectFullPath, minutes]) => ({
        projectFullPath,
        minutes,
      })),
    }).lines;
  }
  return [...stored];
}

describe("gitlabMinutesLines: the daily delta", () => {
  test("a first sync puts the whole month-to-date total on the observed day", () => {
    const { lines } = run({ fetched: [{ projectFullPath: "acme/web", minutes: 100 }] });
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l).toMatchObject({
      source: "gitlab_billing",
      provider: "gitlab",
      billingAccountId: "acme",
      billingPeriod: "2026-11",
      chargeDay: "2026-11-02",
      subAccountId: "acme/web",
      repo: "acme/web",
      serviceName: "GitLab CI",
      skuId: "compute_minutes",
      consumedQuantity: 100,
      consumedUnit: "minute",
      billedCost: 1,
      effectiveCost: 1,
      priced: true,
      tags: { rate_key: "default", gitlab_deployment: "gitlab.com" },
    });
  });

  test("the next day stores only the difference, and the month's total equals GitLab's", () => {
    const lines = days([
      { day: "2026-11-02", totals: { "acme/web": 100, "acme/api": 40 } },
      { day: "2026-11-03", totals: { "acme/web": 130, "acme/api": 40 } },
    ]);
    expect(held(lines)).toEqual({
      "acme/api@2026-11-02": 40,
      "acme/web@2026-11-02": 100,
      "acme/web@2026-11-03": 30,
    });
  });

  test("a missed day lands its minutes on the next synced day", () => {
    const lines = days([
      { day: "2026-11-02", totals: { "acme/web": 100 } },
      { day: "2026-11-05", totals: { "acme/web": 160 } },
    ]);
    expect(held(lines)).toEqual({ "acme/web@2026-11-02": 100, "acme/web@2026-11-05": 60 });
  });

  test("a second sync on the same day replaces that day (100 then 150 is 150, never 250)", () => {
    const lines = days([
      { day: "2026-11-02", totals: { "acme/web": 100 } },
      { day: "2026-11-02", totals: { "acme/web": 150 } },
    ]);
    expect(held(lines)).toEqual({ "acme/web@2026-11-02": 150 });
  });

  test("a drop walks back over several days, never below 0, and is noted", () => {
    const before = days([
      { day: "2026-11-02", totals: { "acme/web": 80 } },
      { day: "2026-11-03", totals: { "acme/web": 180 } },
    ]);
    const r = run({
      observedDay: "2026-11-04",
      stored: before,
      fetched: [{ projectFullPath: "acme/web", minutes: 30 }],
    });
    // 180 held; the total is now 30: lower day 3 (100) to 0 and day 2 (80) by the remaining 50.
    expect(held(r.lines)).toEqual({ "acme/web@2026-11-02": 30 });
    expect(r.restated).toEqual([{ project: "acme/web", minutes: 150 }]);
    expect(r.lines[0]?.billedCost).toBeCloseTo(0.3, 9);
  });

  test("a stored project missing from the fetch keeps its lines", () => {
    const before = days([{ day: "2026-11-02", totals: { "acme/web": 100, "acme/gone": 20 } }]);
    const r = run({
      observedDay: "2026-11-03",
      stored: before,
      fetched: [{ projectFullPath: "acme/web", minutes: 100 }],
    });
    expect(held(r.lines)).toEqual({ "acme/gone@2026-11-02": 20, "acme/web@2026-11-02": 100 });
  });

  test("a project with no new minutes writes no line, and with no rate every line is unpriced", () => {
    expect(run({ fetched: [{ projectFullPath: "acme/web", minutes: 0 }] }).lines).toEqual([]);
    const [l] = run({
      rates: NO_RATE,
      fetched: [{ projectFullPath: "acme/web", minutes: 5 }],
    }).lines;
    expect(l).toMatchObject({
      billedCost: 0,
      effectiveCost: null,
      priced: false,
      consumedQuantity: 5,
    });
  });

  test("a closed month is observed on its last day", () => {
    expect(gitlabObservedDay("2026-11", "2026-12-03")).toBe("2026-11-30");
    expect(gitlabObservedDay("2026-02", "2026-03-01")).toBe("2026-02-28");
    expect(gitlabObservedDay("2026-11", "2026-11-17")).toBe("2026-11-17");
  });
});
