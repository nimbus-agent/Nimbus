import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { BenchSurfaceId, RunnerKind } from "./types.ts";

export interface HistoryLineSurface {
  samples_count: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  max_ms?: number;
  throughput_per_sec?: number;
  tokens_per_sec?: number;
  first_token_ms?: number;
  rss_bytes_p95?: number;
  raw_samples?: number[];
  busy_retries?: number;
  stub_reason?: string;
}

export interface HistoryLine {
  schema_version: 2;
  run_id: string;
  timestamp: string;
  runner: RunnerKind;
  os_version: string;
  nimbus_git_sha: string;
  bun_version: string;
  surfaces: Partial<Record<BenchSurfaceId, HistoryLineSurface>>;
  reference_protocol_compliant?: boolean;
  incomplete?: true;
  incomplete_reason?: string;
}

export function appendHistoryLine(path: string, line: HistoryLine): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
}
