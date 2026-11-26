// Phase 7 (the Cost Pack): `nimbus cost import` - FOCUS CSV exports into the `cost_line` table.
//
// Confined by static rule D48 (no network, no connector, no model): local files only, no credential.
// Each file is read through ONE handle (size checked on that handle, capped), decoded as strict UTF-8,
// parsed, reconciled (the stored lines of every billing period sum to the file's own totals per currency)
// and written in its own transaction. A directory imports its `*.csv` files (not recursive) oldest first by
// modification time, so when two exports overlap the newest one's values stand.
//
// The import id is the file's content hash (`focus:<16 hex>`), so re-importing the same bytes is a no-op
// and `nimbus cost import --remove <importId>` names one export.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import type { CostLine } from "./cost-line.ts";
import {
  deleteCostImport,
  type ReplaceCostLinesResult,
  replaceCostLines,
} from "./cost-line-store.ts";
import {
  FocusCsvError,
  type FocusProvider,
  type FocusRowIssue,
  parseFocusCsv,
} from "./focus-csv.ts";

export const COST_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
/** Skipped rows and warnings listed per file; the counts are always exact. */
export const COST_IMPORT_MAX_LISTED = 20;
const IMPORT_ID_RE = /^focus:[0-9a-f]{16}$/;

export class CostImportError extends Error {
  override readonly name = "CostImportError";
}

export interface ImportFileReport {
  readonly path: string;
  readonly name: string;
  readonly sha256: string | null;
  readonly importId: string | null;
  readonly status: "imported" | "dry_run" | "refused";
  readonly error?: string;
  readonly lines: number;
  readonly inserted: number;
  readonly replaced: number;
  readonly unchanged: number;
  readonly removed: number;
  /** The file's own `BilledCost` total per currency, from the accepted rows. */
  readonly totals: Record<string, number>;
  readonly skippedCount: number;
  readonly skipped: FocusRowIssue[];
  readonly warningCount: number;
  readonly warnings: FocusRowIssue[];
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly importedAtMs: number;
  readonly files: ImportFileReport[];
}

export interface ImportOptions {
  readonly provider?: FocusProvider;
  readonly dryRun: boolean;
  readonly now: () => number;
  /** Test seam: the per-file size cap (default {@link COST_IMPORT_MAX_BYTES}). */
  readonly maxBytes?: number;
}

/** The `*.csv` files a path names: the file itself, or a directory's (not recursive), oldest first. */
export function listFocusFiles(path: string): string[] {
  if (!isAbsolute(path)) throw new CostImportError(`the path must be absolute: ${path}`);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new CostImportError(`no such file or directory: ${path}`);
  }
  if (st.isSymbolicLink())
    throw new CostImportError(`the path is a link, which is not followed: ${path}`);
  if (st.isFile()) return [path];
  if (!st.isDirectory()) throw new CostImportError(`not a file or directory: ${path}`);
  const files: { p: string; mtime: number; name: string }[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".csv")) continue;
    const p = join(path, e.name);
    files.push({ p, mtime: lstatSync(p).mtimeMs, name: e.name });
  }
  if (files.length === 0) throw new CostImportError(`no .csv file in ${path}`);
  files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return files.map((f) => f.p);
}

/** The bytes of one file, through one handle, refused above the cap. */
function readCapped(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) {
      throw new CostImportError(
        `the file is larger than the import cap of ${String(maxBytes)} bytes; split the export`,
      );
    }
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

const ROLLBACK = Symbol("dry-run rollback");
const EPSILON = 1e-6;

function sumByCurrency(lines: readonly CostLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.currency, (m.get(l.currency) ?? 0) + l.billedCost);
  return m;
}

function refused(path: string, error: string, sha256: string | null = null): ImportFileReport {
  return {
    path,
    name: basename(path),
    sha256,
    importId: null,
    status: "refused",
    error,
    lines: 0,
    inserted: 0,
    replaced: 0,
    unchanged: 0,
    removed: 0,
    totals: {},
    skippedCount: 0,
    skipped: [],
    warningCount: 0,
    warnings: [],
  };
}

function importOneFile(db: Database, path: string, opts: ImportOptions): ImportFileReport {
  let bytes: Buffer;
  try {
    bytes = readCapped(path, opts.maxBytes ?? COST_IMPORT_MAX_BYTES);
  } catch (e) {
    return refused(
      path,
      e instanceof CostImportError ? e.message : `could not read the file: ${String(e)}`,
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refused(path, "the file is not valid UTF-8", sha256);
  }
  const importId = `focus:${sha256.slice(0, 16)}`;
  let parsed: ReturnType<typeof parseFocusCsv>;
  try {
    parsed = parseFocusCsv(text, {
      importId,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    });
  } catch (e) {
    return refused(path, e instanceof FocusCsvError ? e.message : String(e), sha256);
  }
  const totals: Record<string, number> = {};
  const acc = { inserted: 0, replaced: 0, unchanged: 0, removed: 0 };
  const apply = (): void => {
    for (const [periodKey, period] of parsed.byPeriod) {
      const lines = parsed.lines.filter(
        (l) => `${l.provider}|${l.billingAccountId}|${l.billingPeriod}` === periodKey,
      );
      const sums = sumByCurrency(lines);
      for (const [currency, total] of period.totals) {
        if (Math.abs((sums.get(currency) ?? 0) - total) > EPSILON) {
          throw new CostImportError(
            `internal: ${periodKey} ${currency} lines do not sum to the file total`,
          );
        }
        totals[currency] = (totals[currency] ?? 0) + total;
      }
      const r: ReplaceCostLinesResult = replaceCostLines(db, period.key, [...period.days], lines);
      acc.inserted += r.inserted;
      acc.replaced += r.replaced;
      acc.unchanged += r.unchanged;
      acc.removed += r.removed;
    }
    if (opts.dryRun) throw ROLLBACK;
  };
  try {
    db.transaction(apply)();
  } catch (e) {
    if (e !== ROLLBACK) return refused(path, e instanceof Error ? e.message : String(e), sha256);
  }
  return {
    path,
    name: basename(path),
    sha256,
    importId,
    status: opts.dryRun ? "dry_run" : "imported",
    lines: parsed.lines.length,
    ...acc,
    totals,
    skippedCount: parsed.skipped.length,
    skipped: parsed.skipped.slice(0, COST_IMPORT_MAX_LISTED),
    warningCount: parsed.warnings.length,
    warnings: parsed.warnings.slice(0, COST_IMPORT_MAX_LISTED),
  };
}

/** Import one FOCUS CSV file or a directory of them. Throws {@link CostImportError} for a bad path. */
export function importFocusPath(db: Database, path: string, opts: ImportOptions): ImportReport {
  const files = listFocusFiles(path);
  return {
    dryRun: opts.dryRun,
    importedAtMs: opts.now(),
    files: files.map((f) => importOneFile(db, f, opts)),
  };
}

/** `nimbus cost import --remove <importId>`: delete one import's lines. */
export function removeCostImport(
  db: Database,
  importId: string,
): { importId: string; removed: number } {
  if (!IMPORT_ID_RE.test(importId)) {
    throw new CostImportError(`not an import id (focus:<16 hex>): ${importId.slice(0, 64)}`);
  }
  return { importId, removed: deleteCostImport(db, importId) };
}
