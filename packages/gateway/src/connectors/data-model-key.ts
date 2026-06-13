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
export function normalizeDataModelKey(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw
    .split(".")
    .map((p) =>
      p
        .trim()
        .replace(/^[`"[]+/, "")
        .replace(/[`"\]]+$/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((p) => p !== "");
  return parts.length === 0 ? null : parts.join(".");
}
