/**
 * The one sentence that turns a truncated `ask` enumeration from a wrong answer into a
 * qualified one.
 *
 * `buildLocalIndexedContext` hands the model at most `LOCAL_CONTEXT_ITEM_LIMIT` items. That is a
 * defensible context budget; serving the result as a complete answer to "list my X" is not.
 * Observed: a clean numbered list of 8 CloudWatch log groups, no ellipsis and no caveat, for a
 * user who has 16 — an answer indistinguishable from a correct one, since the only way to catch
 * it is to already know the true count, which is what the tool was asked for.
 *
 * The line is CONSTRUCTED here and appended to the reply by the same deterministic path that
 * carries negation disclosures — never handed to the model as an instruction it may or may not
 * follow. That mirrors what invariant I31 requires of `negotiate`'s list-truncation clause: the
 * briefs already treat "the list you are reading is not the whole list" as something that has to
 * survive a rewrite, and `ask` truncates far harder than any brief does.
 */
export interface ContextTruncation {
  /** Items actually placed in the model's context. */
  readonly shown: number;
  /** Matches found. When `atLeast`, the real total may be higher — see `PROBE` in run-ask.ts. */
  readonly total: number;
  /** `total` is a floor, not an exact count: the probe itself hit its ceiling. */
  readonly atLeast: boolean;
}

/**
 * `undefined` when nothing was withheld.
 *
 * Deliberately not "showing 8 of 8" — a disclosure that fires on every answer is noise, and
 * noise is what gets skimmed past on the one answer where it mattered.
 */
export function contextTruncationLine(t: ContextTruncation): string | undefined {
  if (t.total <= t.shown) return undefined;
  const total = t.atLeast ? `at least ${String(t.total)}` : String(t.total);
  return (
    `_Note: this answer was written from ${String(t.shown)} indexed items, but ${total} match. ` +
    "Any list above is a sample, not the complete set — run `nimbus query` or `nimbus search` " +
    "for the full result._"
  );
}
