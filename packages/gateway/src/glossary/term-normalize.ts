/**
 * Surface form -> `term_key`.
 *
 * The key is what collapses "SLO", "SLOs" and "slo" into a single glossary
 * entry, so it must be stable across every mining family. Depluralization is
 * deliberately conservative: stripping `s` from short words or `ss`/`us`
 * endings would merge unrelated terms ("class" -> "clas").
 */

/** Leading/trailing punctuation that clings to a term in prose. */
const CURLY_QUOTES = "\u{201C}\u{201D}\u{2018}\u{2019}";
const EDGE_PUNCT = new RegExp(
  `^[\`"'${CURLY_QUOTES}([{<.,;:!?\\-–—]+|[\`"'${CURLY_QUOTES})\\]}>.,;:!?\\-–—]+$`,
  "g",
);

const MIN_DEPLURAL_LENGTH = 3;

function depluralize(word: string): string {
  if (word.length <= MIN_DEPLURAL_LENGTH) return word;
  if (!word.endsWith("s")) return word;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  return word.slice(0, -1);
}

/**
 * Returns the normalized key, or `""` when the input carries no term.
 * Callers MUST treat `""` as "not a term" rather than storing it.
 */
export function normalizeTerm(surface: string): string {
  const collapsed = surface.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";

  const words = collapsed
    .split(" ")
    .map((w) => w.replace(EDGE_PUNCT, ""))
    .filter((w) => w !== "");
  if (words.length === 0) return "";

  const lowered = words.map((w) => w.toLowerCase());
  const last = lowered[lowered.length - 1];
  if (last === undefined) return "";
  lowered[lowered.length - 1] = depluralize(last);

  const key = lowered.join(" ").trim();
  return key;
}
