import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "./history-line.ts";
import { SLO_THRESHOLDS, type SloThreshold } from "./slo-thresholds.ts";
import {
  compareAgainstHistory,
  isFailingComparison,
  isFloorMetric,
} from "./threshold-comparator.ts";

function fakeLine(runner: HistoryLine["runner"], surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 1,
    run_id: "test-run",
    timestamp: "2026-04-29T00:00:00Z",
    runner,
    os_version: "test",
    nimbus_git_sha: "abc",
    bun_version: "1.0.0",
    surfaces,
  };
}

describe("compareAgainstHistory", () => {
  test("returns one entry per gated SLO row even when missing from current", () => {
    const current = fakeLine("gha-ubuntu", {});
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    expect(out.length).toBe(SLO_THRESHOLDS.length);
  });

  test("first run on main: previous=null → every gated row → no-baseline", () => {
    const current = fakeLine("gha-ubuntu", { S1: { samples_count: 100, p95_ms: 800 } });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    const s1 = out.find((c) => c.surfaceId === "S1");
    expect(s1?.status).toEqual({ kind: "no-baseline", current: 800 });
  });

  test("absolute-fail when current exceeds ghaMax (UX row)", () => {
    const current = fakeLine("gha-ubuntu", { S1: { samples_count: 100, p95_ms: 12_000 } });
    const previous = fakeLine("gha-ubuntu", { S1: { samples_count: 100, p95_ms: 800 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s1 = out.find((c) => c.surfaceId === "S1");
    expect(s1?.status).toEqual({ kind: "absolute-fail", measured: 12_000, threshold: 10_000 });
  });

  test("S1 cold-start jitter (617→841 ms, +36 %) sits inside the widened 300 ms floor → pass", () => {
    // Regression guard for the run-27487164610 macOS delta-fail: a pure release
    // commit swung S1 p95 from 616.87 to 840.81 ms. With noiseFloorAbs=300 the
    // effective floor is 300/616.87 ≈ 48.6 %, above the +36.3 % swing. If the
    // floor is ever re-tightened to 200 ms (32.4 %), this flips back to delta-fail.
    const current = fakeLine("gha-macos", { S1: { samples_count: 301, p95_ms: 840.81 } });
    const previous = fakeLine("gha-macos", { S1: { samples_count: 301, p95_ms: 616.87 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-macos");
    const s1 = out.find((c) => c.surfaceId === "S1");
    expect(s1?.status).toEqual({ kind: "pass" });
  });

  test("delta-fail when delta > floorPct AND > floorAbs/previous*100", () => {
    const current = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 65 } });
    const previous = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 50 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s2a = out.find((c) => c.surfaceId === "S2-a");
    expect(s2a?.status).toMatchObject({ kind: "delta-fail", previous: 50, current: 65 });
  });

  test("delta-fail floor protects small previous values", () => {
    const current = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 6 } });
    const previous = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 4 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s2a = out.find((c) => c.surfaceId === "S2-a");
    expect(s2a?.status).toEqual({ kind: "pass" });
  });

  test("workload row with ghaMax === 'tbd-c2' resolves to skipped(tbd-c2)", () => {
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 5, throughput_per_sec: 999_999 },
    });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "skipped", reason: "tbd-c2" });
  });

  test("S2-c on gha-ubuntu resolves to skipped(reference-only)", () => {
    const current = fakeLine("gha-ubuntu", {});
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    const s2c = out.find((c) => c.surfaceId === "S2-c");
    expect(s2c?.status).toEqual({ kind: "skipped", reason: "reference-only" });
  });

  test("S7-a on gha-macos resolves to skipped(linux-only-gate)", () => {
    const current = fakeLine("gha-macos", {
      "S7-a": { samples_count: 60, rss_bytes_p95: 100_000_000 },
    });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-macos");
    const s7a = out.find((c) => c.surfaceId === "S7-a");
    expect(s7a?.status).toEqual({ kind: "skipped", reason: "linux-only-gate" });
  });

  test("stub surface (samples_count=0) resolves to skipped(stub)", () => {
    const current = fakeLine("gha-ubuntu", {
      S3: { samples_count: 0, stub_reason: "renderer instrumentation pending" },
    });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    const s3 = out.find((c) => c.surfaceId === "S3");
    expect(s3?.status).toEqual({ kind: "skipped", reason: "stub" });
  });
});

describe("isFloorMetric", () => {
  test("returns true for floor metrics", () => {
    expect(isFloorMetric("throughput_per_sec")).toBe(true);
    expect(isFloorMetric("tokens_per_sec")).toBe(true);
  });

  test("returns false for ceiling metrics", () => {
    expect(isFloorMetric("p95_ms")).toBe(false);
    expect(isFloorMetric("p50_ms")).toBe(false);
    expect(isFloorMetric("rss_bytes_p95")).toBe(false);
    expect(isFloorMetric("first_token_ms")).toBe(false);
  });
});

describe("compareAgainstHistory — floor metrics", () => {
  const floorRow: SloThreshold = {
    surfaceId: "S6-drive",
    metric: "throughput_per_sec",
    refMax: 100,
    ghaMax: 60,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  };

  test("absolute-fail when throughput drops below ghaMax floor", () => {
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 50 },
    });
    const out = compareAgainstHistory(current, null, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "absolute-fail", measured: 50, threshold: 60 });
  });

  test("absolute-pass when throughput is above ghaMax floor (no baseline → no-baseline)", () => {
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 80 },
    });
    const out = compareAgainstHistory(current, null, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "no-baseline", current: 80 });
  });

  test("absolute-pass at exactly the floor (boundary — strict <, not <=)", () => {
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 60 },
    });
    const out = compareAgainstHistory(current, null, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "no-baseline", current: 60 });
  });

  test("delta-fail when throughput drops more than the noise floor; deltaPct stays signed", () => {
    const previous = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 100 },
    });
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 70 },
    });
    const out = compareAgainstHistory(current, previous, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toMatchObject({
      kind: "delta-fail",
      previous: 100,
      current: 70,
      deltaPct: -30,
    });
  });

  test("improvement (throughput rises) is never a delta-fail", () => {
    const previous = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 70 },
    });
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 100 },
    });
    const out = compareAgainstHistory(current, previous, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "pass" });
  });

  test("small drop within the noise floor passes", () => {
    const previous = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 100 },
    });
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 85 },
    });
    const out = compareAgainstHistory(current, previous, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "pass" });
  });

  test("absolute-fail (measured below ghaMax) fires before delta-fail considered", () => {
    const previous = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 70 },
    });
    const current = fakeLine("gha-ubuntu", {
      "S6-drive": { samples_count: 100, throughput_per_sec: 50 },
    });
    const out = compareAgainstHistory(current, previous, [floorRow], "gha-ubuntu");
    const s6 = out.find((c) => c.surfaceId === "S6-drive");
    expect(s6?.status).toEqual({ kind: "absolute-fail", measured: 50, threshold: 60 });
  });
});

describe("compareAgainstHistory — ceiling metrics regression direction", () => {
  test("ceiling-metric improvement (latency drop) does not fail delta", () => {
    const previous = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 100 } });
    const current = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 50 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s2a = out.find((c) => c.surfaceId === "S2-a");
    expect(s2a?.status).toEqual({ kind: "pass" });
  });
});

describe("isFailingComparison", () => {
  test("returns false for any kind when slo.gated === false", () => {
    const slo = SLO_THRESHOLDS.find((r) => r.surfaceId === "S6-drive")!;
    expect(slo.gated).toBe(false);
    expect(
      isFailingComparison(
        {
          surfaceId: "S6-drive",
          metric: "throughput_per_sec",
          status: { kind: "absolute-fail", measured: 999, threshold: 100 },
        },
        slo,
      ),
    ).toBe(false);
  });

  test("returns true only for absolute-fail / delta-fail when gated", () => {
    const slo = SLO_THRESHOLDS.find((r) => r.surfaceId === "S1")!;
    expect(
      isFailingComparison(
        {
          surfaceId: "S1",
          metric: "p95_ms",
          status: { kind: "absolute-fail", measured: 12_000, threshold: 10_000 },
        },
        slo,
      ),
    ).toBe(true);
    expect(
      isFailingComparison(
        {
          surfaceId: "S1",
          metric: "p95_ms",
          status: { kind: "delta-fail", previous: 100, current: 200, deltaPct: 100, floorPct: 25 },
        },
        slo,
      ),
    ).toBe(true);
    expect(
      isFailingComparison({ surfaceId: "S1", metric: "p95_ms", status: { kind: "pass" } }, slo),
    ).toBe(false);
    expect(
      isFailingComparison(
        { surfaceId: "S1", metric: "p95_ms", status: { kind: "no-baseline", current: 100 } },
        slo,
      ),
    ).toBe(false);
    expect(
      isFailingComparison(
        { surfaceId: "S1", metric: "p95_ms", status: { kind: "skipped", reason: "stub" } },
        slo,
      ),
    ).toBe(false);
  });
});
