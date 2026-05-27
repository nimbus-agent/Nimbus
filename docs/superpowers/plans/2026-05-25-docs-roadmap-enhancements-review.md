# Docs & Roadmap Enhancements Implementation Plan Review

**Date:** 2026-05-25

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-25-docs-roadmap-enhancements.md` implementation plan.

## Open Questions

1. **Document Link Checker Support for Hash Fragments:**
   * *Question:* In Task 1 and others, you are adding relative links with anchor hashes (e.g., `./roadmap.md#north-star-capabilities-cross-phase`). Does the `check-doc-references.ts` script correctly parse and validate hash fragments inside files, or does it only check for file existence? If it does not parse headers to validate fragments, it might falsely pass a broken deep-link.

2. **I17 "Trusted" Provenance Nuance:**
   * *Question:* Task 4 defines `trusted` provenance as "the user's direct CLI/UI input + the signed nimbus.toml / team baseline". If an engineer executes a local shell script via the CLI, is the output of that script considered `trusted`? This might warrant a small clarification in the future when I17 is formally designed to ensure local lateral movement doesn't bypass the taint barrier.

## Suggestions & Improvements

1. **Agentic Execution Care (Newlines):**
   * *Suggestion:* The plan is well-written for an agent to follow, but it relies on exact string matches (e.g., "find the line ending..."). When an agent executes this plan (e.g., using a `multi_replace_file_content` tool), it must be extremely careful to preserve the exact newline spacing mandated by `markdownlint` (MD022/MD032). Explicitly warning the executing agent about preserving `\n\n` boundaries around tables and lists might prevent linting headaches.

2. **B5 (WAL Hardening) Prioritization:**
   * *Suggestion:* Task 2 files B5 as a roadmap follow-up for WAL concurrency hardening. Given that `PRAGMA busy_timeout = 8000` is currently the only thing preventing immediate `SQLITE_BUSY` errors under contention, B5 should ideally be flagged as a high-priority/P0 maintenance initiative, rather than just another B-series bug-hunt item, to prevent frustrating user experiences under load.
