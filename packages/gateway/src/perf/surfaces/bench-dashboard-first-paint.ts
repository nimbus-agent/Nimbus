import type { BenchRunOptions } from "../types.ts";

export const S3_STUB_REASON = "renderer instrumentation pending (Tauri perf marks)";

export async function runDashboardFirstPaintOnce(
  _opts: BenchRunOptions,
  _runOpts: Record<string, unknown> = {},
): Promise<number[]> {
  return [];
}
