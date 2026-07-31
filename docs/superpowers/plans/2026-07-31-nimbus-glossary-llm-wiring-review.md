# Review & Suggestions: `nimbus glossary` LLM Wiring, Snippet Upgrades, and Manual Refresh Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-07-31-nimbus-glossary-llm-wiring.md](./2026-07-31-nimbus-glossary-llm-wiring.md).

---

## 1. Budget Contradiction & Upgrade Capacity Limit (Task 5)

### The Issue

There is a logical contradiction between the specification (which says pending has priority and upgrades take leftovers) and the implementation plan (which prioritizes upgrades up to a reserve floor of 5).

Furthermore, the implementation plan's query construction caps the upgrade batch at `UPGRADE_RESERVE` (5) unconditionally:

```typescript
const upgradeBatch = opts.llm === undefined
  ? []
  : selectSnippetUpgradeBatch(db, Math.min(UPGRADE_RESERVE, opts.maxNewTermsPerPass), ...);
```

Under this query strategy, if the pending queue is completely empty (0 pending terms), the upgrade batch is still restricted to at most 5 items. This leaves 20 slots of the `maxNewTermsPerPass` (25) budget completely unused, even when there are hundreds of snippet definitions waiting to be upgraded.

### Suggestions

To solve both the starvation issue (preventing pending terms from hogging all slots forever) and the under-utilization issue (allowing upgrades to consume the full budget when pending terms are low), structure the batch selections as follows:

1. **Limit Pending Selection First:** Cap the pending batch at a maximum of `maxNewTermsPerPass - UPGRADE_RESERVE` (e.g., 20). This guarantees that at least `UPGRADE_RESERVE` (5) slots are reserved for upgrades.

   ```typescript
   const pendingLimit = opts.maxNewTermsPerPass - UPGRADE_RESERVE;
   const batch = selectPendingBatch(db, pendingLimit, ...);
   ```

2. **Dynamically Allocate Upgrade Budget:** Query upgrades with a limit of whatever budget remains:

   ```typescript
   const upgradeLimit = opts.maxNewTermsPerPass - batch.length;
   const upgradeBatch = opts.llm === undefined
     ? []
     : selectSnippetUpgradeBatch(db, upgradeLimit, ...);
   ```

This dynamic allocation guarantees that:

* If the pending queue is saturated, we process 20 pending terms and 5 upgrades (no starvation).
* If the pending queue is empty, we process 0 pending terms and up to 25 upgrades (full budget utilization).

---

## 2. CLI Progress Line Overwrite & Formatting (Task 10)

### The Issue

In Task 10, the progress indicator uses carriage return (`\r`) to overwrite the line on `stderr`:

```typescript
process.stderr.write(`  consolidating ${String(p.done)}/${String(p.total)}\r`);
```

1. **Trailing Characters:** If a subsequent progress message is shorter than the previous one, using `\r` without clearing the rest of the line will leave stale trailing characters on the terminal.
2. **Missing Newline on Completion:** When the pass finishes and `passDone` resolves, the CLI prints the outcome summary. Since the last progress write ended with `\r` (no newline), the summary output will print on the same line, resulting in garbled text (e.g., `consolidating 25/25Pass complete: 25 new, 0 upgraded.`).

### Suggestions

1. **Clear Line:** Use standard ANSI escape sequences (e.g., `\x1b[K` to clear from the cursor to the end of the line) or pad the string with spaces.
2. **Add Newline:** Write a newline (`\n`) to `process.stderr` immediately when `passDone` or `passError` is received, before resolving/rejecting the promise.

   ```typescript
   client.onNotification("glossary.passDone", (n: unknown) => {
     process.stderr.write("\n");
     resolve(n as GlossaryPassSummaryLike);
   });
   ```

---

## 3. Propagation of Abort Signals to Providers (Task 1 & Task 7)

### The Issue

In Task 7, `controller.signal` is passed to `runPass`, which is then passed to `consolidatePhase`. However, as stated in the spec, the abort signal is not propagated to the LLM providers (Ollama / Llama.cpp) because `LlmGenerateOptions` lacks a signal field.

If a local model hangs or is extremely slow (common on laptops under memory pressure), calling `stop()` or cancelling the pass will abort the *waiting* state in the gateway, but the underlying HTTP request to the Ollama server will keep executing and consuming system resources until the provider's hardcoded 120-second timeout.

### Suggestion

While widening `LlmGenerateOptions` is deferred, we should add a TODO/Warning comment in `glossary-llm-adapter.ts` acknowledging that the provider requests are un-cancellable, and explicitly document this behavior in the code so future refactoring of `LlmGenerateOptions` can easily wire this up.
