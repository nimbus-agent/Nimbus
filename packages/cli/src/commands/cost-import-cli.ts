import { resolve } from "node:path";

import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * `nimbus cost import <path> [--provider aws|azure|gcp] [--dry-run] [--json]` and
 * `nimbus cost import --remove <importId> [--json]` (Phase 7, the Cost Pack). The gateway reads the FOCUS CSV
 * export(s) at the path (a file, or a directory's `*.csv` files, not recursive) into the local cost lines;
 * nothing is fetched and nothing leaves the machine. The path is resolved against the current directory here,
 * so the gateway always receives an absolute path.
 *
 * Exit codes: 0 when every file imported (or would, with `--dry-run`), 1 when any file was refused or the call
 * failed.
 */
export interface CostImportIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface CostImportSink {
  out(s: string): void;
  err(s: string): void;
}

export type CostImportArgs =
  | {
      readonly mode: "import";
      readonly path: string;
      readonly provider?: "aws" | "azure" | "gcp";
      readonly dryRun: boolean;
      readonly json: boolean;
    }
  | { readonly mode: "remove"; readonly importId: string; readonly json: boolean };

const PROVIDERS = ["aws", "azure", "gcp"] as const;

export function parseCostImportArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): CostImportArgs | undefined {
  let path: string | undefined;
  let provider: (typeof PROVIDERS)[number] | undefined;
  let remove: string | undefined;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--provider") {
      const v = args[++i];
      if (v === undefined || !(PROVIDERS as readonly string[]).includes(v)) return undefined;
      provider = v as (typeof PROVIDERS)[number];
    } else if (a === "--remove") {
      const v = args[++i];
      if (v === undefined) return undefined;
      remove = v;
    } else if (a !== undefined && !a.startsWith("--") && path === undefined) path = a;
    else return undefined;
  }
  if (remove !== undefined) {
    if (path !== undefined || provider !== undefined || dryRun) return undefined;
    return { mode: "remove", importId: remove, json };
  }
  if (path === undefined) return undefined;
  return {
    mode: "import",
    path: resolve(cwd, path),
    dryRun,
    json,
    ...(provider === undefined ? {} : { provider }),
  };
}

type Issue = { row: number; reason: string };
type FileReport = {
  name: string;
  importId: string | null;
  status: "imported" | "dry_run" | "refused";
  error?: string;
  lines: number;
  inserted: number;
  replaced: number;
  unchanged: number;
  removed: number;
  totals: Record<string, number>;
  skippedCount: number;
  skipped: Issue[];
  warningCount: number;
  warnings: Issue[];
};
type ImportReport = { dryRun: boolean; files: FileReport[] };

const clean = (s: string): string => stripControlChars(s);

function money(totals: Record<string, number>): string {
  const parts = Object.entries(totals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, v]) => `${v.toFixed(2)} ${clean(c)}`);
  return parts.length === 0 ? "no cost" : parts.join(", ");
}

function renderFile(f: FileReport, sink: CostImportSink): void {
  if (f.status === "refused") {
    sink.err(`  ${clean(f.name)}: refused - ${clean(f.error ?? "unknown error")}\n`);
    return;
  }
  sink.out(
    `  ${clean(f.name)}  ${f.importId ?? ""}  ${String(f.lines)} lines (${String(f.inserted)} new, ${String(f.replaced)} restated, ${String(f.unchanged)} unchanged, ${String(f.removed)} removed)  total ${money(f.totals)}\n`,
  );
  if (f.skippedCount > 0) {
    sink.out(`    ${String(f.skippedCount)} rows skipped:\n`);
    for (const s of f.skipped) sink.out(`      record ${String(s.row)}: ${clean(s.reason)}\n`);
    if (f.skippedCount > f.skipped.length) {
      sink.out(`      ... and ${String(f.skippedCount - f.skipped.length)} more\n`);
    }
  }
  if (f.warningCount > 0) {
    sink.out(`    ${String(f.warningCount)} warnings:\n`);
    for (const w of f.warnings) sink.out(`      record ${String(w.row)}: ${clean(w.reason)}\n`);
    if (f.warningCount > f.warnings.length) {
      sink.out(`      ... and ${String(f.warningCount - f.warnings.length)} more\n`);
    }
  }
}

function errorText(e: unknown): string {
  return clean(e instanceof Error ? e.message : String(e));
}

export async function runCostImportWith(
  c: CostImportIpc,
  a: CostImportArgs,
  sink: CostImportSink,
): Promise<number> {
  try {
    if (a.mode === "remove") {
      const r = (await c.call("cost.importRemove", { importId: a.importId })) as {
        importId: string;
        removed: number;
      };
      if (a.json) sink.out(`${JSON.stringify(r)}\n`);
      else sink.out(`Removed ${String(r.removed)} cost lines of import ${clean(r.importId)}.\n`);
      return 0;
    }
    const r = (await c.call("cost.import", {
      path: a.path,
      dryRun: a.dryRun,
      ...(a.provider === undefined ? {} : { provider: a.provider }),
    })) as ImportReport;
    const refusedCount = r.files.filter((f) => f.status === "refused").length;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return refusedCount === 0 ? 0 : 1;
    }
    const n = r.files.length;
    sink.out(
      r.dryRun
        ? `Dry run over ${String(n)} file${n === 1 ? "" : "s"}: nothing was written.\n`
        : `Imported ${String(n - refusedCount)} of ${String(n)} file${n === 1 ? "" : "s"}.\n`,
    );
    for (const f of r.files) renderFile(f, sink);
    return refusedCount === 0 ? 0 : 1;
  } catch (e) {
    sink.err(`nimbus cost import: ${errorText(e)}\n`);
    return 1;
  }
}
