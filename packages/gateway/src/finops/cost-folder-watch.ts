// Phase 7 (the Cost Pack): the watched FOCUS folder (`[cost.focus] dir`). Once a day the gateway checks the
// folder's `*.csv` files and, when ANY of them is new or changed (by SHA-256), re-imports EVERY file of the
// folder oldest-modification-first through the same path as `nimbus cost import` (accepted files included), so
// the stored lines always equal a fresh oldest-first import of the folder and the newest export of an
// overlapping period stands. When nothing changed, nothing is imported.
//
// Confined by static rule D48 (no network, no connector, no model). Never started on a demo gateway (the
// caller, `platform/assemble/finops-sidecars.ts`, checks; I41). The folder is re-read from the config on every
// pass. Each file's size is checked before a byte of it is read (the importer's cap, `COST_IMPORT_MAX_BYTES`),
// and the hash is streamed. Stated bound: the "already seen" memory is per gateway run; after a restart the
// first pass imports the folder through the import ledger, where every accepted file is `unchanged`, which
// ends in the same state. A refused file is retried when its bytes change.
import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";

import {
  COST_IMPORT_MAX_BYTES,
  CostImportError,
  hashFileCapped,
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
  /** Test seam: the per-file size cap (default {@link COST_IMPORT_MAX_BYTES}). */
  readonly maxBytes?: number;
}

/** The file's content hash, or (unhashable: above the cap, unreadable) its size and modification time. */
function fingerprintOf(path: string, maxBytes: number): string {
  try {
    return hashFileCapped(path, maxBytes);
  } catch {
    try {
      const st = lstatSync(path);
      return `unhashed:${String(st.size)}:${String(st.mtimeMs)}`;
    } catch {
      return "unreadable";
    }
  }
}

/** The folder's files, or none when it holds no `.csv` file (any other error propagates). */
function folderFiles(dir: string): string[] {
  try {
    return listFocusFiles(dir);
  } catch (e) {
    if (e instanceof CostImportError && e.message.startsWith("no .csv file")) return [];
    throw e;
  }
}

/** One pass: when any file is new or changed, re-import the whole folder. Returns the files imported. */
export function createCostFolderPass(opts: CostFolderWatchOptions): () => ImportFileReport[] {
  let seen = new Map<string, string>();
  const maxBytes = opts.maxBytes ?? COST_IMPORT_MAX_BYTES;
  return () => {
    try {
      const dir = opts.dir();
      if (dir === null) return [];
      const now = new Map(folderFiles(dir).map((f) => [f, fingerprintOf(f, maxBytes)]));
      const changed = [...now].some(([f, fp]) => seen.get(f) !== fp);
      if (!changed) return [];
      // After a restart (empty memory) the ledger decides; after a change in this run, every file replays.
      const replay = seen.size > 0;
      seen = now;
      const files = importFocusPath(opts.db, dir, {
        dryRun: false,
        now: opts.now,
        maxBytes,
        replay,
      }).files;
      for (const f of files) opts.onFile?.(f);
      return files;
    } catch (e) {
      opts.onFailure?.(e);
      return [];
    }
  };
}
