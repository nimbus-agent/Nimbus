// Phase 7 (the Cost Pack): the watched FOCUS folder (`[cost.focus] dir`). Once a day the gateway imports the
// folder's new or changed `*.csv` files (by SHA-256) through the same path as `nimbus cost import`.
//
// Confined by static rule D48 (no network, no connector, no model). Never started on a demo gateway (the
// caller, `platform/assemble/finops-sidecars.ts`, checks; I41). The folder is re-read from the config on every
// pass. Stated bound: the "already imported" memory is per gateway run; after a restart the first pass
// re-imports every file, oldest first, which ends in the same state (an identical file is a no-op and the
// newest export of an overlapping period is applied last).
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CostImportError,
  type ImportFileReport,
  importFocusPath,
  listFocusFiles,
} from "./cost-import.ts";

export const COST_FOLDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CostFolderWatchOptions {
  readonly db: Database;
  /** The configured folder, read on every pass; `null` turns the pass into a no-op. */
  readonly dir: () => string | null;
  readonly now: () => number;
  readonly onFile?: (file: ImportFileReport) => void;
  readonly onFailure?: (err: unknown) => void;
}

function hashOf(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** One pass: import every file whose bytes this run has not imported yet. Returns the files imported. */
export function createCostFolderPass(opts: CostFolderWatchOptions): () => ImportFileReport[] {
  const done = new Map<string, string>();
  return () => {
    const out: ImportFileReport[] = [];
    try {
      const dir = opts.dir();
      if (dir === null) return out;
      let files: string[];
      try {
        files = listFocusFiles(dir);
      } catch (e) {
        if (e instanceof CostImportError && e.message.startsWith("no .csv file")) return out;
        throw e;
      }
      for (const f of files) {
        const sha = hashOf(f);
        if (sha === null || done.get(f) === sha) continue;
        const report = importFocusPath(opts.db, f, { dryRun: false, now: opts.now }).files[0];
        if (report === undefined) continue;
        if (report.status === "imported") done.set(f, sha);
        out.push(report);
        opts.onFile?.(report);
      }
    } catch (e) {
      opts.onFailure?.(e);
    }
    return out;
  };
}
