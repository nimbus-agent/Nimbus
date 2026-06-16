import { makeSetOutput } from "../../shared/gha-io.ts";

export const ALLOWED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "external-id",
  "is-new",
  "dora-eligible",
]);

export const setOutput: (name: string, value: string) => void = makeSetOutput(ALLOWED_OUTPUT_NAMES);
