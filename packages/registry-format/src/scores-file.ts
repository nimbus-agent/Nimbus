/**
 * `scores.json`: the untrusted output of the secret-free score job, and the ONE judge of what it
 * may sign into a version entry (eval spec § 4.6, ruling R8). The registry action's `sign` mode and
 * the CLI's `maintain add` both read it here, so the two cannot disagree. Entries are keyed
 * `<id>@<version>` and bound to a package by `packageSha256`.
 *
 * A baseline in an entry is optional and never blocks: a malformed or unbound one is ignored with
 * a reason (`baselineIgnored`), while the `quality` rules stay exactly as they were. This file
 * reads the filesystem (`readScores`), so it is not part of the pure index surface, but it imports
 * nothing from gateway, cli or ui and uses no ES2024+ runtime API (it runs under the runner's Node).
 */
import { closeSync, openSync, readSync } from "node:fs";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { type EvalBaseline, parseEvalBaseline } from "./eval-baseline.ts";
import { parseEvalQuality } from "./eval-quality.ts";
import type { EvalQuality } from "./eval-score.ts";
import type { PublishVerdict } from "./validate-publish.ts";

/** The most bytes the `scores` input may hold; a larger file fails the run. */
export const MAX_SCORES_BYTES = 4 * 1024 * 1024;

/** `scores.json`, read once: its entries by key (`<id>@<version>`), still UNTRUSTED. */
export type Scores = ReadonlyMap<string, unknown>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function refuseScores(path: string, why: string): Error {
  return new Error(`refusing to sign: the scores input (${path}) ${why}`);
}

/** How much `readAtMost` reads at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * At most `max` bytes of the file at `path`, however large the file is, read in chunks so the
 * memory held is what the file holds (up to `max`), never `max` up front.
 */
function readAtMost(path: string, max: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < max) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, max - total));
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      chunks.push(chunk.subarray(0, got));
      total += got;
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The `scores` input, read once. A file that is unreadable, over `MAX_SCORES_BYTES`, not JSON or
 * not a JSON object fails the run: a broken artifact is not "no scores". The entries go into a
 * `Map`, so an untrusted key (`__proto__`, `toString`) is only ever a key.
 */
export function readScores(path: string): Scores {
  let bytes: Uint8Array;
  try {
    bytes = readAtMost(path, MAX_SCORES_BYTES + 1);
  } catch (e) {
    throw refuseScores(path, `could not be read: ${errorText(e)}`);
  }
  if (bytes.byteLength > MAX_SCORES_BYTES) {
    throw refuseScores(path, `is larger than ${String(MAX_SCORES_BYTES)} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw refuseScores(path, "is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw refuseScores(path, "is not a JSON object");
  return new Map(Object.entries(parsed));
}

/**
 * What a candidate's `scores.json` entry decides: sign (with a quality and/or a baseline, or
 * neither), or skip. `baselineIgnored` says why an entry's baseline was not used; it never skips.
 */
export type ScoreDecision =
  | { ok: true; quality?: EvalQuality; baseline?: EvalBaseline; baselineIgnored?: string }
  | { ok: false; reason: string };

/** The longest validator message a skip reason repeats. */
const MAX_REASON_DETAIL_CHARS = 300;

const MALFORMED =
  "its scores.json entry is malformed (want exactly packageSha256 and one of quality or error); not signed without a score";

const BASELINE_UNBOUND =
  "its scores.json entry is not a baseline entry for this package (want exactly packageSha256 and baseline); ignored";

const BASELINE_INVALID = "its scores.json baseline is invalid; signed without a baseline";

/** A failed entry's error code when it looks like one; otherwise a fixed one. */
function failedCode(error: unknown): string {
  const c = isPlainObject(error) ? error["code"] : undefined;
  return typeof c === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : "ERR_EVAL_FAILED";
}

const sortedKeys = (o: Record<string, unknown>): string =>
  Object.keys(o).sort(codeUnitCompare).join(",");

/** The baseline of an entry already known to carry one, or the reason it is ignored. */
function baselineOf(
  raw: Record<string, unknown>,
): Pick<Extract<ScoreDecision, { ok: true }>, "baseline" | "baselineIgnored"> {
  try {
    return { baseline: parseEvalBaseline(raw["baseline"]) };
  } catch {
    return { baselineIgnored: BASELINE_INVALID };
  }
}

/** A candidate with no eval suite: its own `packageSha256` + `baseline` entry, or nothing. */
function judgeBaselineOnly(
  scores: Scores,
  v: Pick<PublishVerdict, "id" | "version" | "packageSha256">,
): ScoreDecision {
  const raw = scores.get(`${v.id}@${v.version}`);
  if (raw === undefined) return { ok: true };
  if (
    !isPlainObject(raw) ||
    sortedKeys(raw) !== "baseline,packageSha256" ||
    raw["packageSha256"] !== v.packageSha256
  ) {
    return { ok: true, baselineIgnored: BASELINE_UNBOUND };
  }
  return { ok: true, ...baselineOf(raw) };
}

/** A candidate with an eval suite: the `quality` rules of ruling R8, plus an optional baseline. */
function judgeSuite(
  scores: Scores,
  v: Pick<PublishVerdict, "id" | "version" | "packageSha256" | "starterPack">,
): ScoreDecision {
  const raw = scores.get(`${v.id}@${v.version}`);
  if (raw === undefined) {
    return {
      ok: false,
      reason: "it has eval suites and scores.json has no score for it; not signed without a score",
    };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: MALFORMED };
  const keys = sortedKeys(raw);
  const withBaseline = keys.startsWith("baseline,");
  const core = withBaseline ? keys.slice("baseline,".length) : keys;
  if (core !== "packageSha256,quality" && core !== "error,packageSha256") {
    return { ok: false, reason: MALFORMED };
  }
  if (raw["packageSha256"] !== v.packageSha256) {
    return {
      ok: false,
      reason: "its scores.json entry is for another package (packageSha256 differs); not signed",
    };
  }
  if (Object.hasOwn(raw, "error")) {
    return {
      ok: false,
      reason: `its eval failed (${failedCode(raw["error"])}); not signed without a score`,
    };
  }
  let quality: EvalQuality;
  try {
    quality = parseEvalQuality(raw["quality"]);
  } catch (e) {
    const detail = errorText(e).slice(0, MAX_REASON_DETAIL_CHARS);
    return { ok: false, reason: `its score is invalid: ${detail}; not signed` };
  }
  if (!withBaseline || v.starterPack) return { ok: true, quality };
  return { ok: true, quality, ...baselineOf(raw) };
}

/**
 * What to sign for `v`, judged from the untrusted `scores` (ruling R8). No input: sign with
 * nothing. A package with an eval suite signs only an entry under its own `<id>@<version>`, for
 * its own `packageSha256`, holding a quality `parseEvalQuality` accepts (rebuilt to exactly its
 * five keys); the entry may also carry a `baseline`. A package without a suite signs a baseline
 * from an entry of exactly `packageSha256` and `baseline`. A starter pack never runs, so it never
 * takes a baseline. An unusable baseline is `baselineIgnored`, never a skip.
 */
export function judgeScoreEntry(
  scores: Scores | undefined,
  v: Pick<PublishVerdict, "id" | "version" | "packageSha256" | "hasEvals" | "starterPack">,
): ScoreDecision {
  if (scores === undefined) return { ok: true };
  if (v.hasEvals) return judgeSuite(scores, v);
  if (v.starterPack) return { ok: true };
  return judgeBaselineOnly(scores, v);
}
