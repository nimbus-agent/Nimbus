/**
 * Registry-signed eval quality on an index version entry. The index signature covers the parsed
 * document, so `parseRegistryIndex` carries `quality` RAW; a reader validates it here and a
 * malformed value degrades to `invalid` rather than throwing.
 */
import { MAX_EVAL_CASES } from "./caps.ts";
import { RegistryError } from "./errors.ts";
import { EVAL_SCORER_VERSION, type EvalQuality } from "./eval-score.ts";
import { EVAL_RUBRIC_KINDS } from "./eval-suite.ts";
import type { RegistryVersionEntry } from "./index-format.ts";

export type VersionQuality =
  | { readonly state: "scored"; readonly quality: EvalQuality }
  | { readonly state: "unscored" }
  | { readonly state: "invalid"; readonly reason: string };

function bad(why: string): RegistryError {
  return new RegistryError("ERR_REGISTRY_EVAL_QUALITY_INVALID", why);
}

function plainObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad(`${what} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  const have = Object.keys(o);
  const extra = have.filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !have.includes(k));
  if (extra.length > 0) throw bad(`${what} has unexpected keys: ${extra.join(", ")}`);
  if (missing.length > 0) throw bad(`${what} is missing keys: ${missing.join(", ")}`);
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw bad(`${what} must be an integer from ${min} to ${max}`);
  }
  return v;
}

export function parseEvalQuality(raw: unknown): EvalQuality {
  const o = plainObject(raw, "quality");
  exactKeys(o, ["scorer", "score", "cases", "passed", "rubrics"], "quality");
  if (o["scorer"] !== EVAL_SCORER_VERSION) throw bad("quality.scorer is not a known scorer");
  const cases = int(o["cases"], 1, MAX_EVAL_CASES, "quality.cases");
  const passed = int(o["passed"], 0, cases, "quality.passed");
  const score = int(o["score"], 0, 100, "quality.score");
  if (score !== Math.floor((passed * 100) / cases)) {
    throw bad("quality.score does not match passed and cases");
  }
  const rubricsRaw = plainObject(o["rubrics"], "quality.rubrics");
  exactKeys(rubricsRaw, EVAL_RUBRIC_KINDS, "quality.rubrics");
  let sumCases = 0;
  let sumPassed = 0;
  const rubrics: Record<string, { cases: number; passed: number }> = {};
  for (const kind of EVAL_RUBRIC_KINDS) {
    const t = plainObject(rubricsRaw[kind], `quality.rubrics.${kind}`);
    exactKeys(t, ["cases", "passed"], `quality.rubrics.${kind}`);
    const c = int(t["cases"], 0, cases, `quality.rubrics.${kind}.cases`);
    const p = int(t["passed"], 0, c, `quality.rubrics.${kind}.passed`);
    rubrics[kind] = { cases: c, passed: p };
    sumCases += c;
    sumPassed += p;
  }
  if (sumCases !== cases || sumPassed !== passed) {
    throw bad("quality.rubrics do not sum to the totals");
  }
  return { scorer: 1, score, cases, passed, rubrics } as EvalQuality;
}

/** Read a version entry's quality. Never throws: a malformed value is `invalid`, not an error. */
export function readVersionQuality(entry: RegistryVersionEntry): VersionQuality {
  const raw = entry.quality;
  if (raw === undefined) return { state: "unscored" };
  try {
    return { state: "scored", quality: parseEvalQuality(raw) };
  } catch (e) {
    const reason = e instanceof RegistryError ? e.detail : "quality is malformed";
    return { state: "invalid", reason };
  }
}
