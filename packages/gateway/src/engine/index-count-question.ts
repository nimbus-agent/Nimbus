import type { Database } from "bun:sqlite";

/**
 * "How many X are in the index?" is a `SELECT COUNT(*)`, not something to ask a model.
 *
 * F23 — asked how many PRs the index held, `ask` answered "3", then "2.2 PRs: Wingetbot PR Triage
 * (queued) and Wingetbot PR Triage (pending)", then nothing. Ground truth was 173.
 *
 * Two things beyond the wrong number. `2.2` is proof the model was not counting anything — no
 * arithmetic over any set yields 2.2, it is a plausible-looking token. And the two items it named
 * as PRs were `github_actions` workflow runs, F12b's swamping delivering non-PR rows into the
 * context of a question explicitly about PRs.
 *
 * The root shape is F1's and F14's: the model answers about the CONTEXT while the user asked about
 * the INDEX, and nothing distinguishes them. A count is the worst case of that family — a
 * truncated list at least looks partial, while a bare number carries no signal that it came from
 * three items out of 173, and people trust numbers more than lists.
 *
 * So the number is computed here and appended deterministically, by the same path that carries the
 * other disclosures. The model may still phrase it badly; it can no longer be the source of it.
 */

/**
 * Question words that ask for a cardinality. Narrow on purpose: "how many" and "count" are
 * unambiguous, while "what are my PRs" is an enumeration (F14's territory, which discloses
 * truncation rather than counting).
 */
const COUNT_QUESTION = /\b(how many|number of|count of|total number)\b/i;

/**
 * Plural nouns a user reaches for, mapped to the `item.type` they mean.
 *
 * Deliberately small and exact. A fuzzy mapping is worse than none here: answering "how many
 * builds" with the `ci_run` count would be a confident answer to a question that was not asked,
 * and this whole finding is about confident answers to adjacent questions.
 */
const TYPE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(prs?|pull requests?)\b/i, "pr"],
  [/\bissues?\b/i, "issue"],
  [/\bcommits?\b/i, "commit"],
  [/\bdeployments?\b/i, "deployment"],
  [/\bincidents?\b/i, "incident"],
  [/\breviews?\b/i, "review"],
];

export interface IndexCount {
  /** The `item.type` counted, or `null` for every indexed item. */
  readonly itemType: string | null;
  readonly total: number;
}

/** The `item.type` a count question is about, or `undefined` when it is not a count question. */
export function countQuestionType(input: string): string | null | undefined {
  if (!COUNT_QUESTION.test(input)) return undefined;
  for (const [re, type] of TYPE_WORDS) {
    if (re.test(input)) return type;
  }
  // A count question naming no type we index — "how many people", "how many services". `null`
  // means "all items", which is a real, answerable number; the caller decides whether that is
  // what was asked. Returning a guess instead would be the failure this module exists to remove.
  return null;
}

/** `undefined` when the question is not a count question, so the caller appends nothing. */
export function indexCountFor(db: Database, input: string): IndexCount | undefined {
  const itemType = countQuestionType(input);
  if (itemType === undefined) return undefined;
  try {
    const row = (
      itemType === null
        ? db.query("SELECT COUNT(*) AS n FROM item")
        : db.query("SELECT COUNT(*) AS n FROM item WHERE type = ?")
    ).get(...(itemType === null ? [] : [itemType])) as { n: number } | null;
    return { itemType, total: row?.n ?? 0 };
  } catch {
    // A count that cannot be read is not a count that is zero. Saying nothing leaves the model's
    // answer unqualified, which is where this started — but asserting 0 would be worse: it is a
    // specific claim, and a wrong specific claim is what F23 IS.
    return undefined;
  }
}

/**
 * The authoritative line, appended to the reply after the model has run.
 *
 * States the exact number and where it came from, so a reader can tell it apart from the prose
 * above it — which may still say something else.
 */
export function indexCountLine(count: IndexCount): string {
  const what = count.itemType === null ? "indexed item" : `indexed \`${count.itemType}\` item`;
  const plural = count.total === 1 ? "" : "s";
  return (
    `_Counted from the index: **${String(count.total)}** ${what}${plural}. ` +
    "This number is a direct query, not the model's estimate — any count in the text above it " +
    "was written from a handful of retrieved items._"
  );
}
