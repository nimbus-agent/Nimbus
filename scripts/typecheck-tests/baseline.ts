// scripts/typecheck-tests/baseline.ts
import type { ErrorCounts } from "./parse.ts";

export type Violation =
  | {
      readonly kind: "new_file";
      readonly file: string;
      readonly code: string;
      readonly baseline: 0;
      readonly actual: number;
    }
  | {
      readonly kind: "regression";
      readonly file: string;
      readonly code: string;
      readonly baseline: number;
      readonly actual: number;
    };

/**
 * A single rule covers both cases: any `(file, code)` whose count EXCEEDS its baseline (absent = 0)
 * is a violation. `kind` only changes the message — a file the baseline has never seen is reported
 * as `new_file` because that reads more clearly than "regressed from 0".
 *
 * KNOWN LIMITATION: fixing one TS2554 while adding another in the same file nets zero and passes.
 * This is the same per-file granularity trade-off `coverage-floor` already makes; a finer key
 * (line numbers) is not stable enough to gate on.
 */
export function evaluate(actual: ErrorCounts, baseline: ErrorCounts): Violation[] {
  const out: Violation[] = [];
  for (const [file, byCode] of actual) {
    const baseFile = baseline.get(file);
    for (const [code, count] of byCode) {
      const baseCount = baseFile?.get(code) ?? 0;
      if (count <= baseCount) continue;
      out.push(
        baseFile === undefined
          ? { kind: "new_file", file, code, baseline: 0, actual: count }
          : { kind: "regression", file, code, baseline: baseCount, actual: count },
      );
    }
  }
  return out;
}

interface BaselineFile {
  readonly version: 1;
  readonly generated_at: string;
  readonly files: Record<string, Record<string, number>>;
}

/** Sorted on both axes so an update produces a reviewable diff, mirroring coverage-floor. */
export function serializeBaseline(counts: ErrorCounts, generatedAt: string): string {
  const files: Record<string, Record<string, number>> = {};
  for (const file of [...counts.keys()].sort()) {
    const byCode = counts.get(file);
    if (byCode === undefined) continue;
    const codes: Record<string, number> = {};
    for (const code of [...byCode.keys()].sort()) codes[code] = byCode.get(code) ?? 0;
    files[file] = codes;
  }
  const doc: BaselineFile = { version: 1, generated_at: generatedAt, files };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function parseBaseline(raw: string): ErrorCounts {
  const doc = JSON.parse(raw) as unknown;
  if (typeof doc !== "object" || doc === null) throw new Error("baseline: not an object");
  const files = (doc as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) throw new Error("baseline: missing `files`");
  const out: ErrorCounts = new Map();
  for (const [file, codes] of Object.entries(files as Record<string, unknown>)) {
    if (typeof codes !== "object" || codes === null) continue;
    const m = new Map<string, number>();
    for (const [code, n] of Object.entries(codes as Record<string, unknown>)) {
      if (typeof n === "number") m.set(code, n);
    }
    out.set(file, m);
  }
  return out;
}
