/**
 * Canonical key for a warehouse table/view, shared across every Slice-7
 * connector so cross-connector lineage edges converge on ONE graph node.
 * Lower-cases, strips quoting (`"` / `` ` `` / `[]`), trims each part, and
 * joins with `.`. Returns null when no usable identifier survives.
 *
 * LIMITATION (deliberate, YAGNI): splits blindly on `.`, so a *quoted literal
 * dot* inside an identifier (e.g. `ANALYTICS.PUBLIC."Sales.2026"`) is split
 * into extra parts. Warehouse identifiers containing literal dots are
 * vanishingly rare; a quote-aware tokenizer is intentionally not implemented.
 */
// Quote/bracket chars stripped from each identifier part. Asymmetric on purpose:
// a part may open with ` " [ and close with ` " ] (matching SQL quoting styles).
const LEAD_QUOTES = '`"[';
const TRAIL_QUOTES = '`"]';

// Linear (no-regex) leading/trailing quote strip. Replaces a trailing `[...]+$`
// regex whose unanchored start scan is O(n²) on adversarial input (S8786).
function stripQuoteWrap(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && LEAD_QUOTES.includes(s.charAt(i))) i++;
  while (j > i && TRAIL_QUOTES.includes(s.charAt(j - 1))) j--;
  return s.slice(i, j);
}

export function normalizeDataModelKey(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw
    .split(".")
    .map((p) => stripQuoteWrap(p.trim()).trim().toLowerCase())
    .filter((p) => p !== "");
  return parts.length === 0 ? null : parts.join(".");
}
