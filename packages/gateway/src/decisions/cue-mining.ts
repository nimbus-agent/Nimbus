import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { CueTier } from "./decision-types.ts";

export interface CueHit {
  readonly sentence: string;
  readonly normalized: string;
  readonly cueText: string;
  readonly tier: CueTier;
}

/**
 * Sentence-level normalisation, local to this module rather than borrowed from
 * `glossary`'s `normalizeTerm`. That helper normalises single TERMS and would
 * strip the internal structure a sentence needs; the two operations only look
 * alike. Keeping it local also avoids a glossary↔decisions import edge.
 */
export function normalizeSentence(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
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
  { re: /^\s*#{0,4}\s*(decision|outcome|resolution)\s*:/iu, tier: "heading" },
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
 * NUL joins the two id fields because neither can contain it. A space could:
 * item ids are `${service}:${externalId}` with a connector-supplied
 * `externalId`, so joining on one collides `("a b", "c")` with `("a", "b c")`
 * — two different decisions sharing a row id, one silently overwriting the
 * other. Changing this after release would re-hash every stored row and force
 * a full `--rebuild`, so it is fixed pre-merge.
 */
const ID_FIELD_SEPARATOR = "\u0000";

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
  const joined = `${sourceItemId}${ID_FIELD_SEPARATOR}${normalizedSentence}`;
  const digest = bytesToHex(blake3(encoder.encode(joined)));
  return digest.slice(0, 32);
}
