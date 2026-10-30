/**
 * The eval suite format: `evals/<name>.eval.json`, direct children of `evals/` only. A frozen
 * schema (unknown keys are refused) so a suite means the same thing to every judge. Pure: no Bun,
 * no gateway imports. A suite that fails to parse refuses with `ERR_REGISTRY_EVAL_SUITE_INVALID`.
 */
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  MAX_ENTRY_COUNT,
  MAX_EVAL_CASES,
  MAX_EVAL_INPUT_BYTES,
  MAX_EVAL_JSON_DEPTH,
  MAX_EVAL_SUITE_FILE_BYTES,
  MAX_EVAL_SUITES,
  MAX_MANIFEST_BYTES,
  MAX_UNPACKED_BYTES,
} from "./caps.ts";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { RegistryError } from "./errors.ts";
import { EVALS_DIR, PACKAGE_MANIFEST_FILE } from "./package-set.ts";

export const EVAL_SUITE_FORMAT = 1;
export { EVALS_DIR };

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
      refuse(file, `path of ${where} must be "" or an RFC 6901 pointer starting with "/"`);
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
  if (raw.cases.length > MAX_EVAL_CASES) {
    refuse(file, `${raw.cases.length} cases; at most ${MAX_EVAL_CASES} are allowed`);
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
  const names = new Set<string>();
  for (const f of files) {
    if (names.has(f.file)) refuse(f.file, "duplicate suite file entry");
    names.add(f.file);
  }
  const sorted = [...files].sort((a, b) => codeUnitCompare(a.file, b.file));
  const suites = sorted.map((f) => parseEvalSuite(f.file, f.bytes));
  const total = suites.reduce((n, s) => n + s.cases.length, 0);
  if (total > MAX_EVAL_CASES) {
    refuse(EVALS_DIR, `${total} cases in total; at most ${MAX_EVAL_CASES} are allowed`);
  }
  return suites;
}

const LOOSE_SUITE_RE = /\.eval\.json$/i;

/** lstat the `evals` directory: missing is `null`; a symlink or a non-directory is refused. */
function statEvalsDir(dir: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (st.isSymbolicLink()) refuse(EVALS_DIR, "refusing a symlink as the evals directory");
  if (!st.isDirectory()) refuse(EVALS_DIR, "evals must be a directory");
  return true;
}

/**
 * Whether `rel`, the direct `evals/` child `name`, is a suite. A name that is a suite name in any
 * letter case but not exactly `<name>.eval.json` is refused rather than silently skipped.
 */
function isSuiteChild(rel: string, name: string): boolean {
  if (isEvalSuiteFile(rel)) return true;
  if (LOOSE_SUITE_RE.test(name)) {
    refuse(rel, 'a suite file must be named exactly "<name>.eval.json"');
  }
  return false;
}

/** How one file is read: its size cap, how a refusal names it, and which error refuses it. */
interface ReadLimit {
  readonly max: number;
  readonly label: string;
  readonly kind: string;
  readonly fail: (rel: string, why: string) => never;
}

function fileSetRefuse(rel: string, why: string): never {
  throw new RegistryError("ERR_REGISTRY_PACKAGE_FILE_SET", `${rel}: ${why}`);
}

const SUITE_LIMIT: ReadLimit = {
  max: MAX_EVAL_SUITE_FILE_BYTES,
  label: "suite file",
  kind: "an eval suite",
  fail: refuse,
};
const MANIFEST_LIMIT: ReadLimit = {
  max: MAX_MANIFEST_BYTES,
  label: "manifest",
  kind: "a package file",
  fail: fileSetRefuse,
};
const PACKAGE_FILE_LIMIT: ReadLimit = {
  max: MAX_UNPACKED_BYTES,
  label: "package file",
  kind: "a package file",
  fail: fileSetRefuse,
};

/** Read one suite file after lstat checks; the size is checked before any read. */
function readSuiteFile(dir: string, name: string): { file: string; bytes: Uint8Array } | null {
  const rel = `${EVALS_DIR}/${name}`;
  if (!isSuiteChild(rel, name)) return null;
  return { file: rel, bytes: readNoFollow(join(dir, name), rel, SUITE_LIMIT) };
}

const NO_FOLLOW_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Read at most `size` bytes from `fd` into a `size + 1` buffer, looping until EOF. A byte past
 * `size` means the file grew after the fstat that sized (and capped) it: `onOverflow` refuses it,
 * so no read ever overshoots the cap checked from that fstat. A file that shrank yields fewer bytes.
 */
export function readExactly(fd: number, size: number, onOverflow: () => never): Uint8Array {
  const buf = new Uint8Array(size + 1);
  let got = 0;
  for (;;) {
    const n = readSync(fd, buf, got, buf.length - got, null);
    if (n === 0) return buf.subarray(0, got);
    got += n;
    if (got > size) onOverflow();
  }
}

/**
 * The path, lstat'ed after the open, must be a regular file with the descriptor's own device and
 * inode: a symlink (followed by a Windows open) or a file swapped in after the open is refused.
 */
function assertPathIsDescriptor(
  full: string,
  st: BigIntStats,
  rel: string,
  limit: ReadLimit,
): void {
  const now = lstatSync(full, { bigint: true });
  if (now.isSymbolicLink()) limit.fail(rel, `refusing a symlink as ${limit.kind}`);
  if (!now.isFile()) limit.fail(rel, `${limit.kind} must be a regular file`);
  if (now.dev !== st.dev || now.ino !== st.ino) {
    limit.fail(rel, `${limit.kind} changed while it was opened`);
  }
}

/**
 * Open first (`O_NOFOLLOW` refuses a symlink on POSIX), then classify, size-check and read through
 * that ONE descriptor. Where `O_NOFOLLOW` does not exist (Windows) the path is lstat'ed AFTER the
 * open and must be a regular file that is the very file the descriptor holds — so neither a
 * symlink nor a file swapped in between is ever the one read.
 */
function readNoFollow(full: string, rel: string, limit: ReadLimit): Uint8Array {
  let fd: number;
  try {
    fd = openSync(full, NO_FOLLOW_OPEN_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      limit.fail(rel, `refusing a symlink as ${limit.kind}`);
    }
    throw err;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) limit.fail(rel, `${limit.kind} must be a regular file`);
    assertPathIsDescriptor(full, st, rel, limit);
    if (st.size > BigInt(limit.max)) {
      limit.fail(rel, `${limit.label} is too large (over ${limit.max} bytes)`);
    }
    const size = Number(st.size);
    return readExactly(fd, size, () =>
      limit.fail(rel, `${limit.label} grew while it was read (over ${size} bytes)`),
    );
  } finally {
    closeSync(fd);
  }
}

/** The suites under `<packageDir>/evals`: direct children only; a symlink or non-file suite is refused. */
export function loadEvalSuites(packageDir: string): EvalSuite[] {
  const dir = join(packageDir, EVALS_DIR);
  if (!statEvalsDir(dir)) return [];
  const files: { file: string; bytes: Uint8Array }[] = [];
  for (const name of readdirSync(dir)) {
    const f = readSuiteFile(dir, name);
    if (f !== null) files.push(f);
  }
  return parseEvalSuites(files);
}

const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(["", ".", ".."]);

/** A `/`-separated path that stays inside the package: no `\`, no empty, `.` or `..` segment. */
function assertPackageRelative(rel: string): void {
  if (rel.includes("\\") || rel.split("/").some((seg) => UNSAFE_SEGMENTS.has(seg))) {
    fileSetRefuse(JSON.stringify(rel), "not a /-separated package-relative path");
  }
}

function limitFor(rel: string): ReadLimit {
  if (isEvalSuiteFile(rel)) return SUITE_LIMIT;
  return rel === PACKAGE_MANIFEST_FILE ? MANIFEST_LIMIT : PACKAGE_FILE_LIMIT;
}

/**
 * Read each of `files` (package-relative, `/`-separated; normally `listPackageFiles(dir)`) ONCE,
 * through one no-follow descriptor per file: a symlink or a non-regular file is refused, a suite
 * is held to `MAX_EVAL_SUITE_FILE_BYTES`, the manifest to `MAX_MANIFEST_BYTES`, and all of them
 * together to `MAX_UNPACKED_BYTES` and `MAX_ENTRY_COUNT` files. Everything a caller derives from a
 * package (manifest, suites, digest) comes from this one map, so no file can differ between uses.
 */
export function readEvalPackageFiles(
  dir: string,
  files: readonly string[],
): Map<string, Uint8Array> {
  if (files.length > MAX_ENTRY_COUNT) {
    fileSetRefuse(dir, `${files.length} files; at most ${MAX_ENTRY_COUNT} are allowed`);
  }
  const seen = new Set<string>();
  for (const rel of files) {
    assertPackageRelative(rel);
    if (seen.has(rel)) fileSetRefuse(rel, "duplicate file entry");
    seen.add(rel);
  }
  const out = new Map<string, Uint8Array>();
  let used = 0;
  for (const rel of files) {
    const limit = limitFor(rel);
    const max = Math.min(limit.max, MAX_UNPACKED_BYTES - used);
    const bytes = readNoFollow(join(dir, ...rel.split("/")), rel, { ...limit, max });
    used += bytes.byteLength;
    out.set(rel, bytes);
  }
  return out;
}

/**
 * The suites among already-read package files (`readEvalPackageFiles`), with `loadEvalSuites`'s
 * rules: only direct `evals/<name>.eval.json` children are suites, a wrong-case suite name is
 * refused, and so is a directory named like a suite (it shows up as a path beneath it).
 */
export function evalSuitesFromFiles(files: ReadonlyMap<string, Uint8Array>): EvalSuite[] {
  const suites: { file: string; bytes: Uint8Array }[] = [];
  const prefix = `${EVALS_DIR}/`;
  for (const [rel, bytes] of files) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const child = `${prefix}${name}`;
    if (child !== rel) {
      if (LOOSE_SUITE_RE.test(name)) refuse(child, `${SUITE_LIMIT.kind} must be a regular file`);
      continue;
    }
    if (isSuiteChild(rel, name)) suites.push({ file: rel, bytes });
  }
  return parseEvalSuites(suites);
}
