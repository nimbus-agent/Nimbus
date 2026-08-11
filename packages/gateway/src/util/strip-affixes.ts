/**
 * Edge-trimming helpers.
 *
 * These exist as loops rather than as regexes on purpose. The obvious spellings
 * — `s.replace(/[chars]+$/, "")` and `s.replace(/^[chars]+|[chars]+$/g, "")` —
 * are super-linear: an `[X]+$` alternative is retried from every start offset,
 * so a long run of `X` that does NOT reach the end costs O(n²) backtracking.
 * That is a denial-of-service shape on any attacker-influenced string, and a
 * correctness test can never catch it — the output is right, only the time is
 * wrong. Every trim below is a single linear scan from each end.
 *
 * If you add a variant here, add a time-bounded test alongside the correctness
 * ones (`strip-affixes.test.ts`), not instead of them.
 */

/** Drop every trailing character that appears in `chars`. */
export function stripTrailingChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** Drop every leading AND trailing character that appears in `chars`. */
export function stripAffixChars(s: string, chars: string): string {
  return stripAffixWhere(s, (ch) => chars.includes(ch));
}

/**
 * `stripAffixChars` for edge sets a literal character list cannot express —
 * chiefly "any whitespace", where a hand-written list silently misses NBSP,
 * line/paragraph separators and the unicode space run.
 *
 * `isAffix` is called on ONE character at a time, so a regex inside it (e.g.
 * `/^\s$/.test(ch)`) stays constant-time and cannot reintroduce the
 * backtracking this module exists to avoid.
 */
export function stripAffixWhere(s: string, isAffix: (ch: string) => boolean): string {
  let start = 0;
  let end = s.length;
  while (start < end && isAffix(s.charAt(start))) start++;
  while (end > start && isAffix(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}
