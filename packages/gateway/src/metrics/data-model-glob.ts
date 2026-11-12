/**
 * Matches a normalized warehouse data-model key (`database.schema.table`, lower-case, see
 * `connectors/data-model-key.ts`) against a `data_models` glob from `[ci.service.<id>]` /
 * `[metrics.dora.<id>]` (Phase 10 IC2).
 *
 * `*` is the only metacharacter and matches any run of characters, dots and the empty run included; every
 * other character is literal. The match is anchored at both ends. No regular expression is built: the glob
 * is split on `*` and the literal segments are compared with `startsWith`, `indexOf` and `endsWith`, so an
 * adversarial glob or key cannot cause catastrophic backtracking (and Sonar S5852 has nothing to flag).
 * Each segment search resumes where the previous one ended, so the cost is linear in the key per segment.
 */
export function matchesDataModelGlob(glob: string, key: string): boolean {
  if (!glob.includes("*")) return glob === key;
  const segments = glob.split("*");
  const first = segments[0] ?? "";
  const last = segments.at(-1) ?? "";
  if (!key.startsWith(first)) return false;
  // The suffix may not reuse characters the prefix consumed.
  if (key.length < first.length + last.length || !key.endsWith(last)) return false;
  const end = key.length - last.length;
  let pos = first.length;
  for (const seg of segments.slice(1, -1)) {
    if (seg === "") continue;
    const at = key.indexOf(seg, pos);
    if (at === -1 || at + seg.length > end) return false;
    pos = at + seg.length;
  }
  return true;
}
