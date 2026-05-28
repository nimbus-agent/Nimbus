import type { BenchRunOptions } from "../types.ts";

export const S7C_REFERENCE_ONLY_REASON =
  "reference-only; requires loaded LLM + GPU (real driver in PR-B-2b-3)";

export async function runRssMultiAgentOnce(
  _opts: BenchRunOptions,
  _runOpts: Record<string, unknown> = {},
): Promise<number[]> {
  return [];
}
