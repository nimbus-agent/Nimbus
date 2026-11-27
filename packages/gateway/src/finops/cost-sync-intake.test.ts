import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import {
  buildLocalOnlySyncCapabilities,
  buildSyncCapabilities,
  type SyncCapabilityDeps,
  unboundSyncCapabilities,
} from "../sync/sync-capabilities.ts";
import type { CostLine } from "./cost-line.ts";
import { readCostLines, replaceCostLines } from "./cost-line-store.ts";
import { CostSyncIntakeError, costSyncDays, ingestSyncedCostLines } from "./cost-sync-intake.ts";

const NOW = Date.UTC(2026, 10, 27, 12); // 2026-11-27
const TARGET = { provider: "github", billingAccountId: "acme", month: "2026-11" };

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

function line(day: string, cost: number, over: Partial<CostLine> = {}): CostLine {
  return {
    source: "github_billing",
    provider: "github",
    billingAccountId: "acme",
    billingPeriod: day.slice(0, 7),
    chargeDay: day,
    subAccountId: null,
    subAccountName: null,
    serviceName: "actions",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: "actions_linux",
    chargeCategory: "usage",
    billedCost: cost,
    effectiveCost: cost,
    currency: "USD",
    tags: {},
    repo: "acme/checkout",
    workflow: null,
    model: null,
    importId: `github_billing:acme:${day.slice(0, 7)}`,
    ...over,
  };
}

const stored = (source = "github_billing") =>
  readCostLines(db, { fromDay: "2026-01-01", toDay: "2026-12-31" })
    .filter((l) => l.source === source)
    .map((l) => [l.chargeDay, l.billedCost]);

describe("costSyncDays", () => {
  test("the current UTC month runs to today; an earlier month is whole; a future one is refused", () => {
    expect(costSyncDays("2026-11", NOW)).toHaveLength(27);
    expect(costSyncDays("2026-11", NOW).at(-1)).toBe("2026-11-27");
    expect(costSyncDays("2026-10", NOW)).toHaveLength(31);
    expect(costSyncDays("2026-02", NOW)).toHaveLength(28);
    expect(costSyncDays("2024-02", NOW)).toHaveLength(29);
    expect(() => costSyncDays("2026-12", NOW)).toThrow("has not started yet");
    for (const bad of ["2026-13", "2026-1", "26-11", "2026-11-01", ""]) {
      expect(() => costSyncDays(bad, NOW), bad).toThrow(CostSyncIntakeError);
    }
    // A UTC day, whatever the machine zone: 23:30 UTC on the last day is still that day.
    expect(costSyncDays("2026-11", Date.UTC(2026, 10, 30, 23, 30)).at(-1)).toBe("2026-11-30");
  });
});

describe("ingestSyncedCostLines", () => {
  test("replaces the month's days, clears a day the sync no longer returns, and is idempotent", () => {
    ingestSyncedCostLines(
      db,
      "github_billing",
      TARGET,
      [line("2026-11-20", 1), line("2026-11-21", 2)],
      NOW,
    );
    expect(stored()).toEqual([
      ["2026-11-20", 1],
      ["2026-11-21", 2],
    ]);
    const again = ingestSyncedCostLines(
      db,
      "github_billing",
      TARGET,
      [line("2026-11-20", 1), line("2026-11-21", 2)],
      NOW,
    );
    expect(again).toMatchObject({ inserted: 0, replaced: 0, unchanged: 2 });
    // A restatement of one day and the other day gone.
    ingestSyncedCostLines(db, "github_billing", TARGET, [line("2026-11-20", 3)], NOW);
    expect(stored()).toEqual([["2026-11-20", 3]]);
  });

  test("an earlier month is replaced whole, and other months and sources are untouched", () => {
    const oct = { ...TARGET, month: "2026-10" };
    ingestSyncedCostLines(db, "github_billing", oct, [line("2026-10-31", 5)], NOW);
    ingestSyncedCostLines(db, "github_billing", TARGET, [line("2026-11-02", 1)], NOW);
    replaceCostLines(
      db,
      { source: "focus", provider: "github", billingAccountId: "acme", billingPeriod: "2026-11" },
      ["2026-11-02"],
      [line("2026-11-02", 9, { source: "focus", importId: "focus:0123456789abcdef" })],
    );
    ingestSyncedCostLines(db, "github_billing", oct, [line("2026-10-01", 4)], NOW);
    expect(stored()).toEqual([
      ["2026-10-01", 4],
      ["2026-11-02", 1],
    ]);
    expect(stored("focus")).toEqual([["2026-11-02", 9]]);
  });

  test("a line of another source, provider, account or month refuses the call and writes nothing", () => {
    for (const bad of [
      line("2026-11-20", 1, { source: "focus" }),
      line("2026-11-20", 1, { provider: "aws" }),
      line("2026-11-20", 1, { billingAccountId: "other" }),
      line("2026-10-20", 1),
    ]) {
      expect(() =>
        ingestSyncedCostLines(db, "github_billing", TARGET, [line("2026-11-01", 1), bad], NOW),
      ).toThrow(CostSyncIntakeError);
    }
    expect(stored()).toEqual([]);
  });
});

describe("the replaceCostLinesForMonth capability", () => {
  const deps = (): SyncCapabilityDeps =>
    ({ vault: {} as SyncCapabilityDeps["vault"], db, depth: "full" }) as SyncCapabilityDeps;

  test("is refused to a service that is not a cost sync, to local-only and to unbound syncables", () => {
    expect(() =>
      buildSyncCapabilities(deps(), "jira").replaceCostLinesForMonth(TARGET, []),
    ).toThrow('replaceCostLinesForMonth is not available to "jira"');
    expect(() =>
      buildLocalOnlySyncCapabilities(deps(), "filesystem").replaceCostLinesForMonth(TARGET, []),
    ).toThrow("local-only syncable");
    expect(() => unboundSyncCapabilities().replaceCostLinesForMonth(TARGET, [])).toThrow(
      "replaceCostLinesForMonth",
    );
    expect(stored()).toEqual([]);
  });
});
