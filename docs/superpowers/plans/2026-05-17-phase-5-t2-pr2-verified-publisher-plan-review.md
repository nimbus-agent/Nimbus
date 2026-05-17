# Phase 5 T2 PR 2 — Verified Publisher — Implementation Plan Review

**Status:** Completed
**Reviewer:** Gemini CLI
**Date:** 2026-05-17
**Target Plan:** [2026-05-17-phase-5-t2-pr2-verified-publisher.md](./2026-05-17-phase-5-t2-pr2-verified-publisher.md)

## Summary

The implementation plan is comprehensive, granular (31 tasks), and strictly follows the "Research -> Strategy -> Execution" lifecycle. It successfully incorporates several feedback points from the design review, including Unicode normalization (NFC) and recursion depth limits in the canonicalization logic.

## Feedback & Observations

1. **Design Feedback Integration:**
   - **Unicode Normalization:** Task 1, Step 1 & 3 correctly implement `value.normalize("NFC")` for string values.
   - **Recursion Depth:** Task 1, Step 1 & 3 implement a `MAX_DEPTH = 32` check.
   - **Tamper Testing:** Task 18 correctly includes a behavioral test for tampered manifests.
   - **Keygen Format:** Task 12 correctly defaults to base64 for private keys.

2. **Open Questions & Suggestions:**
   - **Signature Versioning:** The plan for Task 3 (Manifest Schema) does not yet include a `signature_version` field. While not strictly required for MVP, adding `signature_version: 1` now would significantly simplify future crypto migrations.
   - **Registry Error Messaging:** Task 14 handles sync exit codes. Ensure the error message for `RegistryUnreachable` differentiates between "syncing existing publishers" and "fetching a new publisher during install" to avoid confusing the user.
   - **Task 17 (Info Human Format):** The plan uses manual padding for `nimbus extension info`. Consider if `cli-table3` (already used in other parts of the CLI) would be more maintainable, though the manual approach is fine for a small fixed-width block.

3. **Technical Integrity:**
   - The plan correctly uses `constantTimeBytesEqual` (I10 alignment).
   - The invariant enforcement (I16) is well-covered in Task 18 (grep + behavioral tests) and Task 20 (documentation).
   - The SDK re-exports in Task 24 are a good addition for connector authors.

## Conclusion

The plan is highly detailed and ready for execution. The granular TDD steps for each task ensure that regression risks are minimized. Integrating the `signature_version` field is the only recommended change before starting.
