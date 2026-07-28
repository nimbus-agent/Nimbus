# Design Review: P4b Tuning Slice — Design

This document reviews [2026-07-27-p4b-ci-tuning-design.md](./2026-07-27-p4b-ci-tuning-design.md) and notes questions, suggestions, and improvements.

---

## 1. Automation for PAL-Aware Static Checks

### Preventing Regression on Platform-Specific Code

- **Observation:** The partition of the 24 coverage gates into PAL-aware (running on all 3 OSes) and Linux-only is based on a one-time static sweep of the code.
- **Question:** If a developer introduces platform-specific branching (`process.platform` or `os.platform()`) into one of the 18 Linux-only gated modules (e.g., the DB layer, Watcher, or LAN) in a future PR, how will we catch that the coverage checks on Windows/macOS are now missing for that logic?
- **Suggestion:** Add a lint or static audit rule to the preflight checks (e.g., in `scripts/structure-audit/`) that scans the 18 Linux-only coverage directories. If it detects platform branching or OS-specific imports in those directories, it should fail the preflight audit, prompting the developer to either:
  1. Refactor the code to extract platform specifics into the `platform/` PAL layer, or
  2. Promote the coverage gate to the `pal: true` matrix list in `_test-suite.yml`.

---

## 2. CI Safety: Balancing E2E Runner Efficiency and TS Failures

### Mitigating E2E Run Waste on TS Failure

- **Observation:** By removing `ci-ts` from the `needs` list of `e2e-desktop`, E2E tests can run immediately after the Rust build completes (~1.5 min). The risk of burning E2E runners on a broken TypeScript compile is accepted because the code must have passed PR gates prior to merge.
- **Question:** Direct pushes to `main` (e.g. version bumps, admin bypasses, doc updates) can still trigger workflows without PR validation. Is there a cheap way to guard against TypeScript compilation failures before burning macOS/Windows E2E resources?
- **Suggestion:** Instead of removing the TypeScript dependency entirely, make `e2e-desktop` depend on a lightweight, fast TypeScript job (such as a typecheck-only or lint-only job that takes < 1.5 minutes) in addition to `ci-rust`. This ensures code syntax/type sanity without waiting for the heavy, slow coverage shards.
- **Alternative:** Configure the workflow to automatically cancel downstream E2E runs if any parallel `ci-ts` job fails, or verify that GitHub Action's default behavior handles cancellation in this layout cleanly.

---

## 3. Baseline Warning Noise in CI Logs

### Pruning Stale Baseline Keys

- **Observation:** The design mentions that `evaluate` will report the 36 omitted coverage keys as `stale-baseline-entry` warnings, and the baseline will be regenerated after landing.
- **Suggestion:** To keep the build logs clean and avoid warning fatigue, the implementation plan should explicitly include running `computeUpdatedBaseline` as part of the tuning PR itself (Task 2 or 3 of the implementation), rather than waiting until after the PR merges to clean up the baseline warnings.
