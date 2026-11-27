import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities, type SyncCapabilityDeps } from "../sync/sync-capabilities.ts";
import type { CostLine } from "./cost-line.ts";
import { readCostLines } from "./cost-line-store.ts";
import {
  decodeGithubBillingCursor,
  encodeCostSyncCursor,
  encodeGithubBillingCursor,
  readCostSourceGaps,
} from "./cost-source-gaps.ts";
import { costFreshness } from "./cost-views.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

function storeCursor(cursor: string | null): void {
  upsertSchedulerRegistration(db, "github_billing", 86_400_000, NOW, false);
  updateSchedulerState(db, {
    serviceId: "github_billing",
    cursor,
    intervalMs: 86_400_000,
    lastSyncAt: NOW,
    nextSyncAt: NOW + 86_400_000,
    status: "ok",
    errorMsg: null,
    consecutiveFailures: 0,
    paused: false,
  });
}

const line = (day: string): CostLine => ({
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
  billedCost: 1,
  effectiveCost: 1,
  currency: "USD",
  tags: {},
  repo: "acme/checkout",
  workflow: null,
  model: null,
  importId: "github_billing:acme:2026-11",
});

describe("the GitHub billing cursor and its gaps", () => {
  test("round-trips; a foreign, empty or broken cursor reads as nothing", () => {
    const c = {
      gaps: { acme: "no access" },
      synced: { web: "2026-11-27" },
      pending: { acme: ["2026-10"] },
    };
    expect(decodeGithubBillingCursor(encodeGithubBillingCursor(c))).toEqual(c);
    for (const raw of [null, "", "nimbus-gha1:abc", "nimbus-ghb1:%%%", "nimbus-ghb1:bnVsbA"]) {
      expect(decodeGithubBillingCursor(raw), String(raw)).toEqual({
        gaps: {},
        synced: {},
        pending: {},
      });
    }
  });

  test("readCostSourceGaps reads the stored cursor; none stored or no gap means no entry", () => {
    expect(readCostSourceGaps(db).size).toBe(0);
    storeCursor(
      encodeGithubBillingCursor({ gaps: {}, synced: { acme: "2026-11-27" }, pending: {} }),
    );
    expect(readCostSourceGaps(db).size).toBe(0);
    storeCursor(
      encodeGithubBillingCursor({ gaps: { b: "gap b", a: "gap a" }, synced: {}, pending: {} }),
    );
    expect([...readCostSourceGaps(db)]).toEqual([["github_billing", ["gap a", "gap b"]]]);
  });

  test("the freshness shows a gap on the source's row, or adds a row for a source with no line", () => {
    const gaps = new Map([["github_billing", ["cannot read billing for acme"]]]);
    expect(costFreshness({ lastDays: [], nowMs: NOW, sourceGaps: gaps })).toEqual([
      {
        source: "github_billing",
        lastDay: null,
        provisionalFrom: null,
        gap: "cannot read billing for acme",
      },
    ]);
    const withDay = costFreshness({
      lastDays: [
        { source: "focus", lastDay: "2026-11-01" },
        { source: "github_billing", lastDay: "2026-11-26" },
      ],
      nowMs: NOW,
      sourceGaps: gaps,
    });
    expect(withDay.map((r) => [r.source, r.gap])).toEqual([
      ["focus", undefined],
      ["github_billing", "cannot read billing for acme"],
    ]);
    expect(Object.hasOwn(withDay[0] ?? {}, "gap")).toBe(false);
  });
});

describe("gaps across every cost sync (slice 6)", () => {
  test("each service's cursor is read with its own prefix; a cursor with another prefix reads as nothing", () => {
    const put = (service: string, cursor: string) => {
      upsertSchedulerRegistration(db, service, 86_400_000, NOW, false);
      updateSchedulerState(db, {
        serviceId: service,
        cursor,
        intervalMs: 86_400_000,
        lastSyncAt: NOW,
        nextSyncAt: NOW + 86_400_000,
        status: "ok",
        errorMsg: null,
        consecutiveFailures: 0,
        paused: false,
      });
    };
    const c = (gap: string) => ({ gaps: { org: gap }, synced: {}, pending: {} });
    put("openai_billing", encodeCostSyncCursor("nimbus-oai1:", c("openai gap")));
    put("anthropic_billing", encodeCostSyncCursor("nimbus-ant1:", c("anthropic gap")));
    // A cursor written with GitHub's prefix under another service is not that service's.
    put("github_billing", encodeCostSyncCursor("nimbus-oai1:", c("misfiled")));
    expect([...readCostSourceGaps(db)]).toEqual([
      ["openai_billing", ["openai gap"]],
      ["anthropic_billing", ["anthropic gap"]],
    ]);
  });
});

describe("github_billing end to end in the store", () => {
  test("the capability writes its own lines, and connector removal erases them", () => {
    const deps = {
      vault: {} as SyncCapabilityDeps["vault"],
      db,
      depth: "full",
    } as SyncCapabilityDeps;
    const caps = buildSyncCapabilities(deps, "github_billing");
    const r = caps.replaceCostLinesForMonth(
      { provider: "github", billingAccountId: "acme", month: "2026-11" },
      [line("2026-11-20")],
    );
    expect(r.inserted).toBe(1);
    // The source is bound: a line claiming another source is refused.
    expect(() =>
      caps.replaceCostLinesForMonth(
        { provider: "github", billingAccountId: "acme", month: "2026-11" },
        [{ ...line("2026-11-21"), source: "focus" }],
      ),
    ).toThrow("cannot write a line of focus");
    const all = () => readCostLines(db, { fromDay: "2026-01-01", toDay: "2026-12-31" });
    expect(all()).toHaveLength(1);
    new LocalIndex(db).removeConnectorIndexData("github_billing");
    expect(all()).toEqual([]);
  });
});
