# Review: True Coverage — Sub-project C: Depth (mutation + property-based testing)

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Spec:** [`2026-06-13-true-coverage-C-depth-design.md`](./2026-06-13-true-coverage-C-depth-design.md)

---

## 1. Executive Summary

The design for Sub-project C (Depth) is highly targeted, well-scoped, and directly addresses critical security risks (credential leakage via audit redaction blind spots) while introducing robust regression locking through property-based tests.

We have reviewed the specification and identified a few minor areas of improvement, regex optimization, and safety nets to ensure seamless execution.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Regex Lookahead & Charset Alignment (Section 3.2)

- **Observation:** In the proposed pattern for the GitHub PAT family:

  ```text
  (?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9])
  ```

  The body of `github_pat_` allows underscores (`_`), but the trailing negative lookahead is `(?![A-Za-z0-9])`.
- **Recommendation:** Align the trailing negative lookahead charset with the body charset of the pattern being matched. If a token body can contain `_`, the lookahead should ensure we don't match a partial token prefix before an underscore. Although greediness `{20,}` prevents premature stopping in most cases, using:
  - `(?![A-Za-z0-9_])` for `github_pat_`
  - `(?![A-Za-z0-9_-])` for `sk-`/`sk-ant-`/`xox`/`eyJ`
  provides maximum robustness and mathematical correctness.

- **Bearer Token Pattern:** The proposal to drop the fragile trailing `\b` after `={0,2}` is excellent since `=` is not a word character. However, to prevent matching a partial prefix of a longer base64-like string that ends with more than two `=` characters (or other non-boundary base64 characters), consider appending `(?![A-Za-z0-9_.\-+/])` or similar lookahead to assert a clean boundary.

---

### 2.2. Fast-Check Generator Completeness & Sync (Section 3.3)

- **Observation:** As the codebase evolves, new token formats may be added to `SENSITIVE_VALUE_PATTERNS` in `format-audit-payload.ts`.
- **Recommendation:** To prevent property-test drift (where a new pattern is added to the production scrubber but is forgotten in the property test generators):
  1. Add a structural assertion in the test file that verifies the count of `SENSITIVE_VALUE_PATTERNS` matches the number of registered fast-check generators.
  2. Or, construct a mapping of `pattern -> generator` to automatically ensure 1:1 coverage.

---

### 2.3. StrykerJS Performance & Configuration (Section 5)

- **Observation:** Using the `command` runner fallback runs the command for each mutant. Even with Bun's sub-10ms startup, running the entire test suite on hundreds of mutants can lead to noticeable execution times.
- **Recommendation:**
  1. Ensure the fallback `commandRunner.command` is tightly scoped to the target test suite (e.g., `bun test packages/gateway/src/audit/format-audit-payload.test.ts`) rather than `bun test` globally.
  2. Add `coverageAnalysis: "perTest"` (supported by the experimental bun-runner) but fall back to `coverageAnalysis: "all"` or `"off"` for the command runner to guarantee correctness.

---

### 2.4. Cross-Runtime Compatibility (Stryker under Node)

- **Observation:** StrykerJS core runs under Node.js (v20+ is present).
- **Verification:** Ensure that the regexes using advanced lookbehinds and lookaheads function identically under both Bun (JSC) and Stryker's execution environment (Node/V8).
- **Status:** Lookbehinds (`(?<!...)`) and lookaheads (`(?!...)`) are fully standard in ES2018+ and are natively supported in all target runtimes (JSC/V8). No compatibility issues are expected.

---

## 3. Conclusion & Next Steps

The design is approved for implementation with the above minor alignments. The next slice (C1) can proceed directly to the planning and implementation phase.
