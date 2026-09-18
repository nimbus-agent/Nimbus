import { codeUnitCompare } from "../util/code-unit-compare.ts";

/**
 * The next window of a rotation: up to `max` distinct keys starting at the first key STRICTLY
 * greater than `cursor`, wrapping to the start. A key cursor, not an ordinal — an ordinal shifts when
 * a subject is added or deleted and would silently skip or repeat one (spec § 6). A list no longer
 * than `max` is returned whole, once.
 */
export function selectSweepWindow(
  keys: readonly string[],
  cursor: string | null,
  max: number,
): string[] {
  const sorted = [...keys].sort(codeUnitCompare);
  if (sorted.length <= max) return sorted;
  let start = 0;
  if (cursor !== null) {
    const next = sorted.findIndex((k) => codeUnitCompare(k, cursor) > 0);
    start = next === -1 ? 0 : next;
  }
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const k = sorted[(start + i) % sorted.length];
    if (k !== undefined) out.push(k);
  }
  return out;
}
