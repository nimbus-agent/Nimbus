# Review & Suggestions: `nimbus glossary` Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-07-30-nimbus-glossary.md](file:///C:/gitrep/Nimbus/.claude/worktrees/nimbus-glossary/docs/superpowers/plans/2026-07-30-nimbus-glossary.md).

---

## 1. Head-of-Line Blocking in the Consolidation Queue (Task 11)

### The Issue

In Task 11, `consolidatePhase` selects the top `max_new_terms_per_pass` (default 25) pending terms ordered by score descending:

```typescript
const batch = selectPendingBatch(db, opts.maxNewTermsPerPass);
```

If a set of high-scoring terms repeatedly fails to consolidate (e.g., due to model timeouts, transient JSON parse failures, or empty responses), they will return `kind: "retry"`. Because they remain `status = 'pending'`, they will continue to have the highest scores and will be selected in the next pass, completely blocking lower-scoring but potentially successful terms from ever being consolidated.

### Suggestions

1. **Retry Limits or Backoff:** Add a `retry_count` or `last_attempted_at` column to the `glossary_term` table.
2. **Queue Filtering:** Modify `selectPendingBatch` to either:
   - Exclude terms that have failed too many times (e.g., `retry_count < 3`).
   - Prioritize terms that have not been attempted recently (e.g., sorting by a combination of score and cooldown).
3. **Plan Update:** Under Task 11 and Task 7 (`glossary-store.ts`), track attempts or filter out items that recently retried if head-of-line blocking becomes an issue.

---

## 2. Resource Overhead in the Reconciliation Sweep (Task 10 & 11)

### The Issue

On every successful connector sync, the scheduler triggers `runGlossaryPass`, which runs `reconcilePass` unconditionally:

```typescript
const reconciled = reconcilePass(db, {
  limit: opts.statsRecheckPerPass, // default 50
  ...
});
```

For each of the 50 stale terms, `reconcilePass` calls `computeTermStats`, which performs:

1. An FTS `COUNT(*)` query.
2. An FTS `SELECT` with `LIMIT 5` to fetch top sources.

In total, this executes 100 database queries, many of which contain FTS `MATCH` operations, on *every* sync success. While SQLite is fast, doing 100 FTS queries on every sync (which can happen frequently if multiple connectors sync concurrently or if debounce is short) could cause disk I/O bottlenecks on consumer hardware.

### Suggestions

1. **Verification Cooldown:** Only check terms whose `stats_verified_at` is older than a certain duration (e.g., 12 or 24 hours), rather than unconditionally checking the 50 oldest on every single pass.
2. **Lower Defaults:** Consider reducing `statsRecheckPerPass` default from `50` to `10` or `20` to reduce the instantaneous query burst per pass.

---

## 3. Propagating AbortSignals to LLM Calls (Task 9 & 11)

### The Issue

In Task 11, `consolidatePhase` checks `opts.signal?.aborted` before starting a term's consolidation. However, it does not pass the `signal` down to `consolidateTerm` or the underlying LLM call.
If `opts.consolidateTimeoutMs` is set to `30000` (30 seconds), and a local LLM call hangs, aborting the gateway/sync will not immediately cancel the active LLM request. The process will hang for up to 30 seconds before finally yielding.

### Suggestions

1. **Pass Signal Down:** Update `consolidateTerm` in Task 9 to accept an `AbortSignal` in options:

   ```typescript
   export async function consolidateTerm(
     term: GlossaryTerm,
     snippets: readonly { text: string }[],
     opts: { llm?: ConsolidatorLlm; timeoutMs: number; signal?: AbortSignal }
   )
   ```

2. **Abort underlying LLM requests:** Pass the signal to `withTimeout` and the injected `llm.generateJson` if the LLM provider interface supports aborting requests.

---

## 4. FTS Tokenization / Quoting of Hyphenated Compounds (Task 7)

### The Issue

In `glossary-store.ts`, `ftsQuery` wraps the query in double quotes:

```typescript
function ftsQuery(termKey: string): string {
  return `"${termKey.replace(/"/g, '""')}"`;
}
```

If a term key is `write-behind` (Family 4), `ftsQuery` returns `'"write-behind"'`.
Depending on how the SQLite FTS5 tokenizer is configured, a hyphen `-` inside double quotes might be treated as a token separator, transforming the query into a phrase search for `write` followed by `behind`. If the tokenizer treats the hyphen as a character or behaves differently, it might cause unexpected results.

### Recommendation

Add a test case in `glossary-store.test.ts` specifically verifying that a hyphenated term (e.g., `write-behind`) is correctly matched and returned by `computeTermStats` when it appears in source items.
