import type { BenchRunOptions } from "../types.ts";

export const S5_STUB_REASON = "renderer instrumentation pending (Tauri perf marks)";

export function runHitlPopupOnce(
  _opts: BenchRunOptions,
  _runOpts: Record<string, unknown> = {},
): Promise<number[]> {
  return Promise.resolve([]);
}
