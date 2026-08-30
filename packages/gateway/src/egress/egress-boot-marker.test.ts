// packages/gateway/src/egress/egress-boot-marker.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendBootMarker } from "./egress-boot-marker.ts";
import { ALL_NONE_COVERAGE, type CoverageVector, THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { coverageForWindow, listEgress, verifyEgressChain } from "./egress-verify.ts";

// Typed explicitly as `CoverageVector` (rather than left to `as const` inference) so a class added
// to `COVERAGE_CLASSES` without a matching entry here is a compile error, not a silently
// unparseable marker at runtime.
const RICH_COVERAGE: CoverageVector = {
  browser: "per-call",
  chatops: "per-call",
  task: "per-call",
  mcp: "per-call",
  http: "per-call",
  session: "per-call",
  sync: "per-run",
  model: "per-call",
  peer: "per-call",
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("boot marker", () => {
  test("appends one marker row carrying the serialized vector in the hashed source_id", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("boot");
    expect(rows[0]?.method).toBe("egress.boot");
    expect(rows[0]?.sourceId).toBe(
      "browser=per-run;chatops=per-call;http=per-call;mcp=per-call;model=per-call;peer=none;session=none;sync=per-run;task=per-call",
    );
    // The marker participates in the chain like any other row.
    expect(verifyEgressChain(db).ok).toBe(true);
  });

  test("coverageForWindow with NO covering marker claims nothing", () => {
    expect(coverageForWindow(db, { until: 500 })).toEqual(ALL_NONE_COVERAGE);
  });

  test("coverageForWindow whose start IS covered merges the covering marker with in-window ones, weakest wins", () => {
    // A marker covering `since` (400 <= 500) plus a richer one booted mid-window (1000, within
    // (500, 3000]) — the window's start is observed, so the merge may proceed.
    appendBootMarker(db, THIS_BINARY_COVERAGE, 400);
    appendBootMarker(db, RICH_COVERAGE, 1_000);
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual({
      browser: "per-run", // the covering marker's per-run beats rich's per-call
      chatops: "per-call", // both non-none
      task: "per-call", // both non-none
      mcp: "per-call", // both non-none
      http: "per-call", // both non-none
      session: "none", // the covering marker (400) saw nothing here
      sync: "per-run", // both per-run
      model: "per-call", // both non-none
      peer: "none",
    });
  });

  test("fix 4: a window whose start is NOT covered by any marker claims nothing, even though a later marker boots mid-window", () => {
    // The exact motivating bug: since=500, the first marker ever is at t=1000 — the [500, 1000)
    // slice had nothing observing it. Previously this was reported as COVERED (task: "per-call")
    // because the old implementation merged every marker at-or-before `until`, ignoring `since`
    // entirely. Corrected: since the window's start (500) has no covering marker AND the caller
    // explicitly asked for that `since`, the window claims nothing.
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    appendBootMarker(db, RICH_COVERAGE, 2_000);
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual(ALL_NONE_COVERAGE);
  });

  test("fix 4 reconciliation: a bounded window after a stronger marker is no longer capped by an old, weaker marker", () => {
    // The RECORDED (now-fixed) known limitation: coverage used to merge over the ENTIRE ledger
    // history, so an old task-only marker permanently dragged down every later window. Here a weak
    // marker boots at t=100, then a richer one supersedes it at t=1000; a window starting AT the
    // richer marker must see ONLY the richer marker's coverage, not the weak one's.
    appendBootMarker(db, THIS_BINARY_COVERAGE, 100);
    appendBootMarker(db, RICH_COVERAGE, 1_000);
    expect(coverageForWindow(db, { since: 1_000, until: 2_000 })).toEqual(RICH_COVERAGE);
  });

  test("fix 4 unbounded carve-out: an omitted `since` on a fresh ledger (first row IS the marker) is determinate, not indeterminate", () => {
    // `nimbus egress`/`nimbus prove` with no --since must not become permanently indeterminate just
    // because `since` defaults to 0 and no marker literally covers timestamp 0. Nothing precedes
    // the very first marker here, so the omitted-`since` carve-out applies.
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    expect(coverageForWindow(db, {})).toEqual(THIS_BINARY_COVERAGE);
  });

  test("fix 4 unbounded carve-out does NOT apply when a real row precedes the very first marker ever written", () => {
    // Unlike the fresh-ledger case above, here a real dispatch happened BEFORE any marker ever
    // booted — a genuine, unobserved gap. The omitted-`since` window must not paper over it.
    appendEgressEntry(db, {
      timestamp: 10,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    expect(coverageForWindow(db, {})).toEqual(ALL_NONE_COVERAGE);
  });

  test("fix 1: a boot marker written after 1500 preceding rows is still found (not silently paginated away)", () => {
    // Regression for the bug where `coverageForWindow` read boot markers via `listEgress(db, {})`,
    // which defaults `limit` to 1000 and orders oldest-first — so on a ledger past 1000 rows, a
    // marker appended later (like this one, row #1501) was invisible and coverage silently claimed
    // nothing. The fix queries `egress_ledger` directly for `method = BOOT_MARKER_METHOD`, with no
    // pagination limit, so the marker is found regardless of how many rows precede it.
    for (let i = 0; i < 1_500; i += 1) {
      appendEgressEntry(db, {
        timestamp: i,
        sourceType: "task",
        sourceId: "s",
        destination: "email",
        method: "email.send",
        payloadSummary: "{}",
        hitlStatus: "approved",
        resultStatus: "authorized",
      });
    }
    appendBootMarker(db, THIS_BINARY_COVERAGE, 2_000);
    // Query with `since` at the marker's own timestamp so the covering-marker lookup (not the
    // in-window listing) is what must find it.
    expect(coverageForWindow(db, { since: 2_000, until: 3_000 })).toEqual(THIS_BINARY_COVERAGE);
  });

  test("a non-boot row whose method collides with the boot-marker method does NOT contribute coverage", () => {
    // Regression: `coverageForWindow`'s marker queries used to filter on `method = ?` alone, so
    // ANY ledger row carrying `method='egress.boot'` — regardless of its own `source_type` — was
    // treated as a coverage claim. Append a `task` row that reuses the boot-marker method string
    // and assert it is ignored: the window must stay indeterminate (all-none), exactly as if no
    // marker existed at all.
    //
    // The `source_id` below MUST be a COMPLETE, parseable coverage vector (every COVERAGE_CLASSES
    // member, `mcp`/`chatops`/`browser` included). If it were missing a class, `parseCoverage`
    // would return null and the window would read all-none for THAT reason — the assertion would
    // still pass even if the `source_type = 'boot'` filter regressed, which is precisely the
    // regression this test exists to catch.
    appendEgressEntry(db, {
      timestamp: 500,
      sourceType: "task",
      sourceId:
        "browser=per-call;chatops=per-call;http=per-call;mcp=per-call;model=per-call;peer=per-call;session=per-call;sync=per-call;task=per-call",
      destination: "local",
      method: "egress.boot",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    expect(coverageForWindow(db, { since: 100, until: 1_000 })).toEqual(ALL_NONE_COVERAGE);
  });

  test("an unparseable marker forces all-none via the merge, even when the window's start IS covered", () => {
    // A marker this binary cannot parse: written by a NEWER gateway, or corrupted. Skipping it
    // would let the OTHER (valid, richer) marker vouch for the window — overstating coverage. A
    // covering prior marker is included so this test exercises the MERGE-time poisoning, not the
    // (unrelated) start-not-covered branch fixed above.
    appendBootMarker(db, THIS_BINARY_COVERAGE, 100);
    appendEgressEntry(db, {
      timestamp: 1_000,
      sourceType: "boot",
      sourceId: "task=teleportation;wat=none",
      destination: "local",
      method: "egress.boot",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    appendBootMarker(db, RICH_COVERAGE, 2_000);
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual(ALL_NONE_COVERAGE);
  });
});
