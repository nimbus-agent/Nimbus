/**
 * The eval suite format: `evals/<name>.eval.json`, direct children of `evals/` only. A frozen
 * schema (unknown keys are refused) so a suite means the same thing to every judge. Pure: no Bun,
 * no gateway imports. A suite that fails to parse refuses with `ERR_REGISTRY_EVAL_SUITE_INVALID`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_EVAL_CASES,
  MAX_EVAL_INPUT_BYTES,
  MAX_EVAL_JSON_DEPTH,
  MAX_EVAL_SUITE_FILE_BYTES,
  MAX_EVAL_SUITES,
} from "./caps.ts";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { RegistryError } from "./errors.ts";

export const EVAL_SUITE_FORMAT = 1;
export const EVALS_DIR = "evals";

export type EvalRubricKind = "exact" | "json-match" | "one-of";
export const EVAL_RUBRIC_KINDS: readonly EvalRubricKind[] = ["exact", "json-match", "one-of"];

export type EvalExpect =
  | { readonly rubric: "exact"; readonly value: string; readonly error: boolean }
  | { readonly rubric: "json-match"; readonly value: unknown; readonly error: boolean }
  | {
      readonly rubric: "one-of";
      readonly values: readonly unknown[];
      readonly path: string | null;
      readonly error: boolean;
    };

export interface EvalCase {
  readonly name: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expect: EvalExpect;
}

export interface EvalSuite {
  readonly file: string;
  readonly name: string;
  readonly cases: readonly EvalCase[];
}

const SUITE_FILE_RE = /^evals\/[^/]+\.eval\.json$/;
const TYPE_MARKER_VALUES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "array",
  "object",
]);
const NAME_MAX = 120;
const TOOL_MAX = 128;

/** Whether a `/`-separated path relative to the extension root is an eval suite file. */
export function isEvalSuiteFile(relPath: string): boolean {
  return SUITE_FILE_RE.test(relPath);
}

function refuse(file: string, why: string): never {
  throw new RegistryError("ERR_REGISTRY_EVAL_SUITE_INVALID", `${file}: ${why}`);
}

/** A primitive or null is 0; an array or object is 1 + the deepest member (1 when empty). Iterative. */
export function jsonDepth(v: unknown): number {
  let max = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: v, depth: 0 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { value, depth } = top;
    if (typeof value !== "object" || value === null) {
      if (depth > max) max = depth;
      continue;
    }
    const level = depth + 1;
    if (level > max) max = level;
    for (const member of Object.values(value)) {
      stack.push({ value: member, depth: level });
    }
  }
  return max;
}

/** A parsed JSON object; the known keys are declared so reading them is not an index access. */
type RawObject = Record<string, unknown> & {
  format?: unknown;
  name?: unknown;
  cases?: unknown;
  tool?: unknown;
  input?: unknown;
  expect?: unknown;
  rubric?: unknown;
  value?: unknown;
  values?: unknown;
  path?: unknown;
  error?: unknown;
  $type?: unknown;
};

function isPlainObject(v: unknown): v is RawObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertKeys(file: string, where: string, obj: RawObject, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) refuse(file, `${where}: unknown key "${key}"`);
  }
}

function checkString(file: string, where: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.length < 1 || v.length > max) {
    refuse(file, `${where} must be a string of 1 to ${max} characters`);
  }
  return v;
}

function checkDepth(file: string, where: string, v: unknown): void {
  if (jsonDepth(v) > MAX_EVAL_JSON_DEPTH) {
    refuse(file, `${where} exceeds the JSON depth limit of ${MAX_EVAL_JSON_DEPTH}`);
  }
}

/** Every pattern object holding `$type` must hold only it, with a known type name. */
function checkTypeMarkers(file: string, where: string, v: unknown): void {
  if (Array.isArray(v)) {
    for (const member of v) checkTypeMarkers(file, where, member);
    return;
  }
  if (!isPlainObject(v)) return;
  if (Object.hasOwn(v, "$type")) {
    const marker = v.$type;
    if (
      Object.keys(v).length !== 1 ||
      typeof marker !== "string" ||
      !TYPE_MARKER_VALUES.has(marker)
    ) {
      refuse(
        file,
        `${where}: invalid $type marker (only "$type" with one of ${[...TYPE_MARKER_VALUES].join("|")})`,
      );
    }
    return;
  }
  for (const member of Object.values(v)) checkTypeMarkers(file, where, member);
}

function parseErrorFlag(file: string, where: string, raw: RawObject): boolean {
  if (raw.error === undefined) return false;
  if (typeof raw.error !== "boolean") refuse(file, `${where}.error must be a boolean`);
  return raw.error;
}

function parseOneOf(file: string, where: string, raw: RawObject): EvalExpect {
  assertKeys(file, where, raw, ["rubric", "error", "values", "path"]);
  const values = raw.values;
  if (!Array.isArray(values) || values.length === 0) {
    refuse(file, `${where}.values must be a non-empty array`);
  }
  for (const v of values) checkDepth(file, `${where}.values`, v);
  let path: string | null = null;
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || (raw.path !== "" && !raw.path.startsWith("/"))) {
      refuse(file, `${where}${".path"} must be "" or an RFC 6901 pointer starting with "/"`);
    }
    path = raw.path;
  }
  return { rubric: "one-of", values, path, error: parseErrorFlag(file, where, raw) };
}

function parseExpect(file: string, where: string, raw: unknown): EvalExpect {
  if (!isPlainObject(raw)) refuse(file, `${where} must be an object`);
  const rubric = raw.rubric;
  if (typeof rubric !== "string" || !(EVAL_RUBRIC_KINDS as readonly string[]).includes(rubric)) {
    refuse(file, `${where}.rubric must be one of ${EVAL_RUBRIC_KINDS.join(", ")}`);
  }
  if (rubric === "one-of") return parseOneOf(file, where, raw);
  assertKeys(file, where, raw, ["rubric", "error", "value"]);
  if (!("value" in raw)) refuse(file, `${where}.value is required for rubric ${rubric}`);
  const error = parseErrorFlag(file, where, raw);
  if (rubric === "exact") {
    if (typeof raw.value !== "string")
      refuse(file, `${where}.value must be a string for rubric exact`);
    return { rubric: "exact", value: raw.value, error };
  }
  checkDepth(file, `${where}.value`, raw.value);
  checkTypeMarkers(file, `${where}.value`, raw.value);
  return { rubric: "json-match", value: raw.value, error };
}

function parseInput(file: string, where: string, raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) refuse(file, `${where}.input must be an object`);
  checkDepth(file, `${where}.input`, raw);
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_EVAL_INPUT_BYTES) {
    refuse(file, `${where}.input is larger than ${MAX_EVAL_INPUT_BYTES} bytes`);
  }
  return raw;
}

function parseCase(file: string, index: number, raw: unknown, seen: Set<string>): EvalCase {
  const where = `cases[${index}]`;
  if (!isPlainObject(raw)) refuse(file, `${where}: case must be an object`);
  assertKeys(file, where, raw, ["name", "tool", "input", "expect"]);
  const name = checkString(file, `${where}.name`, raw.name, NAME_MAX);
  if (seen.has(name)) refuse(file, `${where}: duplicate case name "${name}"`);
  seen.add(name);
  const tool = checkString(file, `${where}.tool`, raw.tool, TOOL_MAX);
  const input = parseInput(file, where, raw.input);
  return { name, tool, input, expect: parseExpect(file, `${where}.expect`, raw.expect) };
}

function decodeSuite(file: string, bytes: Uint8Array): unknown {
  if (bytes.length > MAX_EVAL_SUITE_FILE_BYTES) {
    refuse(file, `suite file is too large (over ${MAX_EVAL_SUITE_FILE_BYTES} bytes)`);
  }
  // TextDecoder strips a leading BOM from its output, so the bytes are checked directly.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    refuse(file, "suite file must not start with a BOM");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return refuse(file, "suite file is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    return refuse(file, "suite file is not valid JSON");
  }
}

/** Parse one suite file's bytes; refuses with `ERR_REGISTRY_EVAL_SUITE_INVALID` on any violation. */
export function parseEvalSuite(file: string, bytes: Uint8Array): EvalSuite {
  const raw = decodeSuite(file, bytes);
  if (!isPlainObject(raw)) refuse(file, "suite must be a JSON object");
  assertKeys(file, "suite", raw, ["format", "name", "cases"]);
  if (raw.format !== EVAL_SUITE_FORMAT) refuse(file, `format must be ${EVAL_SUITE_FORMAT}`);
  const name = checkString(file, "name", raw.name, NAME_MAX);
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    refuse(file, "cases must be a non-empty array");
  }
  const seen = new Set<string>();
  const cases = raw.cases.map((c, i) => parseCase(file, i, c, seen));
  return { file, name, cases };
}

/** Parse every suite file, sorted by file name; at most 20 files and 200 cases in total. */
export function parseEvalSuites(
  files: readonly { file: string; bytes: Uint8Array }[],
): EvalSuite[] {
  if (files.length > MAX_EVAL_SUITES) {
    refuse(EVALS_DIR, `${files.length} suite files; at most ${MAX_EVAL_SUITES} are allowed`);
  }
  const sorted = [...files].sort((a, b) => codeUnitCompare(a.file, b.file));
  const suites = sorted.map((f) => parseEvalSuite(f.file, f.bytes));
  const total = suites.reduce((n, s) => n + s.cases.length, 0);
  if (total > MAX_EVAL_CASES) {
    refuse(EVALS_DIR, `${total} cases in total; at most ${MAX_EVAL_CASES} are allowed`);
  }
  return suites;
}

/** The suites under `<packageDir>/evals`: direct children only; a symlink or non-file suite is refused. */
export function loadEvalSuites(packageDir: string): EvalSuite[] {
  const dir = join(packageDir, EVALS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: { file: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const rel = `${EVALS_DIR}/${name}`;
    if (!isEvalSuiteFile(rel)) continue;
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) refuse(rel, "refusing a symlink as an eval suite");
    if (!st.isFile()) refuse(rel, "an eval suite must be a regular file");
    files.push({ file: rel, bytes: readFileSync(join(dir, name)) });
  }
  return parseEvalSuites(files);
}
