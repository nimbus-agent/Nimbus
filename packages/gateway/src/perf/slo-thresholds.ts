import { type BenchSurfaceId, S8_BATCHES, S8_LENGTHS } from "./types.ts";

export interface SloThreshold {
  surfaceId: BenchSurfaceId;
  metric:
    | "p95_ms"
    | "p50_ms"
    | "throughput_per_sec"
    | "rss_bytes_p95"
    | "tokens_per_sec"
    | "first_token_ms";
  refMax?: number;
  ghaMax: number | "tbd-c2" | "skipped";
  gated: boolean;
  noiseFloorPct: number;
  noiseFloorAbs: number;
  noiseFloorAbsUnit: "ms" | "items_per_sec" | "bytes" | "tps";
  linuxOnlyGate?: true;
}

const NON_S8_THRESHOLDS: readonly SloThreshold[] = [
  {
    surfaceId: "S1",
    metric: "p95_ms",
    refMax: 2_000,
    ghaMax: 10_000,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 200,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-a",
    metric: "p95_ms",
    refMax: 30,
    ghaMax: 200,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-b",
    metric: "p95_ms",
    refMax: 80,
    ghaMax: 500,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 10,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S2-c",
    metric: "p95_ms",
    refMax: 300,
    ghaMax: "skipped",
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 25,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S3",
    metric: "p95_ms",
    refMax: 1_500,
    ghaMax: 7_500,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 100,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S4",
    metric: "p95_ms",
    refMax: 500,
    ghaMax: 2_500,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 50,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S5",
    metric: "p95_ms",
    refMax: 200,
    ghaMax: 1_000,
    gated: true,
    noiseFloorPct: 25,
    noiseFloorAbs: 25,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S11-a",
    metric: "p95_ms",
    refMax: 300,
    ghaMax: 1_500,
    gated: true,
    noiseFloorPct: 40,
    noiseFloorAbs: 50,
    noiseFloorAbsUnit: "ms",
  },
  {
    surfaceId: "S11-b",
    metric: "p95_ms",
    refMax: 50,
    // Warm-CLI-overhead is dominated by a large fixed process-spawn cost on
    // shared GHA runners that does NOT scale with the 50 ms local reference, so
    // ghaMax is a deliberately larger multiple than the ~5x siblings. The CI
    // p95 hovers near 600 ms on macOS/Windows and tipped a hard 600 ceiling at
    // ~607 (a ~1% spawn-jitter flake). With this row's own 40% declared noise
    // floor (600 x 1.4 ≈ 840), 900 sits just past the noise envelope: durable
    // against re-flake while still catching a true >=2x spawn regression.
    ghaMax: 900,
    gated: true,
    noiseFloorPct: 40,
    noiseFloorAbs: 10,
    noiseFloorAbsUnit: "ms",
  },

  {
    surfaceId: "S6-drive",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    gated: false,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S6-gmail",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    gated: false,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S6-github",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    gated: false,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  },
  {
    surfaceId: "S7-a",
    metric: "rss_bytes_p95",
    ghaMax: "tbd-c2",
    gated: false,
    noiseFloorPct: 20,
    noiseFloorAbs: 20 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
    linuxOnlyGate: true,
  },
  {
    surfaceId: "S7-b",
    metric: "rss_bytes_p95",
    ghaMax: "tbd-c2",
    gated: false,
    noiseFloorPct: 20,
    noiseFloorAbs: 50 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
    linuxOnlyGate: true,
  },
  {
    surfaceId: "S7-c",
    metric: "rss_bytes_p95",
    ghaMax: "skipped",
    gated: false,
    noiseFloorPct: 20,
    noiseFloorAbs: 50 * 1024 * 1024,
    noiseFloorAbsUnit: "bytes",
    linuxOnlyGate: true,
  },
  {
    surfaceId: "S9",
    metric: "tokens_per_sec",
    ghaMax: "skipped",
    gated: false,
    noiseFloorPct: 30,
    noiseFloorAbs: 2,
    noiseFloorAbsUnit: "tps",
  },
  {
    surfaceId: "S10",
    metric: "throughput_per_sec",
    ghaMax: "tbd-c2",
    gated: false,
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
        metric: "throughput_per_sec",
        ghaMax: "tbd-c2",
        gated: false,
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
