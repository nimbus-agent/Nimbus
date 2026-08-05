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
    }
  | {
      readonly kind: "must_raise";
      readonly file: string;
      readonly code: string;
      readonly baseline: number;
      readonly actual: number;
    }
  | { readonly kind: "must_remove"; readonly file: string };

/**
 * A ratchet that only ever loosens is not a ratchet. Three rules, matching the vocabulary the
 * sibling `scripts/coverage-floor/` gate already uses:
 *
 * - `new_file` / `regression` — any `(file, code)` whose count EXCEEDS its baseline (absent = 0).
 *   `kind` only changes the message; a file the baseline has never seen reads better as "NEW file"
 *   than as "regressed from 0".
 * - `must_raise` — a count BELOW its baseline. Paid-down debt must be banked by re-running
 *   update-baseline, otherwise the slack is permanent: fix 15 errors and a later change that
 *   reintroduces 14 still passes green.
 * - `must_remove` — a baseline entry whose file no longer exists on disk. A phantom entry is free
 *   allowance that a recreated file at the same path would silently inherit.
 *
 * `fileExists` is injected rather than called directly so this stays a pure function; `check.ts`
 * passes an `existsSync` bound to the repo root.
 *
 * KNOWN LIMITATION: fixing one TS2554 while adding another in the same file nets zero and passes.
 * This is the same per-file granularity trade-off `coverage-floor` already makes; a finer key
 * (line numbers) is not stable enough to gate on.
 */
export function evaluate(
  actual: ErrorCounts,
  baseline: ErrorCounts,
  fileExists: (file: string) => boolean,
): Violation[] {
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
  for (const [file, byCode] of baseline) {
    // A deleted file's every code also reads as 0 < baseline. Report the deletion once and stop,
    // rather than burying it under one `must_raise` per code for a file that isn't there.
    if (!fileExists(file)) {
      out.push({ kind: "must_remove", file });
      continue;
    }
    const actualFile = actual.get(file);
    for (const [code, baseCount] of byCode) {
      const count = actualFile?.get(code) ?? 0;
      if (count >= baseCount) continue;
      out.push({ kind: "must_raise", file, code, baseline: baseCount, actual: count });
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
