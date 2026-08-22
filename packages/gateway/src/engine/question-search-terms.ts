/**
 * Turn a user's sentence into search terms FTS can actually match.
 *
 * F1 — `buildLocalIndexedContext` passed the whole question to `searchRankedAsync`, and
 * `ftsTitleMatchQuery` splits on whitespace only and joins every token with `AND`, keeping
 * punctuation. So "what does egressRowToItem do?" became
 *
 *   (title : "what"* OR body : "what"*) AND … AND (title : "do?"* OR body : "do?"*)
 *
 * and `"do?"` is a literal prefix term no document can match. The conjunction is unsatisfiable,
 * the search returns nothing, and — before this — the caller then fell back to arbitrary recent
 * items presented under an authoritative "Indexed Nimbus context:" header. Measured: `nimbus
 * search "egressRowToItem"` hits, the same question wrapped in a sentence returns zero rows.
 *
 * TWO properties of that `AND` join drive the design here:
 *
 *  - Every extra term can only NARROW the result. So this returns FEWER terms, not more, and
 *    a sentence that yields nothing identifier-shaped falls back to its content words rather
 *    than to all of them.
 *  - A term that matches nothing kills the whole query. Punctuation is therefore stripped from
 *    token edges, not left for FTS to treat as part of the word.
 *
 * This does NOT fix `ftsTitleMatchQuery` itself — its `AND` join, its punctuation retention and
 * its prefix-only matching (F1b) affect `nimbus search` and every other caller, and the audit is
 * explicit that changing them deserves its own PR. This is the narrow, caller-side half.
 */

/**
 * Words that carry no retrieval signal and, under an `AND` join, actively destroy results.
 *
 * Kept deliberately small: a stopword list that grows to cover general English starts removing
 * terms that are meaningful in a codebase — "index", "state", "type" and "check" are all
 * ordinary English and all real identifiers here.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "give",
  "got",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "list",
  "may",
  "me",
  "might",
  "my",
  "of",
  "on",
  "or",
  "our",
  "out",
  "please",
  "should",
  "show",
  "so",
  "some",
  "tell",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "use",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** How many terms to keep. Each additional term can only shrink the result set. */
const MAX_TERMS = 4;

/**
 * A token that looks like something a developer named, rather than English.
 *
 * camelCase, snake_case, kebab-case, dotted paths, anything carrying a digit, or a long
 * unbroken word. These are what a question is usually ABOUT — "what does egressRowToItem do?"
 * is a question about one identifier wrapped in six words of grammar.
 */
function looksLikeIdentifier(token: string): boolean {
  if (token.length >= 3 && /[a-z][A-Z]/.test(token)) return true;
  if (/[_/.]/.test(token) && token.length >= 4) return true;
  if (/\d/.test(token) && /[a-zA-Z]/.test(token)) return true;
  if (/-/.test(token) && token.length >= 6) return true;
  return token.length >= 14;
}

/**
 * Strip punctuation from the EDGES only.
 *
 * Interior punctuation is load-bearing — `a/b/c.ts`, `foo_bar`, `v2.1` — while trailing `?`,
 * `,` and `.` are grammar. Quotes go entirely: `ftsTitleMatchQuery` escapes them into the FTS
 * string, where they are noise.
 */
const LEADING_PUNCTUATION = new Set(['"', "'", "`", "(", "[", "{", "<"]);
const TRAILING_PUNCTUATION = new Set([
  '"',
  "'",
  "`",
  ")",
  "]",
  "}",
  ">",
  ",",
  ".",
  ";",
  ":",
  "!",
  "?",
]);

/**
 * Character walks rather than a regex. `/^[…]+|[…]+$/` is an anchored alternation of two
 * quantified classes, which backtracks super-linearly on a long run of punctuation — Sonar
 * `S8786`, and the same ReDoS shape a correctness test would never catch, since every result
 * here is correct and only the time is wrong. A token like `"""""""…` is not hypothetical input
 * for a search box.
 */
function normalizeToken(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && LEADING_PUNCTUATION.has(raw[start] ?? "")) start++;
  while (end > start && TRAILING_PUNCTUATION.has(raw[end - 1] ?? "")) end--;
  return raw.slice(start, end);
}

/**
 * `undefined` when the sentence yields nothing worth searching for — an empty question, or one
 * made entirely of stopwords. The caller must treat that as "no context", never as "search for
 * everything": returning arbitrary rows under a context header is the failure this exists to
 * prevent.
 */
export function questionSearchTerms(question: string): string | undefined {
  const tokens = question
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;

  const identifiers = tokens.filter(looksLikeIdentifier);
  // When the question names something identifier-shaped, that IS the question. Adding its
  // surrounding English can only narrow an already-precise match.
  const chosen =
    identifiers.length > 0 ? identifiers : tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (chosen.length === 0) return undefined;

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const t of chosen) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
    if (deduped.length >= MAX_TERMS) break;
  }
  return deduped.join(" ");
}

/**
 * The terms to retry INDIVIDUALLY when the full conjunction matches nothing, most distinctive
 * first.
 *
 * `ftsTitleMatchQuery` joins terms with `AND`, so three reasonable words can easily describe a
 * document that contains only two of them — "what should I do for the smoke test issue?" against
 * an item titled "add a smoke test" fails on `issue`, which appears in neither its title nor its
 * body even though the item IS an issue. Narrowing to one term is not a guess about intent; it is
 * the same query with the strictest part relaxed.
 *
 * Longest-wins as a distinctiveness proxy: within one question the longer word is the more
 * specific one far more often than not, and the alternative — a corpus frequency lookup — buys
 * little for a tiebreak between two words the user chose deliberately.
 *
 * Empty when there is nothing to widen to, i.e. the term set was already a single term. The caller
 * must NOT then fall back to an unfiltered search: see the no-name fallback comment in
 * `run-ask.ts` for what that produced.
 */
export function fallbackSearchTerms(terms: string): string[] {
  const parts = terms.split(" ").filter((t) => t.length > 0);
  if (parts.length <= 1) return [];
  // Longest first as a distinctiveness proxy, but ALL of them in turn rather than one guess.
  // Picking a single "most distinctive" term looked reasonable and was wrong on the first real
  // question it met: "what changed in billing?" ties `changed` and `billing` at seven characters,
  // and the arbitrary winner was the verb. Trying each is at most a handful of cheap FTS queries,
  // and only when the full conjunction already returned nothing.
  return [...parts].sort((a, b) => b.length - a.length || parts.indexOf(a) - parts.indexOf(b));
}
