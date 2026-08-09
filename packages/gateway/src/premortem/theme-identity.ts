import { createHash } from "node:crypto";

/**
 * Identity and confidence for a recurring blocker theme.
 *
 * Normalization is deliberately shallow — case, whitespace and surrounding
 * punctuation only. Stemming or synonym-folding would merge "timeout" with
 * "latency", destroying exactly the distinction a reader needs.
 */

/** Matched at either end only, so internal punctuation ("2xx/5xx") survives. */
const EDGE_PUNCTUATION =
  /^[\s"'\u201c\u201d\u2018\u2019.,;:!?()[\]-]+|[\s"'\u201c\u201d\u2018\u2019.,;:!?()[\]-]+$/g;

export function normalizeThemeLabel(raw: string): string {
  return raw.replace(EDGE_PUNCTUATION, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Content-derived, never positional: a typo fix earlier in a source document
 * must not re-hash this theme and orphan its accumulated evidence rows.
 * Service-scoped, because "rate limits" on `billing-api` and on `search` are
 * two different findings.
 */
export function themeId(service: string, rawLabel: string): string {
  const h = createHash("sha256");
  h.update(service);
  h.update(" ");
  h.update(normalizeThemeLabel(rawLabel));
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
