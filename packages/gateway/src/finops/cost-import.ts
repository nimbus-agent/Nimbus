// Phase 7 (the Cost Pack): `nimbus cost import` - FOCUS CSV exports into the `cost_line` table.
//
// Confined by static rule D48 (no network, no connector, no model): local files only, no credential.
// Each file is read through ONE handle (size checked on that handle, capped), decoded as strict UTF-8,
// parsed, reconciled (the stored lines of every billing period sum to the file's own totals per currency)
// and written in its own transaction. A directory imports its `*.csv` files (not recursive) oldest first by
// modification time, so when two exports overlap the newest one's values stand.
//
// The import id is the file's content hash (`focus:<16 hex>`) and every accepted import is recorded in the
// import ledger (`cost_import`, in the same transaction as its lines). An import whose id the ledger holds is
// `unchanged` and writes nothing, so replaying an older export never overwrites a later restatement;
// `nimbus cost import --remove <importId>` deletes one export's lines and its ledger row. A directory in which
// ANY file is not yet accepted re-applies EVERY file oldest first (accepted ones included), so the newest
// export still wins an overlap. A `--dry-run` runs every file inside one transaction that is rolled back, each
// file in its own savepoint, so a later file sees the earlier files' simulated changes.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type { CostLine } from "./cost-line.ts";
import {
  type CostImportRecord,
  deleteCostImport,
  isCostImportAccepted,
  type ReplaceCostLinesResult,
  recordCostImport,
  replaceCostLines,
} from "./cost-line-store.ts";
import {
  FOCUS_SOURCE,
  FocusCsvError,
  type FocusProvider,
  type FocusRowIssue,
  parseFocusCsv,
} from "./focus-csv.ts";

export const COST_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
/** Skipped rows and warnings listed per file; the counts are always exact. */
export const COST_IMPORT_MAX_LISTED = 20;
const IMPORT_ID_RE = /^focus:[0-9a-f]{16}$/;
const HASH_CHUNK = 1024 * 1024;

export class CostImportError extends Error {
  override readonly name = "CostImportError";
}

export interface ImportFileReport {
  readonly path: string;
  readonly name: string;
  readonly sha256: string | null;
  readonly importId: string | null;
  /** `unchanged`: the import ledger already holds this export, so nothing was (or would be) written. */
  readonly status: "imported" | "dry_run" | "unchanged" | "refused";
  readonly error?: string;
  /** `refused` only: true when the cause may pass (an I/O or storage failure), so a watcher tries again. */
  readonly retryable?: boolean;
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
  /** Re-apply every file, accepted ones included (the watched folder after a change). */
  readonly replay?: boolean;
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

function checkCap(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new CostImportError(
      `the file is larger than the import cap of ${String(maxBytes)} bytes; split the export`,
    );
  }
}

/**
 * SHA-256 hex of one file, through one handle: the size is checked on that handle BEFORE any byte is read
 * (refused above the cap with {@link CostImportError}), then the bytes are hashed in 1 MiB chunks.
 */
export function hashFileCapped(path: string, maxBytes: number = COST_IMPORT_MAX_BYTES): string {
  const fd = openSync(path, "r");
  try {
    checkCap(fstatSync(fd).size, maxBytes);
    const h = createHash("sha256");
    const buf = Buffer.alloc(HASH_CHUNK);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, HASH_CHUNK, off);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      off += n;
      checkCap(off, maxBytes);
    }
    return h.digest("hex");
  } finally {
    closeSync(fd);
  }
}

const importIdOf = (sha256: string): string => `focus:${sha256.slice(0, 16)}`;

/** The bytes of one file, through one handle, refused above the cap. */
function readCapped(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    checkCap(size, maxBytes);
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

function emptyReport(
  path: string,
  status: ImportFileReport["status"],
  sha256: string | null,
  importId: string | null,
): ImportFileReport {
  return {
    path,
    name: basename(path),
    sha256,
    importId,
    status,
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

function refused(
  path: string,
  error: string,
  sha256: string | null = null,
  retryable = false,
): ImportFileReport {
  return {
    ...emptyReport(path, "refused", sha256, null),
    error,
    ...(retryable ? { retryable } : {}),
  };
}

/** A storage failure may pass; a file the importer itself refused (`CostImportError`) will not. */
const storageRefusal = (path: string, e: unknown, sha256: string): ImportFileReport =>
  refused(
    path,
    e instanceof Error ? e.message : String(e),
    sha256,
    !(e instanceof CostImportError),
  );

type Counts = { inserted: number; replaced: number; unchanged: number; removed: number };
type Refusal = {
  readonly error: string;
  readonly sha256: string | null;
  readonly retryable?: boolean;
};

/** Read phase: the bytes through one capped handle, their hash and strict UTF-8 text. */
function readFile(path: string, maxBytes: number): { sha256: string; text: string } | Refusal {
  let bytes: Buffer;
  try {
    bytes = readCapped(path, maxBytes);
  } catch (e) {
    if (e instanceof CostImportError) return { error: e.message, sha256: null };
    return { error: `could not read the file: ${String(e)}`, sha256: null, retryable: true };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    return { sha256, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "the file is not valid UTF-8", sha256 };
  }
}

/** Apply phase: reconcile each billing period with the file's totals and replace its days. */
function applyParsed(
  db: Database,
  parsed: ReturnType<typeof parseFocusCsv>,
  totals: Record<string, number>,
  acc: Counts,
): void {
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
}

/** The ledger row of an accepted file: its providers, sorted and comma-joined. */
function ledgerRow(
  parsed: ReturnType<typeof parseFocusCsv>,
  importId: string,
  sha256: string,
  at: number,
): CostImportRecord {
  const providers = [...new Set(parsed.lines.map((l) => l.provider))]
    .sort(codeUnitCompare)
    .join(",");
  return {
    importId,
    source: FOCUS_SOURCE,
    provider: providers.slice(0, 256),
    fileSha256: sha256,
    importedAtMs: at,
  };
}

function importOneFile(
  db: Database,
  path: string,
  opts: ImportOptions,
  replay: boolean,
  at: number,
): ImportFileReport {
  const read = readFile(path, opts.maxBytes ?? COST_IMPORT_MAX_BYTES);
  if ("error" in read) return refused(path, read.error, read.sha256, read.retryable === true);
  const { sha256, text } = read;
  const importId = importIdOf(sha256);
  try {
    if (!replay && isCostImportAccepted(db, importId)) {
      return emptyReport(path, "unchanged", sha256, importId);
    }
  } catch (e) {
    return storageRefusal(path, e, sha256);
  }
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
  const acc: Counts = { inserted: 0, replaced: 0, unchanged: 0, removed: 0 };
  try {
    // Inside a dry run's outer transaction this is a savepoint: a failure undoes this file only.
    db.transaction(() => {
      applyParsed(db, parsed, totals, acc);
      recordCostImport(db, ledgerRow(parsed, importId, sha256, at));
    })();
  } catch (e) {
    return storageRefusal(path, e, sha256);
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

/** Whether a directory holds a file the ledger has not accepted (one that cannot be hashed is not new). */
function hasNewFile(db: Database, files: readonly string[], maxBytes: number): boolean {
  return files.some((f) => {
    try {
      return !isCostImportAccepted(db, importIdOf(hashFileCapped(f, maxBytes)));
    } catch {
      return false;
    }
  });
}

/** Every file in order; a dry run inside ONE transaction that is always rolled back. */
function importFiles(
  db: Database,
  files: readonly string[],
  opts: ImportOptions,
  replay: boolean,
  at: number,
): ImportFileReport[] {
  const run = (): ImportFileReport[] => files.map((f) => importOneFile(db, f, opts, replay, at));
  if (!opts.dryRun) return run();
  let reports: ImportFileReport[] = [];
  try {
    db.transaction(() => {
      reports = run();
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return reports;
}

/** Import one FOCUS CSV file or a directory of them. Throws {@link CostImportError} for a bad path. */
export function importFocusPath(db: Database, path: string, opts: ImportOptions): ImportReport {
  const files = listFocusFiles(path);
  const at = opts.now();
  const replay =
    opts.replay === true ||
    (files.length > 1 && hasNewFile(db, files, opts.maxBytes ?? COST_IMPORT_MAX_BYTES));
  return { dryRun: opts.dryRun, importedAtMs: at, files: importFiles(db, files, opts, replay, at) };
}

/** `nimbus cost import --remove <importId>`: delete one import's lines and its ledger row. */
export function removeCostImport(
  db: Database,
  importId: string,
): { importId: string; removed: number } {
  if (!IMPORT_ID_RE.test(importId)) {
    throw new CostImportError(`not an import id (focus:<16 hex>): ${importId.slice(0, 64)}`);
  }
  return { importId, removed: deleteCostImport(db, importId) };
}
