import type { BenchRunOptions } from "../types.ts";

export const S9_STUB_REASON =
  "stub: Ollama-driven LLM round-trip lands in PR-B-2b-3 (reference-only when implemented)";

export async function runLlmRoundtripOnce(
  _opts: BenchRunOptions,
  _runOpts: Record<string, unknown> = {},
): Promise<number[]> {
  return [];
}
