/**
 * Surface form -> `term_key`.
 *
 * The key is what collapses "SLO", "SLOs" and "slo" into a single glossary
 * entry, so it must be stable across every mining family. Depluralization is
 * deliberately conservative: stripping `s` from short words or `ss`/`us`
 * endings would merge unrelated terms ("class" -> "clas"). The same
 * conservatism exempts a word carrying an internal `.` — an identifier or
 * filename ("node.js", "next.js", "d3.js"), never an English plural — since
 * the naive rule would otherwise read the "s" in ".js" as a plural suffix and
 * truncate it to "node.j". Known remaining wart: "https" -> "http" is still
 * wrong (it needs an acronym allowlist, not this exemption) — accepted
 * because a general consonant+s exemption would break the headline case
 * ("SLOs" -> "slo").
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
  // A leading or trailing `.` is already stripped by EDGE_PUNCT before this
  // runs, so any `.` still present here is internal — the word is an
  // identifier or filename ("node.js"), not a plural.
  if (word.includes(".")) return word;
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
