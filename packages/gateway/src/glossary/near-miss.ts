import { normalizeTerm } from "./term-normalize.ts";

/**
 * Deterministic synonym + near-miss derivation.
 *
 * Synonyms come from the `Expansion (ACRONYM)` pattern that teams write
 * naturally in docs and tickets — no LLM needed, and the result is verifiable
 * against the source text.
 */

const EXPANSION_RE = /\b((?:[A-Z][A-Za-z0-9]*\s+){1,5})\(([A-Z]{2,6})\)/g;

const MAX_EDIT_DISTANCE = 2;
const DEFAULT_NEAR_MISS_LIMIT = 5;

function initials(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toLowerCase();
}

export function detectAcronymExpansions(
  text: string,
): Array<{ acronymKey: string; expansion: string }> {
  const out: Array<{ acronymKey: string; expansion: string }> = [];
  EXPANSION_RE.lastIndex = 0;
  let m: RegExpExecArray | null = EXPANSION_RE.exec(text);
  while (m !== null) {
    const phrase = (m[1] ?? "").trim();
    const acronym = m[2] ?? "";
    if (phrase !== "" && acronym !== "" && initials(phrase) === acronym.toLowerCase()) {
      out.push({ acronymKey: normalizeTerm(acronym), expansion: phrase });
    }
    m = EXPANSION_RE.exec(text);
  }
  return out;
}

/** Bounded Levenshtein — returns `MAX_EDIT_DISTANCE + 1` once the budget is blown. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? MAX_EDIT_DISTANCE + 1;
}

export function findNearMisses(
  termKey: string,
  knownKeys: readonly string[],
  limit: number = DEFAULT_NEAR_MISS_LIMIT,
): string[] {
  const out: string[] = [];
  for (const k of knownKeys) {
    if (k === termKey) continue;
    if (editDistance(termKey, k) <= MAX_EDIT_DISTANCE) out.push(k);
    if (out.length >= limit) break;
  }
  return out;
}
