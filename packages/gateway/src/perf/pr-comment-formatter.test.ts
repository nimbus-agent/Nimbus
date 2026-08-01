import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "./history-line.ts";
import {
  COMMENT_MARKER_PREFIX,
  composePrCommentBody,
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

  test("each metric reads its OWN history field, not p95_ms", () => {
    // One surface carrying a DIFFERENT value per field: if the metric→field map
    // mis-routed, a row would print another field's number.
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: {
        S1: {
          samples_count: 10,
          p50_ms: 11,
          p95_ms: 99,
          throughput_per_sec: 55,
          rss_bytes_p95: 22,
          tokens_per_sec: 33,
          first_token_ms: 44,
        },
      },
    };
    const out = formatPrComment(
      [
        { surfaceId: "S1", metric: "p50_ms", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "throughput_per_sec", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "rss_bytes_p95", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "tokens_per_sec", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "first_token_ms", status: { kind: "pass" } },
      ],
      current,
      null,
    );
    expect(out).toContain("| S1 | p50_ms | — | 11 | — | ✅ pass |");
    expect(out).toContain("| S1 | throughput_per_sec | — | 55 | — | ✅ pass |");
    expect(out).toContain("| S1 | rss_bytes_p95 | — | 22 | — | ✅ pass |");
    expect(out).toContain("| S1 | tokens_per_sec | — | 33 | — | ✅ pass |");
    expect(out).toContain("| S1 | first_token_ms | — | 44 | — | ✅ pass |");
    // the p95_ms value must not leak into any of the four rows
    expect(out).not.toContain("99");
  });

  test("a recorded surface missing the requested metric renders an em dash, not 'undefined'", () => {
    // A stub surface is written with samples_count only — the metric field is absent.
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S3: { samples_count: 0, stub_reason: "connector-unavailable" } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S3", metric: "p95_ms", status: { kind: "skipped", reason: "stub" } }],
      current,
      current,
    );
    expect(out).toContain("| S3 | p95_ms | — | — | — | ⏭ skipped (stub) |");
    expect(out).not.toContain("undefined");
  });

  test("a baseline artifact whose metric is not a number degrades to an em dash", () => {
    // `readBaseline` in bench-ci.ts does an unvalidated `JSON.parse(last) as HistoryLine`
    // on a downloaded artifact, so a legacy/corrupt line can carry a non-number here.
    // A literal cast through `unknown` — not `JSON.parse`, whose `any` return would erase the
    // deliberately non-numeric `p95_ms` from the type checker (the repo forbids `any`).
    const previous = {
      schema_version: 2,
      run_id: "old-1",
      timestamp: "2026-04-01T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04.1",
      nimbus_git_sha: "cafef00d",
      bun_version: "1.3.11",
      surfaces: { S1: { samples_count: 100, p95_ms: "n/a" } },
    } as unknown as HistoryLine;
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S1: { samples_count: 100, p95_ms: 80 } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S1", metric: "p95_ms", status: { kind: "pass" } }],
      current,
      previous,
    );
    // previous cell + delta both degrade; the current cell is unaffected
    expect(out).toContain("| S1 | p95_ms | — | 80 | — | ✅ pass |");
    expect(out).not.toContain("n/a");
  });

  test("a million-plus value renders in exponential form, not as a wall of digits", () => {
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S5: { samples_count: 10, rss_bytes_p95: 268_435_456 } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S5", metric: "rss_bytes_p95", status: { kind: "pass" } }],
      current,
      null,
    );
    expect(out).toContain("2.68e+8");
    expect(out).not.toContain("268435456");
  });

  test("a fractional value is rendered to exactly two decimals", () => {
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S4: { samples_count: 10, p95_ms: 1234.5 } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S4", metric: "p95_ms", status: { kind: "pass" } }],
      current,
      null,
    );
    expect(out).toContain("| S4 | p95_ms | — | 1234.50 | — | ✅ pass |");
  });

  test("delta-fail with a negative deltaPct renders '-30.0%', never '+-30.0%'", () => {
    // A throughput floor breach stores a NEGATIVE deltaPct; the sign prefix must
    // not be applied on top of the minus sign the formatter already produces.
    const out = formatPrComment(
      [
        {
          surfaceId: "S8-l50-b8",
          metric: "throughput_per_sec",
          status: { kind: "delta-fail", previous: 100, current: 70, deltaPct: -30, floorPct: 25 },
        },
      ],
      fakeLine("gha-ubuntu"),
      fakeLine("gha-ubuntu"),
    );
    expect(out).toContain("-30.0%");
    expect(out).not.toContain("+-");
  });

  test("an improvement against the baseline renders a negative delta", () => {
    const previous: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S1: { samples_count: 100, p95_ms: 100 } },
    };
    const current: HistoryLine = {
      ...fakeLine("gha-ubuntu"),
      surfaces: { S1: { samples_count: 100, p95_ms: 80 } },
    };
    const out = formatPrComment(
      [{ surfaceId: "S1", metric: "p95_ms", status: { kind: "pass" } }],
      current,
      previous,
    );
    expect(out).toContain("| S1 | p95_ms | 100 | 80 | -20.0% | ✅ pass |");
    expect(out).not.toContain("+-20.0%");
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

describe("composePrCommentBody", () => {
  test("keeps the upsert marker on line 1 and splices the condensed summary above the full table", () => {
    const body = composePrCommentBody(
      [
        { surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } },
        { surfaceId: "S1", metric: "p95_ms", status: { kind: "skipped", reason: "trend-only" } },
      ],
      fakeLine("gha-ubuntu"),
      null,
    );
    // marker must be the very first line — upsertComment matches via startsWith
    expect(body.startsWith(`<!-- ${COMMENT_MARKER_PREFIX}:gha-ubuntu -->`)).toBe(true);
    // condensed gate-class summary + dashboard link are present
    expect(body).toContain("Gate-class summary");
    expect(body).toContain("/dev/bench");
    // condensed summary sits ABOVE the full per-surface table
    expect(body.indexOf("Gate-class summary")).toBeLessThan(
      body.indexOf("| Surface | Metric | Previous"),
    );
    // the full table is still rendered
    expect(body).toContain("Performance benchmarks");
  });
});
