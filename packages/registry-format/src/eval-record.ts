/**
 * Golden recording: the inputs file an author writes, the pure rule that turns two fresh runs'
 * replies into an eval suite, and the document the `__nimbus-eval` record role prints. Pure: no
 * Bun, no gateway imports. A reply-originated object key starting with `$` is always written with
 * one more `$`, so a bare `$type` key in a generated pattern is a marker the recorder put there.
 */
import {
  MAX_EVAL_CASES,
  MAX_EVAL_JSON_DEPTH,
  MAX_EVAL_REPLY_BYTES,
  MAX_EVAL_SUITE_FILE_BYTES,
} from "./caps.ts";
import { RegistryError } from "./errors.ts";
import { type EvalReply, jsonDeepEqual, judgeCase } from "./eval-score.ts";
import {
  assertKeys,
  checkString,
  decodeSuite,
  type EvalCase,
  type EvalExpect,
  isPlainObject,
  jsonDepth,
  NAME_MAX,
  parseEvalSuite,
  parseInput,
  TOOL_MAX,
} from "./eval-suite.ts";

export const EVAL_RECORD_INPUTS_FORMAT = 1;
export const MAX_EVAL_RECORD_INPUTS_BYTES = 1024 * 1024;

export type EvalRecordInput = {
  readonly name: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
};
export type EvalRecordInputs = {
  readonly name: string;
  readonly cases: readonly EvalRecordInput[];
};

function refuse(file: string, why: string): never {
  throw new RegistryError("ERR_REGISTRY_EVAL_SUITE_INVALID", `${file}: ${why}`);
}

function parseInputCase(file: string, index: number, raw: unknown, seen: Set<string>) {
  const where = `cases[${index}]`;
  if (!isPlainObject(raw)) refuse(file, `${where}: case must be an object`);
  assertKeys(file, where, raw, ["name", "tool", "input"]);
  const name = checkString(file, `${where}.name`, raw.name, NAME_MAX);
  if (seen.has(name)) refuse(file, `${where}: duplicate case name "${name}"`);
  seen.add(name);
  const tool = checkString(file, `${where}.tool`, raw.tool, TOOL_MAX);
  return { name, tool, input: parseInput(file, where, raw.input) };
}

/** Parse the inputs file: a suite with no `expect`, under the same rules and caps. */
export function parseEvalRecordInputs(file: string, bytes: Uint8Array): EvalRecordInputs {
  if (bytes.length > MAX_EVAL_RECORD_INPUTS_BYTES) {
    refuse(file, `inputs file is too large (over ${MAX_EVAL_RECORD_INPUTS_BYTES} bytes)`);
  }
  // Windows PowerShell 5.1 writes a BOM by default; one is stripped here (suites still refuse it).
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = decodeSuite(file, hasBom ? bytes.subarray(3) : bytes, "inputs file");
  if (!isPlainObject(raw)) refuse(file, "inputs file must be a JSON object");
  assertKeys(file, "inputs", raw, ["format", "name", "cases"]);
  if (raw.format !== EVAL_RECORD_INPUTS_FORMAT) {
    refuse(file, `format must be ${EVAL_RECORD_INPUTS_FORMAT}`);
  }
  const name = checkString(file, "name", raw.name, NAME_MAX);
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    refuse(file, "cases must be a non-empty array");
  }
  if (raw.cases.length > MAX_EVAL_CASES) {
    refuse(file, `${raw.cases.length} cases; at most ${MAX_EVAL_CASES} are allowed`);
  }
  const seen = new Set<string>();
  return { name, cases: raw.cases.map((c, i) => parseInputCase(file, i, c, seen)) };
}

export const EVAL_RECORD_SKIP_REASONS = [
  "call-failed",
  "error-flag-differs",
  "reply-too-large",
  "reply-too-deep",
  "changes-type",
  "changes-shape",
  "changes-not-json",
  "self-check-failed",
] as const;
export type EvalRecordSkipReason = (typeof EVAL_RECORD_SKIP_REASONS)[number];
export type EvalRecordSkip = { readonly case: string; readonly why: EvalRecordSkipReason };
export type RecordedSuite = {
  readonly suite: { format: 1; name: string; cases: unknown[] };
  readonly skipped: readonly EvalRecordSkip[];
};

type Merged = { ok: true; value: unknown } | { ok: false; why: EvalRecordSkipReason };
const skip = (why: EvalRecordSkipReason): Merged => ({ ok: false, why });
const done = (value: unknown): Merged => ({ ok: true, value });

const escapeKey = (key: string): string => (key.startsWith("$") ? `$${key}` : key);

/** The value with every object key that starts with `$` written with one more `$`. */
function escapeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(escapeKeys);
  if (isPlainObject(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, m]) => [escapeKey(k), escapeKeys(m)]));
  }
  return v;
}

const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean"]);

function mergeObjects(a: Record<string, unknown>, b: Record<string, unknown>): Merged {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) continue;
    const m = merge(a[key], b[key]);
    if (!m.ok) return m;
    entries.push([escapeKey(key), m.value]);
  }
  return entries.length === 0 ? skip("changes-shape") : done(Object.fromEntries(entries));
}

function mergeArrays(a: unknown[], b: unknown[]): Merged {
  if (a.length !== b.length) return skip("changes-shape");
  const out: unknown[] = [];
  for (let i = 0; i < a.length; i++) {
    const m = merge(a[i], b[i]);
    if (!m.ok) return m;
    out.push(m.value);
  }
  return done(out);
}

function merge(a: unknown, b: unknown): Merged {
  if (jsonDeepEqual(a, b)) return done(escapeKeys(a));
  if (Array.isArray(a) && Array.isArray(b)) return mergeArrays(a, b);
  if (isPlainObject(a) && isPlainObject(b)) return mergeObjects(a, b);
  if (typeof a === typeof b && SCALAR_TYPES.has(typeof a)) return done({ $type: typeof a });
  return skip("changes-type");
}

function isBareMarker(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).length === 1 && Object.hasOwn(v, "$type");
}

function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** The expectation for one case's two replies, or why it is skipped. */
function expectFor(
  first: Extract<EvalReply, { kind: "reply" }>,
  second: Extract<EvalReply, { kind: "reply" }>,
): { ok: true; expect: EvalExpect } | { ok: false; why: EvalRecordSkipReason } {
  const error = first.isError;
  if (first.text === second.text) {
    return { ok: true, expect: { rubric: "exact", value: first.text, error } };
  }
  const a = tryParse(first.text);
  const b = tryParse(second.text);
  if (!a.ok || !b.ok) return { ok: false, why: "changes-not-json" };
  // The merge below recurses, so it only ever sees replies within the depth cap (measured
  // iteratively), and the pattern it builds is measured again: a leaf wrapped in a `$type` marker
  // sits one level deeper than the reply.
  if (jsonDepth(a.value) > MAX_EVAL_JSON_DEPTH || jsonDepth(b.value) > MAX_EVAL_JSON_DEPTH) {
    return { ok: false, why: "reply-too-deep" };
  }
  const m = merge(a.value, b.value);
  if (!m.ok) return m;
  if (jsonDepth(m.value) > MAX_EVAL_JSON_DEPTH) return { ok: false, why: "reply-too-deep" };
  // A root that is only a type marker, or an empty object or array, would accept almost any reply.
  if (isBareMarker(m.value) || isEmptyContainer(m.value)) {
    return { ok: false, why: "changes-shape" };
  }
  return { ok: true, expect: { rubric: "json-match", value: m.value, error } };
}

function preflight(
  first: EvalReply,
  second: EvalReply,
):
  | { ok: true; first: EvalReplyOk; second: EvalReplyOk }
  | { ok: false; why: EvalRecordSkipReason } {
  if (first.kind === "failed" || second.kind === "failed") return { ok: false, why: "call-failed" };
  if (first.isError !== second.isError) return { ok: false, why: "error-flag-differs" };
  if (
    byteLength(first.text) > MAX_EVAL_REPLY_BYTES ||
    byteLength(second.text) > MAX_EVAL_REPLY_BYTES
  ) {
    return { ok: false, why: "reply-too-large" };
  }
  return { ok: true, first, second };
}
type EvalReplyOk = Extract<EvalReply, { kind: "reply" }>;

type BuiltCase = { ok: true; value: EvalCase } | { ok: false; why: EvalRecordSkipReason };

/** One case, never throwing: anything unexpected is that case's `self-check-failed`. */
function buildCase(c: EvalRecordInput, first: EvalReply, second: EvalReply): BuiltCase {
  try {
    return buildCaseUnguarded(c, first, second);
  } catch {
    return { ok: false, why: "self-check-failed" };
  }
}

function buildCaseUnguarded(c: EvalRecordInput, first: EvalReply, second: EvalReply): BuiltCase {
  const pre = preflight(first, second);
  if (!pre.ok) return pre;
  const e = expectFor(pre.first, pre.second);
  if (!e.ok) return e;
  const built: EvalCase = { name: c.name, tool: c.tool, input: c.input, expect: e.expect };
  if (!judgeCase(built, first).pass || !judgeCase(built, second).pass) {
    return { ok: false, why: "self-check-failed" };
  }
  return { ok: true, value: built };
}

/**
 * Turn two fresh runs' replies (in input order) into a suite plus the cases that could not be
 * recorded. With no case left it still returns the empty suite; the caller refuses it. A case
 * that would push the serialised suite past the suite file cap is skipped as `reply-too-large`
 * and the rest are still tried, so this never throws for size.
 */
export function buildRecordedSuite(
  inputs: EvalRecordInputs,
  first: readonly EvalReply[],
  second: readonly EvalReply[],
): RecordedSuite {
  if (first.length !== inputs.cases.length || second.length !== inputs.cases.length) {
    refuse("record", "a reply is missing for a case");
  }
  const cases: unknown[] = [];
  const skipped: EvalRecordSkip[] = [];
  const suite = { format: 1 as const, name: inputs.name, cases };
  inputs.cases.forEach((c, i) => {
    const r = buildCase(c, first[i] as EvalReply, second[i] as EvalReply);
    if (!r.ok) {
      skipped.push({ case: c.name, why: r.why });
      return;
    }
    cases.push(r.value);
    if (suiteBytes(suite).length > MAX_EVAL_SUITE_FILE_BYTES) {
      cases.pop();
      skipped.push({ case: c.name, why: "reply-too-large" });
    }
  });
  if (cases.length > 0) serialiseEvalSuite(suite);
  return { suite, skipped };
}

function suiteBytes(suite: RecordedSuite["suite"]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(suite, null, 2)}\n`);
}

/** The suite as the bytes `parseEvalSuite` reads back: 2-space JSON and a trailing newline. */
export function serialiseEvalSuite(suite: RecordedSuite["suite"]): Uint8Array {
  const bytes = suiteBytes(suite);
  if (bytes.length > MAX_EVAL_SUITE_FILE_BYTES) {
    refuse("record", `the recorded suite is larger than ${MAX_EVAL_SUITE_FILE_BYTES} bytes`);
  }
  parseEvalSuite("record", bytes);
  return bytes;
}

export type EvalRecordDocument =
  | {
      ok: true;
      extensionId: string;
      version: string;
      suite: RecordedSuite["suite"];
      skipped: readonly EvalRecordSkip[];
    }
  | {
      ok: false;
      error: { code: string; message: string; skipped?: readonly EvalRecordSkip[] };
    };

const DOC_ID_MAX = 256;
const DOC_MESSAGE_MAX = 1000;

function hasOnlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function parseSkipped(raw: unknown): EvalRecordSkip[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EVAL_CASES) return null;
  const out: EvalRecordSkip[] = [];
  for (const s of raw) {
    if (!isPlainObject(s) || !hasOnlyKeys(s, ["case", "why"])) return null;
    const why = s["why"];
    if (typeof s["case"] !== "string" || s["case"].length > NAME_MAX) return null;
    if (typeof why !== "string" || !(EVAL_RECORD_SKIP_REASONS as readonly string[]).includes(why)) {
      return null;
    }
    out.push({ case: s["case"], why: why as EvalRecordSkipReason });
  }
  return out;
}

function parseRecordError(raw: unknown): Extract<EvalRecordDocument, { ok: false }> | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["ok", "error"])) return null;
  const e = raw["error"];
  if (!isPlainObject(e) || !hasOnlyKeys(e, ["code", "message", "skipped"])) return null;
  if (typeof e["code"] !== "string" || typeof e["message"] !== "string") return null;
  // A long message (paths, library text) is cut, not refused: the code and the skips still matter.
  const message = e["message"].slice(0, DOC_MESSAGE_MAX);
  if (e["skipped"] === undefined) return { ok: false, error: { code: e["code"], message } };
  const skipped = parseSkipped(e["skipped"]);
  if (skipped === null) return null;
  return { ok: false, error: { code: e["code"], message, skipped } };
}

function parseRecordSuccess(raw: Record<string, unknown>): EvalRecordDocument | null {
  if (!hasOnlyKeys(raw, ["ok", "extensionId", "version", "suite", "skipped"])) return null;
  if (typeof raw["extensionId"] !== "string" || typeof raw["version"] !== "string") return null;
  if (raw["extensionId"].length > DOC_ID_MAX || raw["version"].length > DOC_ID_MAX) return null;
  const skipped = parseSkipped(raw["skipped"]);
  if (skipped === null || !isPlainObject(raw["suite"])) return null;
  try {
    parseEvalSuite("record", new TextEncoder().encode(JSON.stringify(raw["suite"])));
  } catch {
    return null;
  }
  return {
    ok: true,
    extensionId: raw["extensionId"],
    version: raw["version"],
    suite: raw["suite"] as RecordedSuite["suite"],
    skipped,
  };
}

/** Validate the record role's document; null when it is not one. */
export function parseEvalRecordDocument(text: string): EvalRecordDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  if (raw["ok"] === false) return parseRecordError(raw);
  return raw["ok"] === true ? parseRecordSuccess(raw) : null;
}
