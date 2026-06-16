import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";

/**
 * Parse the last non-blank line of a `run-history.jsonl` text blob into a
 * HistoryLine. Each perf run writes a fresh single-run history file, so the
 * last line is that run's result. Throws on empty input. Callers that need a
 * schema-version guard apply it to the returned line.
 */
export function parseLastHistoryLine(text: string): HistoryLine {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("run-history.jsonl is empty");
  }
  return JSON.parse(last) as HistoryLine;
}
