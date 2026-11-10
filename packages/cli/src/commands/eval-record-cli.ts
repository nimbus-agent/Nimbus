/**
 * `nimbus eval --package <dir> --record <inputs.json> [--out <file>] [--force]`: the parts of the
 * record flow that are not the role spawn. Everything in `prepareRecord` happens BEFORE the role is
 * spawned, so a refusal costs no sandbox run and writes nothing; `writeRecordedSuite` runs only
 * after the role answered with a suite.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  codeUnitCompare,
  type EVAL_RECORD_SKIP_REASONS,
  type EvalRecordDocument,
  type EvalRecordSkip,
  isEvalSuiteFile,
  MAX_EVAL_CASES,
  MAX_EVAL_RECORD_INPUTS_BYTES,
  MAX_EVAL_SUITES,
  parseEvalRecordInputs,
  parseEvalSuite,
  serialiseEvalSuite,
} from "@nimbus-dev/registry-format";
import { readRegularFileBounded } from "../lib/read-regular-file-bounded.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import {
  sweepStaleTempFiles,
  WriteFileError,
  writeFileExclusive,
} from "../lib/write-file-exclusive.ts";

export const DEFAULT_RECORD_OUT = "evals/golden.eval.json";

export const RECORD_NOTE =
  "these expectations are what the package answered offline, with no credentials and no network: review them before committing";

const SKIP_TEXT: Record<(typeof EVAL_RECORD_SKIP_REASONS)[number], string> = {
  "call-failed": "the tool call failed",
  "error-flag-differs": "its error flag differed between the two runs",
  "reply-too-large": "its reply was too large to record",
  "reply-too-deep": "its reply was nested too deeply to record",
  "changes-type": "a value changed type between runs",
  "changes-shape": "its reply changed shape between runs",
  "changes-not-json": "its reply changed between runs and is not JSON",
  "self-check-failed": "the generated expectation did not match its own replies",
};

export type RecordPlan = {
  /** Absolute path of the inputs file, as the role is given it. */
  inputsAbs: string;
  /** The suite file, package-relative and POSIX (`evals/golden.eval.json`). */
  outRel: string;
  outAbs: string;
  force: boolean;
};

export type RecordPrep = { ok: true; plan: RecordPlan } | { ok: false; message: string };

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readInputs(inputsAbs: string): { cases: number } | string {
  const read = readRegularFileBounded(inputsAbs, MAX_EVAL_RECORD_INPUTS_BYTES);
  if (!read.ok) return `inputs file ${inputsAbs} ${read.why}`;
  try {
    return { cases: parseEvalRecordInputs(inputsAbs, read.bytes).cases.length };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The package-relative POSIX form of `--out`, or why it is refused. */
function resolveOut(pkgAbs: string, out: string): { rel: string; abs: string } | string {
  const posix = out.replaceAll("\\", "/");
  if (isAbsolute(out) || posix.startsWith("/")) return "--out must be relative to the package";
  const abs = resolve(pkgAbs, posix);
  const rel = relative(pkgAbs, abs).replaceAll("\\", "/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return "--out must stay inside the package";
  }
  if (!isEvalSuiteFile(rel)) {
    return "--out must be a file directly in evals/ named <name>.eval.json";
  }
  const name = rel.slice("evals/".length);
  if (hasUnsafeNameChar(name)) return "--out must not contain ':' or control characters";
  if (isReservedDeviceName(name)) return "--out must not name a Windows reserved device";
  return { rel, abs };
}

/** `:` (an NTFS alternate data stream) or a control character, refused on every OS. */
function hasUnsafeNameChar(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === ":" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9 before the first dot: a device on Windows, refused everywhere. */
function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE.test(name.split(".")[0] ?? "");
}

/** Whether two file names are the same file: case-insensitive wherever the filesystem usually is. */
export function sameFileName(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * The totals the package would have with one more suite: every OTHER `evals/*.eval.json`, each in
 * its own try/catch (a broken suite is a warning, not a refusal, and is not counted).
 */
function existingTotals(evalsDir: string, targetName: string, warn: (s: string) => void) {
  let suites = 0;
  let cases = 0;
  for (const name of readdirSync(evalsDir).sort(codeUnitCompare)) {
    if (sameFileName(name, targetName) || !isEvalSuiteFile(`evals/${name}`)) continue;
    try {
      cases += parseEvalSuite(name, readFileSync(join(evalsDir, name))).cases.length;
      suites += 1;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const label = stripControlChars(`evals/${name}`);
      warn(`warning: ${label} is not counted: ${stripControlChars(why)}`);
    }
  }
  return { suites, cases };
}

/**
 * Whether the totals leave room. The cap check counts the INPUTS file's cases: the final written
 * count can be lower after skips, but refusing on the inputs count is the safe side.
 */
function capProblem(totals: { suites: number; cases: number }, newCases: number): string | null {
  if (totals.suites + 1 > MAX_EVAL_SUITES) {
    return `the package already has ${totals.suites} valid suites; at most ${MAX_EVAL_SUITES} are scored`;
  }
  if (totals.cases + newCases > MAX_EVAL_CASES) {
    return `${totals.cases} cases in other suites plus ${newCases} to record is over the ${MAX_EVAL_CASES} case cap`;
  }
  return null;
}

function targetProblem(evalsDir: string, outAbs: string, outRel: string, force: boolean) {
  const dir = lstatOrNull(evalsDir);
  if (dir !== null && !dir.isDirectory()) {
    return "evals is not a plain directory (a symlink or a file); refusing to write through it";
  }
  const target = dir === null ? null : lstatOrNull(outAbs);
  if (target === null) return null;
  if (!force) return `${outRel} exists; refusing to overwrite it without --force`;
  return target.isFile() ? null : `${outRel} is not a regular file; refusing to replace it`;
}

/** Everything that can be refused without spawning the role. */
export function prepareRecord(
  args: { pkg: string; record: string; out: string | undefined; force: boolean },
  warn: (s: string) => void,
): RecordPrep {
  const pkgAbs = resolve(args.pkg);
  const inputsAbs = resolve(args.record);
  const inputs = readInputs(inputsAbs);
  if (typeof inputs === "string") return { ok: false, message: inputs };
  const out = resolveOut(pkgAbs, args.out ?? DEFAULT_RECORD_OUT);
  if (typeof out === "string") return { ok: false, message: out };
  const evalsDir = join(pkgAbs, "evals");
  const problem = targetProblem(evalsDir, out.abs, out.rel, args.force);
  if (problem !== null) return { ok: false, message: problem };
  const evalsExists = lstatOrNull(evalsDir) !== null;
  // A killed earlier run can leave its temp file in evals/, where `extension pack` would pack it.
  if (evalsExists) sweepStaleTempFiles(out.abs);
  const totals = evalsExists
    ? existingTotals(evalsDir, out.rel.slice("evals/".length), warn)
    : { suites: 0, cases: 0 };
  const capped = capProblem(totals, inputs.cases);
  if (capped !== null) return { ok: false, message: capped };
  return { ok: true, plan: { inputsAbs, outRel: out.rel, outAbs: out.abs, force: args.force } };
}

/** Writes the suite, creating `evals/` (never through a symlink) when it is absent. Throws a `WriteFileError`. */
export function writeRecordedSuite(
  pkgAbs: string,
  plan: RecordPlan,
  doc: Extract<EvalRecordDocument, { ok: true }>,
): void {
  const evalsDir = join(pkgAbs, "evals");
  const dir = lstatOrNull(evalsDir);
  if (dir === null) mkdirSync(evalsDir);
  else if (!dir.isDirectory()) throw new WriteFileError("evals is not a plain directory");
  const target = lstatOrNull(plan.outAbs);
  if (target !== null && !target.isFile()) {
    throw new WriteFileError(`${plan.outRel} is not a regular file; refusing to replace it`);
  }
  writeFileExclusive(plan.outAbs, serialiseEvalSuite(doc.suite), { overwrite: plan.force });
}

export function skipLines(skipped: readonly EvalRecordSkip[]): string[] {
  return skipped.map((s) => `  ${stripControlChars(s.case)}: ${SKIP_TEXT[s.why]}`);
}

export function renderRecorded(
  outRel: string,
  doc: Extract<EvalRecordDocument, { ok: true }>,
): string[] {
  return [
    `wrote ${stripControlChars(outRel)}: ${doc.suite.cases.length} cases recorded, ${doc.skipped.length} skipped`,
    ...skipLines(doc.skipped),
    RECORD_NOTE,
  ];
}
