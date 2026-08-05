import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CueTier } from "./decision-types.ts";

export interface CueHit {
  readonly sentence: string;
  readonly normalized: string;
  readonly cueText: string;
  readonly tier: CueTier;
}

/** The sentence-final punctuation `normalizeSentence` strips. */
const TAIL_PUNCTUATION = new Set([".", "!", "?", ",", ";", ":"]);

/**
 * Drop the trailing run of sentence punctuation.
 *
 * Deliberately a backward scan, NOT `.replace(/[.!?,;:]+$/u, "")`. That
 * pattern has no start anchor, so the engine restarts the greedy `+` at every
 * position of a punctuation run and re-fails the `$` check after each —
 * Σ(n−i), quadratic in the run length. Measured on Bun 1.3 against the exact
 * prior expression: 2 KB 2.1 ms, 4 KB 8.4 ms, 8 KB 35 ms, 16 KB 142 ms,
 * 32 KB 591 ms — a clean 4x per doubling. `normalizeSentence` runs on every
 * mined sentence of every indexed item, and item bodies are remote-attacker-
 * controlled, so `"...".repeat(n)` in a message body is a denial of service
 * rather than a slow path. The scan below visits each trailing character
 * once and stops at the first non-punctuation one.
 */
function stripTailPunctuation(s: string): string {
  let end = s.length;
  while (end > 0 && TAIL_PUNCTUATION.has(s[end - 1] ?? "")) {
    end -= 1;
  }
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Sentence-level normalisation, local to this module rather than borrowed from
 * `glossary`'s `normalizeTerm`. That helper normalises single TERMS and would
 * strip the internal structure a sentence needs; the two operations only look
 * alike. Keeping it local also avoids a glossary↔decisions import edge.
 */
export function normalizeSentence(raw: string): string {
  return stripTailPunctuation(raw.toLowerCase().replace(/\s+/g, " ").trim()).trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Ordered most-specific first. `mineCues` takes the FIRST match per sentence,
 * so a sentence carrying both a heading and a weak cue is tiered by the
 * stronger one.
 */
const CUES: ReadonlyArray<{ re: RegExp; tier: CueTier }> = [
  // `(?:#{1,4}\s*)?` rather than the obvious `#{0,4}\s*`. With the zero-count
  // arm allowed, the leading `\s*` and the trailing `\s*` both match plain
  // whitespace, so every way of splitting a whitespace run between them is a
  // distinct path the engine has to try before the literal can fail —
  // quadratic in the run length at the single `^` start position. Measured on
  // Bun 1.3 against the exact prior pattern, on `" ".repeat(n) + "x"`: 2 KB
  // 3.5 ms, 4 KB 13.6 ms, 8 KB 53 ms, 16 KB 221 ms, 32 KB 882 ms — a clean
  // 4x per doubling, on remote-attacker-controlled item text. Requiring at
  // least one `#` inside the optional group makes the two whitespace runs
  // disjoint (a `#` has to separate them) without changing what matches:
  // "zero hashes" is exactly the group being absent, and `\s*\s*` accepts the
  // same whitespace run as a single `\s*`.
  { re: /^\s*(?:#{1,4}\s*)?(decision|outcome|resolution)\s*:/iu, tier: "heading" },
  { re: /\brfc\s+accepted\b/iu, tier: "heading" },
  { re: /\bwe\s+(?:have\s+)?decided\b/iu, tier: "explicit" },
  { re: /\bwe(?:'ve|\s+have)\s+agreed\b/iu, tier: "explicit" },
  { re: /\bwe\s+agreed\s+to\b/iu, tier: "explicit" },
  { re: /\bthe\s+decision\s+(?:was|is)\b/iu, tier: "explicit" },
  { re: /\bwe(?:'ve|\s+have)\s+settled\s+on\b/iu, tier: "explicit" },
  { re: /\bwe'll\s+use\b/iu, tier: "weak" },
  { re: /\bwe\s+will\s+use\b/iu, tier: "weak" },
  { re: /\bgoing\s+with\b/iu, tier: "weak" },
  { re: /\blet's\s+go\s+with\b/iu, tier: "weak" },
  { re: /\binstead\s+of\b/iu, tier: "weak" },
];

export function mineCues(text: string): CueHit[] {
  const hits: CueHit[] = [];
  for (const sentence of splitSentences(text)) {
    for (const { re, tier } of CUES) {
      const m = re.exec(sentence);
      if (m === null) continue;
      hits.push({
        sentence,
        normalized: normalizeSentence(sentence),
        cueText: m[0].trim(),
        tier,
      });
      break; // one hit per sentence — see the ordering note above
    }
  }
  return hits;
}

/**
 * The two id fields are LENGTH-PREFIXED, not delimiter-joined, because that is
 * *provably* injective for any field contents whatsoever.
 *
 * A delimiter is injective only while the delimiter cannot occur inside a
 * field, and that is an assumption about connector data rather than a property
 * of the encoding. Joining on a space demonstrably collides `("slack:a b","c")`
 * with `("slack:a","b c")` — item ids are `${service}:${externalId}` with a
 * connector-supplied `externalId` — giving two different decisions one row id,
 * one silently overwriting the other. A NUL joiner only moves that assumption
 * somewhere less likely to be violated; it does not remove it. `<len>:<field>`
 * removes it outright: the field boundary is read from the prefix, so no field
 * content can shift it.
 *
 * `String.length` counts UTF-16 code units, the same unit a substring boundary
 * would be read in, so the encoding stays uniquely decodable for astral-plane
 * text too.
 *
 * Changing this after release re-hashes every stored row and forces a full
 * `--rebuild`, so it is a pre-merge-only decision.
 */
function lengthPrefixed(field: string): string {
  return `${String(field.length)}:${field}`;
}

/**
 * Content-derived identity: hash(sourceItemId, normalized cue sentence).
 *
 * Deliberately NOT positional. Keying on the cue's character offset would mean
 * a typo fix earlier in a document re-hashes every later cue — re-queueing rows
 * already extracted and, worse, resurrecting `vetoed` rows under new ids so the
 * model is asked again about candidates it already rejected.
 */
export function decisionRowId(sourceItemId: string, normalizedSentence: string): string {
  const encoder = new TextEncoder();
  const joined = `${lengthPrefixed(sourceItemId)}${lengthPrefixed(normalizedSentence)}`;
  const digest = bytesToHex(blake3(encoder.encode(joined)));
  return digest.slice(0, 32);
}
