import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "./history-line.ts";
import {
  COMMENT_MARKER_PREFIX,
  formatCondensedGateSummary,
  formatPrComment,
} from "./pr-comment-formatter.ts";
import type { SurfaceComparison } from "./threshold-comparator.ts";

function fakeLine(runner: HistoryLine["runner"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "abc-123",
    timestamp: "2026-04-29T05:00:00Z",
    runner,
    os_version: "ubuntu-24.04.1",
    nimbus_git_sha: "deadbeef",
    bun_version: "1.3.11",
    surfaces: {},
  };
}

describe("formatPrComment", () => {
  test("starts with the per-runner marker so we can find + edit it", () => {
    const out = formatPrComment([], fakeLine("gha-ubuntu"), null);
    expect(out.startsWith(`<!-- ${COMMENT_MARKER_PREFIX}:gha-ubuntu -->`)).toBe(true);
  });

  test("first-run case: previous=null, renders 'no delta available yet' notice", () => {
    const comparisons: SurfaceComparison[] = [
      { surfaceId: "S1", metric: "p95_ms", status: { kind: "no-baseline", current: 800 } },
    ];
    const out = formatPrComment(comparisons, fakeLine("gha-ubuntu"), null);
    expect(out).toContain("First run on this runner");
    expect(out).toContain("no delta available yet");
  });

  test("with previous: header includes previous run sha", () => {
    const previous = { ...fakeLine("gha-ubuntu"), nimbus_git_sha: "cafef00d" };
    const out = formatPrComment([], fakeLine("gha-ubuntu"), previous);
    expect(out).toContain("cafef00d");
  });

  test("renders absolute-fail row with the measured + threshold values", () => {
    const out = formatPrComment(
      [
        {
          surfaceId: "S1",
          metric: "p95_ms",
          status: { kind: "absolute-fail", measured: 12_000, threshold: 10_000 },
        },
      ],
      fakeLine("gha-ubuntu"),
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("absolute-fail");
    expect(out).toContain("12000");
    expect(out).toContain("10000");
    expect(out).toContain("12000 > 10000");
  });

  test("absolute-fail for floor metric renders `<` instead of `>`", () => {
    const out = formatPrComment(
      [
        {
          surfaceId: "S6-drive",
          metric: "throughput_per_sec",
          status: { kind: "absolute-fail", measured: 40, threshold: 60 },
        },
      ],
      fakeLine("gha-ubuntu"),
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("absolute-fail");
    expect(out).toContain("40 < 60");
    expect(out).not.toContain("40 > 60");
  });

  test("renders delta-fail with delta percentage", () => {
    const out = formatPrComment(
      [
        {
          surfaceId: "S2-a",
          metric: "p95_ms",
          status: { kind: "delta-fail", previous: 50, current: 65, deltaPct: 30, floorPct: 25 },
        },
      ],
      fakeLine("gha-ubuntu"),
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("delta-fail");
    expect(out).toContain("+30.0%");
  });

  test("skipped rows render with their reason", () => {
    const out = formatPrComment(
      [
        {
          surfaceId: "S6-drive",
          metric: "throughput_per_sec",
          status: { kind: "skipped", reason: "tbd-c2" },
        },
        { surfaceId: "S3", metric: "p95_ms", status: { kind: "skipped", reason: "stub" } },
      ],
      fakeLine("gha-ubuntu"),
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("tbd-c2");
    expect(out).toContain("stub");
  });

  test("pass row renders with deltaPct when previous is given", () => {
    const previous = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S1: { samples_count: 100, p95_ms: 80 } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S1", metric: "p95_ms", status: { kind: "pass" } }],
      { ...fakeLine("gha-ubuntu"), surfaces: { S1: { samples_count: 100, p95_ms: 84 } } },
      previous,
    );
    expect(out).toMatch(/S1.*84.*\+5\.0%/s);
    expect(out).toContain("pass");
  });
});

describe("formatCondensedGateSummary", () => {
  test("includes only gate-class surfaces and omits trend/reference rows", () => {
    const out = formatCondensedGateSummary(
      [
        { surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } },
        { surfaceId: "S2-b", metric: "p95_ms", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "p95_ms", status: { kind: "skipped", reason: "trend-only" } },
        {
          surfaceId: "S9",
          metric: "tokens_per_sec",
          status: { kind: "skipped", reason: "reference-only" },
        },
      ],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("S2-a");
    expect(out).toContain("S2-b");
    expect(out).not.toContain("S1");
    expect(out).not.toContain("S9");
  });

  test("renders a /dev/bench dashboard link line", () => {
    const out = formatCondensedGateSummary(
      [{ surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } }],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("/dev/bench");
    expect(out).toMatch(/\[.*dashboard.*\]\(.*dev\/bench.*\)/i);
  });

  test("marks a gate-class failure with a fail glyph", () => {
    const out = formatCondensedGateSummary(
      [
        {
          surfaceId: "S2-a",
          metric: "p95_ms",
          status: { kind: "absolute-fail", measured: 300, threshold: 200 },
        },
      ],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("S2-a");
    expect(out).toContain("❌");
  });

  test("reports an all-clear line when every gate-class surface passes", () => {
    const out = formatCondensedGateSummary(
      [
        { surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } },
        { surfaceId: "S2-b", metric: "p95_ms", status: { kind: "pass" } },
      ],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("All 2 gate-class surfaces passed");
  });

  test("renders an empty-gate-set note when no gate-class surface is present", () => {
    const out = formatCondensedGateSummary(
      [{ surfaceId: "S1", metric: "p95_ms", status: { kind: "skipped", reason: "trend-only" } }],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("No gate-class surfaces evaluated");
  });

  test("renders delta-fail, no-baseline, and a skipped gate-class S8 cell", () => {
    const out = formatCondensedGateSummary(
      [
        {
          surfaceId: "S2-a",
          metric: "p95_ms",
          status: { kind: "delta-fail", previous: 50, current: 200, deltaPct: 300, floorPct: 25 },
        },
        { surfaceId: "S2-b", metric: "p95_ms", status: { kind: "no-baseline", current: 42 } },
        {
          surfaceId: "S8-l50-b1",
          metric: "throughput_per_sec",
          status: { kind: "skipped", reason: "tbd-c2" },
        },
      ],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("❌"); // delta-fail glyph
    expect(out).toContain("+300.0%"); // delta-fail percent
    expect(out).toContain("S2-b"); // no-baseline row rendered
    expect(out).toContain("S8-l50-b1"); // gate-class S8 cell rendered (skipped arm)
  });

  test("floor-metric gate cell: '<' op on absolute-fail and a correctly-signed delta-fail", () => {
    // S8 cells are gate-class throughput (floor metric). absolute-fail uses '<'
    // (smaller is worse); a throughput-drop delta-fail stores a NEGATIVE deltaPct
    // and must render "-30.0%", not a malformed "+-30.0%".
    const out = formatCondensedGateSummary(
      [
        {
          surfaceId: "S8-l50-b1",
          metric: "throughput_per_sec",
          status: { kind: "absolute-fail", measured: 40, threshold: 60 },
        },
        {
          surfaceId: "S8-l50-b8",
          metric: "throughput_per_sec",
          status: { kind: "delta-fail", previous: 100, current: 70, deltaPct: -30, floorPct: 25 },
        },
      ],
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("40 < 60"); // floor metric → '<' operator branch
    expect(out).toContain("-30.0%"); // signed negative delta-fail
    expect(out).not.toContain("+-"); // the sign-prefix bug must be gone
  });
});
