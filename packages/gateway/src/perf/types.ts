export const S8_LENGTHS = [50, 500, 5000] as const;
export type S8Length = (typeof S8_LENGTHS)[number];

export const S8_BATCHES = [1, 8, 32, 64] as const;
export type S8Batch = (typeof S8_BATCHES)[number];

export type S8SurfaceId = `S8-l${S8Length}-b${S8Batch}`;

export type BenchSurfaceId =
  | "S1"
  | "S2-a"
  | "S2-b"
  | "S2-c"
  | "S3"
  | "S4"
  | "S5"
  | "S6-drive"
  | "S6-gmail"
  | "S6-github"
  | "S7-a"
  | "S7-b"
  | "S7-c"
  | S8SurfaceId
  | "S9"
  | "S10"
  | "S11-a"
  | "S11-b";

export type RunnerKind =
  | "reference-m1air"
  | "gha-ubuntu"
  | "gha-macos"
  | "gha-windows"
  | "local-dev";

export type CorpusTier = "small" | "medium" | "large";

export type BenchResultKind = "latency" | "throughput" | "rss";

export interface BenchRunOptions {
  runs: number;
  runner: RunnerKind;
  corpus?: CorpusTier;
}

export interface BenchSurfaceResult {
  surfaceId: BenchSurfaceId;
  samplesCount: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  throughputPerSec?: number;
  tokensPerSec?: number;
  firstTokenMs?: number;
  rssBytesP95?: number;
  rawSamples?: number[];
  busyRetries?: number;
}
