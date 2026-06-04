# Security Scan v2 Implementation Plan Review

**Date:** 2026-06-04
**Target:** `2026-06-04-security-scan-v2.md`

## Observations & Suggestions

1. **Windows Command-Line Length Limits (`git blame` args)**
   *Observation:* In Task 6, `gitBlameLinePorcelain` constructs an array of `-L <from>,<to>` arguments for every exported symbol in a file. If a single file has many disjoint exported symbols, the argument list could become very long. On Windows, `CreateProcess` enforces a strict command-line length limit of 32,767 characters.
   *Suggestion:* Consider merging adjacent or overlapping ranges before constructing the argument list. Alternatively, if the total length of the argument list approaches the OS limit (or if there are more than, say, 100 `-L` pairs), gracefully fall back to a full-file blame (`git blame --line-porcelain -- <file>`) to avoid spawn failures.

2. **Memory Efficiency in Line Mapping**
   *Observation:* In Task 7, `absoluteLineFor` calculates the line number using `body.slice(0, offset).split("\n").length - 1;`. Since `body_preview` for `code_symbol` is just a bounded excerpt, the string array allocation overhead is negligible.
   *Suggestion:* If profiling later shows high garbage collection overhead during scans of massive workspaces, replacing this with a simple `for` loop that counts `\n` characters up to `offset` would be a completely allocation-free alternative.

3. **Fallback Handling for Existing Data**
   *Observation:* The graceful fallback in `absoluteLineFor` (`if (typeof start !== "number") return null;`) handles legacy indexed items beautifully without throwing errors, seamlessly supporting existing databases until they are re-synced.
   *Observation:* Printing a hint in the CLI (Task 9) when blame is missing helps bridge the UX gap for users wondering why their older indexed files don't have author attribution.

4. **Integration of Design Review Fixes**
   *Observation:* The plan effectively incorporates the feedback from the design review:
   - Task 2 correctly includes a context hash (`ctxHash = sha256Hex(input.contextSnippet)`) in the fingerprint to prevent collisions for identical secret lengths.
   - Task 6 correctly applies an `AbortSignal.timeout(BLAME_TIMEOUT_MS)` to prevent hanging `git blame` processes.
   - Task 9 ensures users are guided to re-sync if blame is missing.

## Conclusion

The implementation plan is extremely thorough, maps cleanly to the revised design, and mitigates the major risks appropriately. The task-by-task structure provides a safe, bottom-up path to delivery.
