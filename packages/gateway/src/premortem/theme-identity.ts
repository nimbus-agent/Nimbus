import { createHash } from "node:crypto";

import { stripAffixWhere } from "../util/strip-affixes.ts";

/**
 * Identity and confidence for a recurring blocker theme.
 *
 * Normalization is deliberately shallow — case, whitespace and surrounding
 * punctuation only. Stemming or synonym-folding would merge "timeout" with
 * "latency", destroying exactly the distinction a reader needs.
 */

/**
 * Trimmed at either end only, so internal punctuation ("2xx/5xx") survives.
 *
 * This was a regex \u2014 `/^[\s\u2026]+|[\s\u2026]+$/g` \u2014 until Sonar flagged it as
 * super-linear (`typescript:S8786`), correctly: the `[\u2026]+$` alternative is
 * retried from every start offset, so a long run of trimmable characters that
 * does not reach the end backtracks quadratically. Theme labels come from LLM
 * output over indexed third-party text, which is exactly the attacker-adjacent
 * input where that matters.
 *
 * Whitespace stays in the edge set even though `split(/\s+/).filter(Boolean)`
 * below would drop leading/trailing blanks anyway. It is load-bearing for
 * INTERLEAVED edges: in `"  (hello)"` the first character is a space, so a
 * punctuation-only trim would stop there and leave the `(` in place.
 */
const EDGE_PUNCTUATION_CHARS = "\"'\u201c\u201d\u2018\u2019.,;:!?()[]-";

function isEdgeChar(ch: string): boolean {
  // Single-character test \u2014 constant time, no backtracking possible. `\s` rather
  // than a literal list so NBSP and the unicode space run trim like a space.
  return EDGE_PUNCTUATION_CHARS.includes(ch) || /^\s$/.test(ch);
}

export function normalizeThemeLabel(raw: string): string {
  return stripAffixWhere(raw, isEdgeChar).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Content-derived, never positional: a typo fix earlier in a source document
 * must not re-hash this theme and orphan its accumulated evidence rows.
 * Service-scoped, because "rate limits" on `billing-api` and on `search` are
 * two different findings.
 *
 * Guards against TWO hash-collision classes, both real:
 *
 * 1. A naive bare-join of `service` and `label` (`h.update(service + label)`)
 *    lets a boundary shift produce the same bytes from different inputs:
 *    `themeId("x y", "z")` and `themeId("x", "y z")` would hash identically,
 *    silently merging two unrelated themes under one id. This bug shipped
 *    once at this exact site.
 * 2. Uses length-prefixed encoding with ":" terminators: the boundary between a
 *    length prefix (decimal digits) and the data itself is ambiguous if left
 *    undelimited, since digit-starting data can create collisions. For example,
 *    themeId("1", "1".repeat(11)) and themeId("1".repeat(11), "1") would both
 *    encode to fifteen '1' characters without the terminator. The ":" separator
 *    (which cannot appear in a decimal length) makes the boundary unambiguous.
 */
export function themeId(service: string, rawLabel: string): string {
  const normalized = normalizeThemeLabel(rawLabel);
  const h = createHash("sha256");
  h.update(`${String(service.length)}:`);
  h.update(service);
  h.update(`${String(normalized.length)}:`);
  h.update(normalized);
  return h.digest("hex").slice(0, 32);
}

/**
 * Ceiling, not a cap applied at the end: no connector indexes ticket comments,
 * so this pass is structurally blind to a blocker argued out entirely in a
 * comment thread. Mirrors `decisions`' 0.86 for the same class of reason.
 */
export const THEME_CONFIDENCE_CEILING = 0.86;

/**
 * Derived from corroboration COUNT — never from the model's self-report, which
 * is the rule `decisions` established. Saturating, so one loud epic cannot
 * outrank four quiet corroborating ones.
 */
export function themeConfidence(evidenceCount: number): number {
  if (evidenceCount <= 0) {
    return 0;
  }
  return THEME_CONFIDENCE_CEILING * (1 - 1 / (1 + evidenceCount));
}
