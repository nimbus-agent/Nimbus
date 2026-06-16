import { makeSetOutput } from "../../shared/gha-io.ts";

export const ALLOWED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "verdict",
  "incident-count",
  "failing-ci-count",
  "merge-conflict-count",
  "result-json",
]);

export const setOutput: (name: string, value: string) => void = makeSetOutput(ALLOWED_OUTPUT_NAMES);
