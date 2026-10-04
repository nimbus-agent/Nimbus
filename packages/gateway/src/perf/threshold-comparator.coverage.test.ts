/**
 * `threshold-comparator.ts` paths the shipped SLO table never exercises: the four metrics no
 * current threshold row uses, a current surface that lacks its metric, a reference-runner row with
 * no `refMax`, a baseline that carries no usable value, and the noise floor of a zero baseline.
 *
 * `compareAgainstHistory` takes the threshold rows as a parameter, so each case builds the row it
 * needs rather than depending on what `SLO_THRESHOLDS` happens to contain today.
 */
import { describe, expect, test } from "bun:test";
import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import type { SloThreshold } from "./slo-thresholds.ts";
import { compareAgainstHistory, effectiveNoiseFloorPct } from "./threshold-comparator.ts";
import type { BenchSurfaceId } from "./types.ts";

function historyWith(surfaceId: BenchSurfaceId, surface: HistoryLineSurface): HistoryLine {
  return {
    schema_version: 2,
    run_id: "r",
    timestamp: "2026-05-01T00:00:00Z",
    runner: "gha-ubuntu",
    os_version: "linux",
    nimbus_git_sha: "sha",
    bun_version: "1.3.0",
    surfaces: { [surfaceId]: surface },
  };
}

function gateRow(metric: SloThreshold["metric"], ghaMax: number): SloThreshold {
  return {
    surfaceId: "S2-a",
    gateClass: "gate",
    metric,
    ghaMax,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "ms",
  };
}

// Every metric carries a DIFFERENT value, so reading the wrong field shows up as a wrong `measured`.
const ALL_METRICS: HistoryLineSurface = {
  samples_count: 10,
  p50_ms: 150,
  p95_ms: 160,
  throughput_per_sec: 170,
  rss_bytes_p95: 2_000,
  tokens_per_sec: 10,
  first_token_ms: 900,
};

describe("compareAgainstHistory — metrics without a shipped threshold row", () => {
  const cases: Array<{ metric: SloThreshold["metric"]; ghaMax: number; measured: number }> = [
    { metric: "p50_ms", ghaMax: 100, measured: 150 },
    { metric: "rss_bytes_p95", ghaMax: 1_000, measured: 2_000 },
    // A floor metric: a value BELOW the threshold is the failure.
    { metric: "tokens_per_sec", ghaMax: 50, measured: 10 },
    { metric: "first_token_ms", ghaMax: 500, measured: 900 },
  ];
  for (const c of cases) {
    test(`${c.metric} is read from its own field and gated against ghaMax`, () => {
      const [cmp] = compareAgainstHistory(
        historyWith("S2-a", ALL_METRICS),
        null,
        [gateRow(c.metric, c.ghaMax)],
        "gha-ubuntu",
      );
      expect(cmp).toEqual({
        surfaceId: "S2-a",
        metric: c.metric,
        status: { kind: "absolute-fail", measured: c.measured, threshold: c.ghaMax },
      });
    });
  }

  test("a floor metric at or above its floor passes into the delta check", () => {
    const compareTo = (previous: number) =>
      compareAgainstHistory(
        historyWith("S2-a", { samples_count: 5, tokens_per_sec: 60 }),
        historyWith("S2-a", { samples_count: 5, tokens_per_sec: previous }),
        [gateRow("tokens_per_sec", 50)],
        "gha-ubuntu",
      )[0]?.status;
    // 60 clears the floor of 50 either way, so the BASELINE decides: a 1.6 % dip is noise, while a
    // 40 % drop from 100 is a regression — which only the delta check can report.
    expect(compareTo(61)).toEqual({ kind: "pass" });
    expect(compareTo(100)).toEqual({
      kind: "delta-fail",
      previous: 100,
      current: 60,
      deltaPct: -40,
      floorPct: 25,
    });
  });
});

describe("compareAgainstHistory — missing values", () => {
  test("a current surface without the metric passes when a baseline exists", () => {
    const [cmp] = compareAgainstHistory(
      historyWith("S2-a", { samples_count: 3, p50_ms: 10 }),
      historyWith("S2-a", { samples_count: 3, p95_ms: 10 }),
      [gateRow("p95_ms", 200)],
      "gha-ubuntu",
    );
    expect(cmp?.status).toEqual({ kind: "pass" });
  });

  test("a baseline surface without the metric, or with a non-positive one, is no baseline", () => {
    const current = historyWith("S2-a", { samples_count: 3, p95_ms: 40 });
    for (const prev of [
      { samples_count: 3, p50_ms: 30 },
      { samples_count: 3, p95_ms: 0 },
      { samples_count: 3, p95_ms: -5 },
    ]) {
      const [cmp] = compareAgainstHistory(
        current,
        historyWith("S2-a", prev),
        [gateRow("p95_ms", 200)],
        "gha-ubuntu",
      );
      expect(cmp?.status).toEqual({ kind: "no-baseline", current: 40 });
    }
  });

  test("a previous LINE that lacks the surface is no baseline either", () => {
    const [cmp] = compareAgainstHistory(
      historyWith("S2-a", { samples_count: 3, p95_ms: 40 }),
      historyWith("S2-b", { samples_count: 3, p95_ms: 30 }),
      [gateRow("p95_ms", 200)],
      "gha-ubuntu",
    );
    expect(cmp?.status).toEqual({ kind: "no-baseline", current: 40 });
  });
});

describe("compareAgainstHistory — reference runner without refMax", () => {
  // `gateRow` sets no `refMax`: on the reference runner this row has no absolute ceiling.
  const row = gateRow("p95_ms", 50);

  test("there is no absolute ceiling, so even a value far above ghaMax is not an absolute-fail", () => {
    const [cmp] = compareAgainstHistory(
      historyWith("S2-a", { samples_count: 3, p95_ms: 120 }),
      null,
      [row],
      "reference-m1air",
    );
    expect(cmp?.status).toEqual({ kind: "no-baseline", current: 120 });
  });

  test("the delta check still runs against the baseline", () => {
    const [cmp] = compareAgainstHistory(
      historyWith("S2-a", { samples_count: 3, p95_ms: 200 }),
      historyWith("S2-a", { samples_count: 3, p95_ms: 100 }),
      [row],
      "reference-m1air",
    );
    expect(cmp?.status).toEqual({
      kind: "delta-fail",
      previous: 100,
      current: 200,
      deltaPct: 100,
      floorPct: 25,
    });
  });
});

describe("effectiveNoiseFloorPct", () => {
  const slo = gateRow("p95_ms", 200);

  test("a zero or negative baseline falls back to the relative floor alone", () => {
    expect(effectiveNoiseFloorPct(slo, 0)).toBe(25);
    expect(effectiveNoiseFloorPct(slo, -10)).toBe(25);
  });

  test("a small positive baseline is governed by the absolute floor", () => {
    // 5 ms of 10 ms is 50 %, above the 25 % relative floor.
    expect(effectiveNoiseFloorPct(slo, 10)).toBe(50);
    expect(effectiveNoiseFloorPct(slo, 1_000)).toBe(25);
  });
});
