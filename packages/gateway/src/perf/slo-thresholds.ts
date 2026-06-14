import { type BenchSurfaceId, S8_BATCHES, S8_LENGTHS } from "./types.ts";

export interface SloThreshold {
  surfaceId: BenchSurfaceId;
  gateClass: "gate" | "trend" | "reference";
  metric:
    | "p95_ms"
    | "p50_ms"
    | "throughput_per_sec"
    | "rss_bytes_p95"
    | "tokens_per_sec"
    | "first_token_ms";
  refMax?: number;
  ghaMax: number | "tbd-c2" | "skipped";
  noiseFloorPct: number;
  noiseFloorAbs: number;
  noiseFloorAbsUnit: "ms" | "items_per_sec" | "bytes" | "tps";
}

const NON_S8_THRESHOLDS: readonly SloThreshold[] = [
  {
    surfaceId: "S1",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 2_000,
    ghaMax: 10_000,
    noiseFloorPct: 25,
    // S1 is the heaviest cold-start surface; on shared GHA macOS/Windows runners
    // its p95 swings run-to-run between ~617 ms and ~841 ms (a ~224 ms / +36 %
    // spawn-jitter envelope) with no code change. A fixed absolute floor cannot
    // hold this: the floor-as-percentage shrinks as the baseline grows, and the
    // Windows baseline is ~2x macOS (~1123 ms), so 300 ms = only ~26.7 % there —
    // a +38 % no-code-change run (27498114264) delta-failed straight through it.
    // The jitter is a property of the shared runner, not the code, so S1 is
    // classified trend (charted on every runner; gated only on reference-m1air
    // via refMax). The 300 ms floor + 10 000 ms ceiling still apply on gha-ubuntu
    // (low-jitter) and reference-m1air, where they catch a true ~1.5x regression.
    // On macOS / Windows the delta is shown in the PR comment but no longer gates.
    noiseFloorAbs: 300,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-a",
    gateClass: "gate",
    metric: "p95_ms",
    refMax: 30,
    ghaMax: 200,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-b",
    gateClass: "gate",
    metric: "p95_ms",
    refMax: 80,
    ghaMax: 500,
    noiseFloorPct: 25,
    noiseFloorAbs: 10,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-c",
    gateClass: "reference",
    metric: "p95_ms",
    refMax: 300,
    ghaMax: "skipped",
    noiseFloorPct: 25,
    noiseFloorAbs: 25,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S3",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 1_500,
    ghaMax: 7_500,
    noiseFloorPct: 25,
    noiseFloorAbs: 100,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S4",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 500,
    ghaMax: 2_500,
    noiseFloorPct: 25,
    noiseFloorAbs: 50,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S5",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 200,
    ghaMax: 1_000,
    noiseFloorPct: 25,
    noiseFloorAbs: 25,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S11-a",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 300,
    ghaMax: 1_500,
    noiseFloorPct: 40,
    // Sibling of S11-b: warm-CLI latency dominated by fixed process-spawn cost
    // on shared GHA runners. Same irreducible jitter — a no-code-change release
    // commit (#622) swung S11-a p95 +57.7 % on macos-15 (168.5 -> 265.8 ms),
    // past the 40 % floor. The jitter is a runner property, not a code signal,
    // so S11-a is trend-class (charted on every runner, gated only on the
    // reference-m1air run via refMax). The 1 500 ms ceiling + 40 % floor apply
    // there to catch a true >=2x spawn regression.
    noiseFloorAbs: 50,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S11-b",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 50,
    // Warm-CLI-overhead is dominated by a large fixed process-spawn cost on
    // shared GHA runners that does NOT scale with the 50 ms local reference, so
    // ghaMax is a deliberately larger multiple than the ~5x siblings. The CI
    // p95 hovers near 600 ms on macOS/Windows and tipped a hard 600 ceiling at
    // ~607 (a ~1% spawn-jitter flake). Like S1, this spawn jitter is a runner
    // property, not a code signal, so S11-b is classified trend (charted on
    // every runner; gated only on reference-m1air via refMax). The 900 ms
    // ceiling + 40 % floor still apply on gha-ubuntu and reference-m1air to
    // catch a true >=2x spawn regression; on macOS / Windows the delta is shown
    // in the PR comment but no longer gates.
    ghaMax: 900,
    noiseFloorPct: 40,
    noiseFloorAbs: 10,
    noiseFloorAbsUnit: "ms",
  },

  {
    surfaceId: "S6-drive",
    gateClass: "trend",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S6-gmail",
    gateClass: "trend",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S6-github",
    gateClass: "trend",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S7-a",
    gateClass: "trend",
    metric: "rss_bytes_p95",
    ghaMax: "tbd-c2",
    noiseFloorPct: 20,
    noiseFloorAbs: 20 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
  },
  {
    surfaceId: "S7-b",
    gateClass: "trend",
    metric: "rss_bytes_p95",
    ghaMax: "tbd-c2",
    noiseFloorPct: 20,
    noiseFloorAbs: 50 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
  },
  {
    surfaceId: "S7-c",
    gateClass: "reference",
    metric: "rss_bytes_p95",
    ghaMax: "skipped",
    noiseFloorPct: 20,
    noiseFloorAbs: 50 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
  },
  {
    surfaceId: "S9",
    gateClass: "reference",
    metric: "tokens_per_sec",
    ghaMax: "skipped",
    noiseFloorPct: 30,
    noiseFloorAbs: 2,
    noiseFloorAbsUnit: "tps",
  },
  {
    surfaceId: "S10",
    gateClass: "trend",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    noiseFloorPct: 25,
    noiseFloorAbs: 100,
    noiseFloorAbsUnit: "items_per_sec",
  },
];

function buildS8Cells(): readonly SloThreshold[] {
  const out: SloThreshold[] = [];
  for (const length of S8_LENGTHS) {
    for (const batch of S8_BATCHES) {
      out.push({
        surfaceId: `S8-l${length}-b${batch}`,
        gateClass: "gate",
        metric: "throughput_per_sec",
        ghaMax: "tbd-c2",
        noiseFloorPct: 25,
        noiseFloorAbs: 5,
        noiseFloorAbsUnit: "items_per_sec",
      });
    }
  }
  return out;
}

export const SLO_THRESHOLDS: readonly SloThreshold[] = [...NON_S8_THRESHOLDS, ...buildS8Cells()];

export function thresholdsBySurface(): ReadonlyMap<BenchSurfaceId, SloThreshold> {
  return new Map(SLO_THRESHOLDS.map((row) => [row.surfaceId, row]));
}
