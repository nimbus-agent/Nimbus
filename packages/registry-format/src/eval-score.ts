/**
 * Deterministic eval judging and the integer scorer. Pure: no Bun, no gateway imports. Three
 * rubrics (`exact`, `json-match`, `one-of`), no model in the loop, no per-case weights.
 */
import { MAX_EVAL_JSON_DEPTH, MAX_EVAL_REPLY_BYTES } from "./caps.ts";
import {
  EVAL_RUBRIC_KINDS,
  type EvalCase,
  type EvalExpect,
  type EvalRubricKind,
  jsonDepth,
} from "./eval-suite.ts";

export const EVAL_SCORER_VERSION = 1;

export type EvalReply =
  | { readonly kind: "reply"; readonly text: string; readonly isError: boolean }
  | {
      readonly kind: "failed";
      readonly reason: "timeout" | "crash" | "unknown-tool" | "bad-reply";
    };

export interface EvalCaseOutcome {
  readonly suite: string;
  readonly case: string;
  readonly rubric: EvalRubricKind;
  readonly pass: boolean;
  readonly reason: string | null;
}

export interface EvalRubricTally {
  readonly cases: number;
  readonly passed: number;
}

export interface EvalQuality {
  readonly scorer: 1;
  readonly score: number;
  readonly cases: number;
  readonly passed: number;
  readonly rubrics: Readonly<Record<EvalRubricKind, EvalRubricTally>>;
}

export interface EvalReport extends EvalQuality {
  readonly results: readonly EvalCaseOutcome[];
}

interface Verdict {
  pass: boolean;
  reason: string | null;
}

const PASS: Verdict = { pass: true, reason: null };
const fail = (reason: string): Verdict => ({ pass: false, reason });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Unknown `$type` names never reach here: the parser (eval-suite.ts checkTypeMarkers) rejects them.
function matchesTypeMarker(type: unknown, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return typeof value === type;
  }
}

function matchesObjectPattern(pattern: Record<string, unknown>, value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const [k, sub] of Object.entries(pattern)) {
    const key = k.startsWith("$$") ? k.slice(1) : k;
    if (!Object.hasOwn(value, key) || !matchesJsonPattern(sub, value[key])) return false;
  }
  return true;
}

/** Whether `value` satisfies `pattern`: subset objects, exact arrays, `$type` markers, `$$` escape. */
export function matchesJsonPattern(pattern: unknown, value: unknown): boolean {
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) &&
      value.length === pattern.length &&
      pattern.every((p, i) => matchesJsonPattern(p, value[i]))
    );
  }
  if (isObject(pattern)) {
    const keys = Object.keys(pattern);
    if (keys.length === 1 && keys[0] === "$type") {
      return matchesTypeMarker(pattern["$type"], value);
    }
    return matchesObjectPattern(pattern, value);
  }
  return pattern === value;
}

const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/;

function step(node: unknown, token: string): { found: true; value: unknown } | { found: false } {
  if (Array.isArray(node)) {
    if (!CANONICAL_INDEX.test(token)) return { found: false };
    const index = Number(token);
    return index < node.length ? { found: true, value: node[index] } : { found: false };
  }
  if (isObject(node) && Object.hasOwn(node, token)) return { found: true, value: node[token] };
  return { found: false };
}

/** RFC 6901 lookup; `~1` then `~0` unescaping; array tokens must be canonical indexes. */
export function resolveJsonPointer(
  doc: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  if (pointer === "") return { found: true, value: doc };
  if (!pointer.startsWith("/")) return { found: false };
  let node = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const next = step(node, raw.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (!next.found) return next;
    node = next.value;
  }
  return { found: true, value: node };
}

/** Structural JSON equality: object key order is ignored, array order is not. */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((member, i) => jsonDeepEqual(member, b[i]))
    );
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && jsonDeepEqual(a[k], b[k]));
  }
  return a === b;
}

type ParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

function parseReply(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "reply is not JSON" };
  }
  if (jsonDepth(parsed) > MAX_EVAL_JSON_DEPTH) return { ok: false, reason: "reply too deep" };
  return { ok: true, value: parsed };
}

function judgeExact(value: string, text: string): Verdict {
  return text === value ? PASS : fail("text differs");
}

function judgeJsonMatch(pattern: unknown, text: string): Verdict {
  const parsed = parseReply(text);
  if (!parsed.ok) return fail(parsed.reason);
  return matchesJsonPattern(pattern, parsed.value) ? PASS : fail("pattern did not match");
}

function judgeOneOfWholeReply(values: readonly unknown[], text: string): Verdict {
  const parsed = parseReply(text);
  const hit = values.some(
    (v) => (typeof v === "string" && v === text) || (parsed.ok && jsonDeepEqual(v, parsed.value)),
  );
  return hit ? PASS : fail("value not in set");
}

function judgeOneOfPath(values: readonly unknown[], path: string, text: string): Verdict {
  const parsed = parseReply(text);
  if (!parsed.ok) return fail(parsed.reason);
  const at = resolveJsonPointer(parsed.value, path);
  if (!at.found) return fail("path not found");
  return values.some((v) => jsonDeepEqual(v, at.value)) ? PASS : fail("value not in set");
}

function judgeRubric(expectation: EvalExpect, text: string): Verdict {
  switch (expectation.rubric) {
    case "exact":
      return judgeExact(expectation.value, text);
    case "json-match":
      return judgeJsonMatch(expectation.value, text);
    case "one-of":
      return expectation.path === null
        ? judgeOneOfWholeReply(expectation.values, text)
        : judgeOneOfPath(expectation.values, expectation.path, text);
  }
}

/** Judge one case against the reply the runner got. */
export function judgeCase(c: EvalCase, reply: EvalReply): { pass: boolean; reason: string | null } {
  if (reply.kind === "failed") return fail(reply.reason);
  if (new TextEncoder().encode(reply.text).length > MAX_EVAL_REPLY_BYTES) return fail("too-large");
  if (reply.isError !== c.expect.error) {
    return fail(reply.isError ? "tool returned an error" : "tool did not return an error");
  }
  return judgeRubric(c.expect, reply.text);
}

/** The integer score over all outcomes; `null` when there are none (no score, never 0). */
export function scoreEval(outcomes: readonly EvalCaseOutcome[]): EvalReport | null {
  if (outcomes.length === 0) return null;
  const tallies = Object.fromEntries(
    EVAL_RUBRIC_KINDS.map((k) => [k, { cases: 0, passed: 0 }]),
  ) as Record<EvalRubricKind, { cases: number; passed: number }>;
  let passed = 0;
  for (const o of outcomes) {
    tallies[o.rubric].cases += 1;
    if (o.pass) {
      tallies[o.rubric].passed += 1;
      passed += 1;
    }
  }
  return {
    scorer: 1,
    score: Math.floor((passed * 100) / outcomes.length),
    cases: outcomes.length,
    passed,
    rubrics: tallies,
    results: outcomes,
  };
}
