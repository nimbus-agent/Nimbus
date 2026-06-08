# True Coverage — Sub-project B: Close Branch Gaps — Design Review

**Date:** 2026-06-08
**Target:** [2026-06-08-true-coverage-B-close-branch-gaps-design.md](./2026-06-08-true-coverage-B-close-branch-gaps-design.md)

## Open Questions & Suggestions

1. **Docker-Local Reseed Optimization & Scripting**
   * **Question:** Step 5 of the execution loop requires running the full instrumented test suite inside Docker (`oven/bun:latest`). How do we ensure fast, reproducible runs without incurring massive `bun install` times on each iteration?
   * **Suggestion:** Provide a helper script (e.g., `scripts/run-docker-tests.sh`) or standard docker run command that mounts the host's bun cache/global directories. This guarantees that team members do not hit long package installation delays inside the Docker container.

2. **Handling Defensively Unreachable Branches**
   * **Question:** For branches that represent "impossible" states (e.g., exhaustive `switch` `default: const _exhaustive: never = val; throw new Error("...")` or defensive type-casts), how should Sub-project B cover them?
   * **Suggestion:** Establish a policy. Either:
     * Force-trigger them in tests using type-casting (`as any` or `as never`) to pass bad input, or
     * Allow selective `/* istanbul ignore next */` annotations for strictly defensive lines, OR
     * Strictly defer them to Sub-project D (Exclusion-shrink via DI refactor) and accept the baseline gap for now.
     Having a clear rule prevents developers from guessing when writing tests for defensive clauses.

3. **Baseline Git Merge Conflicts & Resolution**
   * **Question:** With parallel PRs (B1, B2, B3a/b, etc.) updating `docs/structure-audit/coverage-baseline.json`, git merge conflicts are inevitable. If `git merge origin/main` triggers a conflict in the baseline, do developers have to execute the full Docker re-run to resolve it?
   * **Suggestion:** Document a standard conflict-resolution process for `coverage-baseline.json`. A utility script that can auto-merge two baseline files by selecting the stricter/lower branch watermarks would eliminate the need to re-run the 60s+ Docker test suite just to resolve a merge conflict.

4. **Verifying "Test-Only" Status of Excluded Helpers (B0)**
   * **Question:** How do we enforce that the test-support files excluded in B0 are not accidentally imported by production code in the future?
   * **Suggestion:** Add a check in `check-nimbus-invariants.ts` or the preflight gate that scans imports. If a production source file imports any file listed in `exclusions.ts` under test-support, the build/gate should fail.

5. **Windows and Cross-Platform Path Normalization in Audits**
   * **Question:** Since lcov is Linux-authoritative but step 7 (`bun run audit:coverage-floor`) runs locally (potentially on Windows), are paths normalized correctly?
   * **Suggestion:** Verify that the baseline checker handles forward/backward slash conversions (`/` vs `\`) cleanly so that `audit:coverage-floor` does not fail on Windows developer machines due to path representation differences.

## Alignment with Invariants

* **Local-First & Platform Equality:** Reseeding via Docker ensures parity with Linux-based CI while supporting local iteration on Windows/macOS.
* **Dual Line+Branch Floor:** Validating the baseline against the Linux-authoritative lcov preserves the integrity of the dual floor ratchet.
