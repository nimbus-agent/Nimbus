import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "./history-line.ts";
import { COMMENT_MARKER_PREFIX, formatPrComment } from "./pr-comment-formatter.ts";
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
